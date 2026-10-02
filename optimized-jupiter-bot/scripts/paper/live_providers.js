'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { randomUUID, createHash } = require('crypto');
const fetch = require('node-fetch');
const { credentials, atomic, MONTH_CAP, DAY_CAP } = require('./provider_trial');
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const READ_ONLY_RPC_METHODS = new Set(['getSlot', 'getMultipleAccounts', 'getTokenSupply', 'getTokenLargestAccounts']);
// These are aggregate host limits. Multiple local paper services share the
// lease below so independently safe workers cannot burst the same provider.
// GMGN documents 2 RPS, but this key/IP enforces an observed ~60-request
// rolling minute. Keep one host-wide slot every 1.1 seconds to avoid bans.
const GMGN_REQUEST_GAP_MS = 1100;
const HELIUS_REQUEST_GAP_MS = 125;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Network failures worth one bounded retry; a plain thrown Error is not retried
// so callers that simulate failures with plain errors stay deterministic.
function isTransientNetworkError(error) {
  const code = error?.code || error?.cause?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
    || ['AbortError', 'FetchError'].includes(error?.name) || ['system', 'request-timeout'].includes(error?.type);
}

function sanitizeError(body, secrets = []) {
  const clean = value => {
    let s = String(value).slice(0, 2000);
    for (const key of secrets.filter(Boolean)) s = s.split(key).join('[redacted]');
    return s.replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_-]{64,}/g, '[redacted]').slice(0, 500);
  };
  const out = {};
  for (const k of ['error', 'errorCode', 'code', 'message', 'response']) {
    if (['string', 'number'].includes(typeof body?.[k])) out[k] = clean(body[k]);
    else if (body?.[k] && typeof body[k] === 'object') {
      out[k] = Object.fromEntries(Object.entries(body[k]).filter(([name, value]) => ['code', 'message', 'error', 'errorCode'].includes(name) && ['string', 'number'].includes(typeof value)).map(([name, value]) => [name, clean(value)]));
    }
  }
  return out;
}

function validateMint(account) {
  const p = account?.data?.parsed;
  if (![TOKEN, TOKEN_2022].includes(account?.owner) || p?.type !== 'mint') throw new Error('unsupported_or_missing_mint');
  const info = p.info;
  if ((info?.extensions || []).some(e => !['metadataPointer', 'tokenMetadata'].includes(e.extension))) throw new Error('unsupported_token_extension');
  if (info?.isInitialized !== true || info.mintAuthority !== null || info.freezeAuthority !== null) throw new Error('mint_controls_not_renounced');
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 12) throw new Error('unsupported_decimals');
  return info.decimals;
}

function validateQuote(q, input, output, amount) {
  if (!q || q.inputMint !== input || q.outputMint !== output || String(q.inAmount) !== String(amount) ||
      !/^\d+$/.test(String(q.outAmount)) || BigInt(q.outAmount) <= 0n ||
      !Number.isSafeInteger(q.contextSlot) || q.contextSlot <= 0 || !Array.isArray(q.routePlan) || !q.routePlan.length) throw new Error('invalid_quote');
  // Restrict the initial paper adapter to direct routes so pool identity is unambiguous.
  if (q.routePlan.length !== 1 || q.routePlan[0].inputMint !== input || q.routePlan[0].outputMint !== output || !q.routePlan[0].marketKey) throw new Error('unsupported_multihop_route');
  return q;
}

class Providers {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.file = options.usageFile || path.join(dir, 'provider-usage.json');
    this.keys = options.keys || credentials();
    this.rpcEndpoints = this.keys.rpcEndpoints || (this.keys.rpc ? [{ name: 'helius', url: this.keys.rpc }] : []);
    this.fetch = options.fetch || fetch;
    this.nextAttemptAt = new Map();
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { buckets: [], providers: {}, scope: 'worker-only rolling 31 days; account usage unknown' };
    if (!Array.isArray(this.state.buckets) || !this.state.providers) throw new Error('invalid_usage_ledger');
    for (const endpoint of this.rpcEndpoints) {
      this.state.providers[endpoint.name] ||= { requests: 0, successes: 0, errors: 0, latencyTotalMs: 0, lastAttempt: 0, cooldownUntil: 0, role: 'read_only_rpc' };
    }
    this.agent = new https.Agent({ family: 4, keepAlive: true });
  }
  async reserveSharedProviderSlot(provider, gap) {
    const leaseFile = path.join(this.dir, `.${provider}-rate-lease.json`);
    const lockFile = path.join(this.dir, `.${provider}-rate-lease.lock`);
    const startedAt = Date.now();
    let fd, waitMs = 5, lastRecoveryCheck = 0;
    while (fd === undefined) {
      try { fd = fs.openSync(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Recover an abandoned lock, but check its mtime at most every 250ms so
        // contended callers do not stat the file on every spin.
        if (Date.now() - lastRecoveryCheck > 250) {
          lastRecoveryCheck = Date.now();
          try {
            if (Date.now() - fs.statSync(lockFile).mtimeMs > 10000) fs.unlinkSync(lockFile);
          } catch { /* Another process released or recovered the lock. */ }
        }
        if (Date.now() - startedAt > 10000) throw new Error(`${provider}_rate_lock_timeout`);
        await sleep(waitMs);
        waitMs = Math.min(waitMs * 2, 100);
      }
    }
    let scheduledAt;
    try {
      let previous = 0;
      try {
        const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
        if (Number.isSafeInteger(lease.scheduledAt) && lease.scheduledAt <= Date.now() + 60000) previous = lease.scheduledAt;
      } catch { /* Missing or invalid leases restart conservatively from now. */ }
      scheduledAt = Math.max(Date.now(), previous + gap);
      atomic(leaseFile, { provider, scheduledAt });
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lockFile); } catch { /* Lock already recovered. */ }
    }
    await sleep(Math.max(0, scheduledAt - Date.now()));
  }
  reserve(provider, method, now) {
    if (this.state.buckets.some(b => !Number.isFinite(b.hour) || b.hour > now || !Number.isSafeInteger(b.credits) || b.credits < 0)) throw new Error('invalid_usage_ledger');
    // Keep the oldest overlapping hour; overcounting is preferable to early expiry.
    this.state.buckets = this.state.buckets.filter(b => b.hour + 3600000 > now - 31 * 86400000);
    if (provider === 'helius') {
      if (!READ_ONLY_RPC_METHODS.has(method)) throw new Error('rpc_method_not_allowed');
      const total = this.state.buckets.reduce((s, b) => s + b.credits, 0);
      const daily = this.state.buckets.filter(b => b.hour + 3600000 > now - 86400000).reduce((s, b) => s + b.credits, 0);
      if (total + 1 > MONTH_CAP || daily + 1 > DAY_CAP) throw new Error('helius_budget_exhausted');
      const hour = Math.floor(now / 3600000) * 3600000;
      let bucket = this.state.buckets.find(b => b.hour === hour);
      if (!bucket) this.state.buckets.push(bucket = { hour, credits: 0 });
      bucket.credits++;
    }
    const p = this.state.providers[provider] ||= { requests: 0, successes: 0, errors: 0, latencyTotalMs: 0, lastAttempt: 0, cooldownUntil: 0 };
    p.requests++; p.lastAttempt = now;
    // The usage ledger is flushed once per request by call()'s finally block.
    // Persisting here as well doubled every request into two full-ledger fsyncs.
  }
  async call(provider, method, params = {}, bagsKey = null) {
    if (provider === 'bags' && !bagsKey) {
      const keys = [...new Set(this.keys.bagsKeys || [this.keys.bags])].filter(Boolean);
      const states = this.state.bagsKeys ||= {};
      const id = key => createHash('sha256').update(key).digest('hex').slice(0, 16);
      if (!Object.keys(states).length && keys.length) states[id(keys[0])] = { cooldownUntil: this.state.providers.bags?.cooldownUntil || 0 };
      let lastError = new Error('bags_cooldown');
      for (const key of keys) {
        const record = states[id(key)] ||= { cooldownUntil: 0 };
        if (record.cooldownUntil > Date.now()) continue;
        try {
          const result = await this.call(provider, method, params, key);
          record.cooldownUntil = 0;
          record.lastSuccess = Date.now();
          this.state.providers.bags.cooldownUntil = 0;
          atomic(this.file, this.state);
          return result;
        } catch (error) {
          lastError = error;
          if (!/^bags_http_(429|401|403)$/.test(error.message)) throw error;
          record.cooldownUntil = this.state.providers.bags.cooldownUntil;
          record.lastError = error.message;
          atomic(this.file, this.state);
        }
      }
      if (this.state.providers.bags) this.state.providers.bags.cooldownUntil = Math.min(...keys.map(key => states[id(key)].cooldownUntil));
      atomic(this.file, this.state);
      throw lastError;
    }
    const rpcEndpoint = this.rpcEndpoints.find(endpoint => endpoint.name === provider);
    if (rpcEndpoint && !READ_ONLY_RPC_METHODS.has(method)) throw new Error('rpc_method_not_allowed');
    const gap = provider === 'helius' ? HELIUS_REQUEST_GAP_MS : rpcEndpoint ? 350 : provider === 'jupiter' ? 2100 : provider === 'gmgn' ? GMGN_REQUEST_GAP_MS : 1100;
    // Every attempt re-checks the cooldown and re-queues for a rate slot, so a
    // bounded retry can never exceed the provider budget or break the host gap.
    const acquire = async () => {
      const previous = this.state.providers[provider];
      if (!bagsKey && previous?.cooldownUntil > Date.now()) throw new Error(`${provider}_cooldown`);
      if (provider === 'gmgn' || provider === 'helius') await this.reserveSharedProviderSlot(provider, gap);
      else {
        const scheduledAt = Math.max(Date.now(), (previous?.lastAttempt || 0) + gap, this.nextAttemptAt.get(provider) || 0);
        this.nextAttemptAt.set(provider, scheduledAt + gap);
        await sleep(Math.max(0, scheduledAt - Date.now()));
      }
      const now = Date.now();
      this.reserve(provider, method, now);
      return now;
    };
    let url, options;
    if (rpcEndpoint) {
      url = rpcEndpoint.url;
      options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) };
    } else if (provider === 'bags' && ['/token-launch/feed', '/trade/quote'].includes(method)) {
      url = new URL(`https://public-api-v2.bags.fm/api/v1${method}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      options = { headers: { 'x-api-key': bagsKey } };
    } else if (provider === 'jupiter' && method === '/swap/v1/quote') {
      url = new URL('https://api.jup.ag/swap/v1/quote');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      options = { headers: this.keys.jupiter ? { 'x-api-key': this.keys.jupiter } : {} };
    } else if (provider === 'gmgn' && ['/v1/market/rank', '/v1/market/token_kline', '/v1/token/info', '/v1/token/security', '/v1/token/pool_info'].includes(method)) {
      url = new URL(`https://openapi.gmgn.ai${method}`);
      for (const [k, v] of Object.entries({ ...params, timestamp: Math.floor(Date.now() / 1000), client_id: randomUUID() })) url.searchParams.set(k, String(v));
      options = { headers: { 'X-APIKEY': this.keys.gmgn } };
    } else throw new Error('endpoint_not_allowed');
    // The provider record is created by reserve() during acquire(), so it is
    // captured per attempt rather than before the slot is claimed.
    let p, attemptNow;
    try {
      for (let attempt = 0; ; attempt++) {
        attemptNow = await acquire();
        p = this.state.providers[provider];
        try {
          const r = await this.fetch(String(url), { ...options, agent: this.agent, redirect: 'error', timeout: 8000, size: 4000000 });
          p.rateRemaining = r.headers.get('x-ratelimit-remaining');
          if (r.status === 429) {
            const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
            const retry = r.headers.get('retry-after');
            const retryAt = Number.isFinite(Number(retry)) ? attemptNow + Number(retry) * 1000 : Date.parse(retry) || 0;
            const hinted = Math.max(retryAt, Number.isFinite(reset) ? reset : 0);
            // Trust the provider's own retry signal and reserve the 5-minute floor only
            // when it gives no usable guidance, so a transient 429 recovers in seconds.
            p.cooldownUntil = hinted > attemptNow ? hinted : attemptNow + 300000;
          }
          if (!r.ok) {
            let body = {}; try { body = await r.json(); } catch {}
            p.lastDiagnostic = { at: Date.now(), status: r.status, method,
              request: Object.fromEntries(['inputMint', 'outputMint', 'amount'].filter(k => params[k] !== undefined).map(k => [k, String(params[k])])),
              body: sanitizeError(body, [...this.rpcEndpoints.map(endpoint => endpoint.url), this.keys.gmgn, this.keys.jupiter, ...(this.keys.bagsKeys || [this.keys.bags])]) };
            // One retry absorbs a transient 5xx without touching the 429/401/403
            // cooldowns, which keep failing fast for the rest of their window.
            if (r.status >= 500 && attempt < 1) { await sleep(250); continue; }
            throw new Error(`http_${r.status}`);
          }
          const j = await r.json();
          let result;
          if (rpcEndpoint) {
            if (j.error || j.result === undefined) throw new Error('rpc_error');
            result = j.result;
          } else if (provider === 'jupiter') {
            result = j;
          } else if (provider === 'bags') {
            if (j.success !== true || j.response === undefined) throw new Error('bags_response_error');
            result = j.response;
          } else {
            if (j.code !== 0) throw new Error('gmgn_response_error');
            if (method === '/v1/market/rank') {
              if (j.data?.code !== 0) throw new Error('gmgn_response_error');
              result = j.data.data?.rank;
            } else if (method === '/v1/market/token_kline') {
              if (j.data?.code !== undefined && j.data.code !== 0) throw new Error('gmgn_response_error');
              result = j.data?.list ?? j.data?.data?.list;
            } else {
              if (j.data?.code !== undefined && j.data.code !== 0) throw new Error('gmgn_response_error');
              result = j.data?.code === 0 ? j.data.data : j.data;
            }
            if (method.startsWith('/v1/market/') ? !Array.isArray(result) : !result || typeof result !== 'object' || Array.isArray(result)) throw new Error('gmgn_response_error');
          }
          p.successes++; p.lastSuccess = Date.now(); p.status = 'ok';
          return result;
        } catch (e) {
          // A dropped connection is retried once; a response-level error is not.
          if (attempt < 1 && isTransientNetworkError(e)) { await sleep(250); continue; }
          p.errors++; p.status = 'error';
          // Never persist provider bodies, URLs or raw fetch exception messages.
          const message = /^http_\d+$|^(rpc|bags_response|gmgn_response)_error$/.test(e.message) ? e.message : 'request_failed';
          p.lastError = message;
          if (message === 'http_401' || message === 'http_403') p.cooldownUntil = attemptNow + 3600000;
          throw new Error(`${provider}_${message}`);
        }
      }
    } finally {
      // acquire() can reject before a slot is claimed (for example on cooldown);
      // only fold latency and flush usage once a real request attempt was made.
      if (Number.isFinite(attemptNow)) {
        p.latencyTotalMs += Date.now() - attemptNow;
        p.averageLatencyMs = Math.round(p.latencyTotalMs / p.requests);
        atomic(this.file, this.state);
      }
    }
  }
  rpcProviderNames() {
    return this.rpcEndpoints.map(endpoint => endpoint.name);
  }
  async rpcWithProvider(method, params, validate = value => value) {
    if (!this.rpcEndpoints.length) throw new Error('missing_rpc_endpoint');
    let lastError = new Error('rpc_unavailable');
    for (const provider of this.rpcProviderNames()) {
      try { return { result: validate(await this.call(provider, method, params)), provider }; }
      catch (error) { lastError = error; }
    }
    throw lastError;
  }
  async rpc(method, params, validate) {
    return (await this.rpcWithProvider(method, params, validate)).result;
  }
  async accounts(addresses) {
    const validate = r => {
      if (!Number.isSafeInteger(r?.context?.slot) || !Array.isArray(r.value) || r.value.length !== addresses.length) throw new Error('invalid_accounts');
      return r;
    };
    const { result, provider } = await this.rpcWithProvider('getMultipleAccounts', [addresses, { encoding: 'jsonParsed', commitment: 'confirmed' }], validate);
    return { ...result, rpcProvider: provider };
  }
  async tokenSupply(address) {
    const validate = r => {
      const value = r?.value;
      if (!Number.isSafeInteger(r?.context?.slot) || !/^\d+$/.test(String(value?.amount)) ||
          !Number.isInteger(value?.decimals) || value.decimals < 0 || value.decimals > 12) throw new Error('invalid_token_supply');
      return r;
    };
    const { result, provider } = await this.rpcWithProvider('getTokenSupply', [address, { commitment: 'confirmed' }], validate);
    return { ...result, rpcProvider: provider };
  }
  async largestTokenAccounts(address) {
    const validate = r => {
      if (!Number.isSafeInteger(r?.context?.slot) || !Array.isArray(r?.value) || r.value.some(row =>
        typeof row?.address !== 'string' || !/^\d+$/.test(String(row?.amount)) || !Number.isInteger(row?.decimals))) {
        throw new Error('invalid_largest_token_accounts');
      }
      return r;
    };
    const { result, provider } = await this.rpcWithProvider('getTokenLargestAccounts', [address, { commitment: 'confirmed' }], validate);
    return { ...result, rpcProvider: provider };
  }
  async quote(input, output, amount) {
    // Bags is the preferred entry venue, but a Bags cooldown must not zero entry
    // throughput while an equivalent direct Jupiter route is available.
    try {
      const q = await this.call('bags', '/trade/quote', { inputMint: input, outputMint: output, amount: String(amount), slippageMode: 'manual', slippageBps: 50 });
      return validateQuote(q, input, output, amount);
    } catch (error) {
      if (!/_cooldown$|^bags_http_(429|401|403)$/.test(error.message)) throw error;
      const fallback = await this.jupiterQuote(input, output, amount);
      Object.defineProperty(fallback, 'quoteSource', { value: 'jupiter', enumerable: false });
      return fallback;
    }
  }
  async jupiterQuote(input, output, amount) {
    const q = await this.call('jupiter', '/swap/v1/quote', { inputMint: input, outputMint: output, amount: String(amount), swapMode: 'ExactIn', slippageBps: 50, onlyDirectRoutes: true });
    if (q.swapMode !== 'ExactIn' || q.routePlan?.length !== 1 || q.routePlan[0].percent !== 100) throw new Error('unsupported_jupiter_route');
    return validateQuote({ ...q, routePlan: q.routePlan.map(r => ({ inputMint: r.swapInfo?.inputMint, outputMint: r.swapInfo?.outputMint, marketKey: r.swapInfo?.ammKey })) }, input, output, amount);
  }
  usage() {
    return { ...this.state, monthlyCap: MONTH_CAP, dailyCap: DAY_CAP, estimatedCredits: this.state.buckets.reduce((s, b) => s + b.credits, 0), accountCredits: null, billingReset: null };
  }
}
module.exports = { Providers, SOL, TOKEN, GMGN_REQUEST_GAP_MS, HELIUS_REQUEST_GAP_MS, validateMint, validateQuote, sanitizeError };
