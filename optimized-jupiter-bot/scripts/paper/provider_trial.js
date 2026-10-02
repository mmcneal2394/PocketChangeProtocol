'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { randomUUID } = require('crypto');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'artifacts/paper/provider-trial');
const MONTH_CAP = 9000000;
const DAY_CAP = Math.floor(MONTH_CAP / 31);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function reserve(rows, now, cost) {
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error('invalid_credit_cost');
  if (!Array.isArray(rows) || rows.some(r => !Number.isSafeInteger(r.at) || !Number.isSafeInteger(r.cost) || r.cost <= 0 || r.at > now)) throw new Error('invalid_accounting');
  const recent = rows.filter(r => r.at > now - 31 * 86400000);
  const total = recent.reduce((s, r) => s + r.cost, 0);
  const daily = recent.filter(r => r.at > now - 86400000).reduce((s, r) => s + r.cost, 0);
  if (total + cost > MONTH_CAP || daily + cost > DAY_CAP) throw new Error('credit_budget_exhausted');
  return [...recent, { at: now, cost }];
}

function atomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function credentials() {
  const read = file => dotenv.parse(fs.readFileSync(file));
  const saved = read(process.env.PAPER_VPS_ENV || path.join(ROOT, '../pcp_live_remote_snapshot/.env'));
  const bags = read(process.env.PAPER_BAGS_ENV || path.join(ROOT, '../pcp_vps_edit/.env'));
  const gmgn = read(process.env.PAPER_GMGN_ENV || '/mnt/c/Users/admin/.config/gmgn/.env');
  const rpc = new URL(process.env.HELIUS_RPC_URL || saved.HELIUS_RPC_URL);
  if (rpc.protocol !== 'https:' || rpc.hostname !== 'mainnet.helius-rpc.com' || !rpc.searchParams.get('api-key')) throw new Error('invalid_helius_endpoint');
  const keys = { rpc: rpc.href, bags: process.env.BAGS_API_KEY || bags.BAGS_API_KEY, gmgn: process.env.GMGN_API_KEY || gmgn.GMGN_API_KEY };
  keys.rpcEndpoints = [{ name: 'helius', url: rpc.href }];
  const addRpc = (name, value) => {
    if (!value) return;
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:') throw new Error(`invalid_${name}_endpoint`);
    if (!keys.rpcEndpoints.some(row => row.url === endpoint.href)) keys.rpcEndpoints.push({ name, url: endpoint.href });
  };
  const orbitflareUrl = process.env.ORBITFLARE_RPC_URL || bags.ORBITFLARE_RPC_URL;
  const orbitflareKey = process.env.ORBITFLARE_API_KEY || bags.ORBITFLARE_API_KEY;
  if (orbitflareUrl && orbitflareKey) {
    const endpoint = new URL(orbitflareUrl);
    if (endpoint.protocol === 'http:' && endpoint.hostname.endsWith('.orbitflare.com')) endpoint.protocol = 'https:';
    if (!endpoint.searchParams.has('api_key')) endpoint.searchParams.set('api_key', orbitflareKey);
    addRpc('orbitflare', endpoint.href);
  }
  addRpc('quicknode', process.env.QUICKNODE_RPC_URL || bags.QUICKNODE_RPC_URL || saved.QUICKNODE_RPC_URL);
  addRpc('chainstack', process.env.CHAINSTACK_RPC_ENDPOINT || bags.CHAINSTACK_RPC_ENDPOINT || saved.CHAINSTACK_RPC_ENDPOINT);
  keys.bagsKeys = [...new Set([keys.bags, ...[process.env, bags, saved].flatMap(env =>
    Object.entries(env).filter(([name]) => /^BAGS_API_KEY(?:_\d+)?$/.test(name)).map(([, value]) => value))].filter(Boolean))];
  if (!keys.bags || !keys.gmgn) throw new Error('missing_api_credentials');
  keys.jupiter = process.env.JUPITER_API_KEY || saved.JUPITER_API_KEY;
  return keys;
}

function unwrapGmgn(body) {
  if (body?.code !== 0 || body?.data?.code !== 0 || !Array.isArray(body.data.data?.rank)) throw new Error('invalid_gmgn_response');
  return body.data.data.rank;
}

async function main(cycles = 3) {
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 12) throw new Error('trial_cycles_out_of_range');
  fs.mkdirSync(DIR, { recursive: true });
  const lock = path.join(DIR, 'worker.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, String(process.pid));
    const keys = credentials();
    const accounting = path.join(DIR, 'usage.json');
    let usage = fs.existsSync(accounting) ? JSON.parse(fs.readFileSync(accounting, 'utf8')) : { reservations: [], requests: {}, cooldowns: {} };
    if (!Array.isArray(usage.reservations) || !usage.requests || !usage.cooldowns) throw new Error('invalid_accounting');
    const report = { mode: 'read_only_observation_trial', signing: 'disabled', generatedAt: Date.now(), status: 'running', heliusMonthlyCap: MONTH_CAP, accountingScope: 'this worker only; rolling 31 days; provider total and billing reset unknown', providers: {}, candidates: [] };
    async function request(provider, url, options, validate) {
      const now = Date.now();
      if ((usage.cooldowns[provider] || 0) > now) return { status: 'cooldown', checkedAt: now };
      if (provider === 'helius') usage.reservations = reserve(usage.reservations, now, 1);
      usage.requests[provider] = (usage.requests[provider] || 0) + 1;
      // Persist the attempt before network I/O, including attempts that fail.
      atomic(accounting, usage);
      try {
        const response = await fetch(url, { ...options, timeout: 10000, redirect: 'error', agent: new https.Agent({ family: 4 }) });
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const delay = Number(retry);
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          usage.cooldowns[provider] = Math.max(now + 300000, Number.isFinite(delay) ? now + delay * 1000 : Date.parse(retry) || 0, Number.isFinite(reset) ? reset : 0);
          atomic(accounting, usage);
        }
        if (!response.ok) return { status: 'http_error', httpStatus: response.status, checkedAt: now };
        const data = validate(await response.json());
        return { status: 'ok', checkedAt: now, latencyMs: Date.now() - now, rateRemaining: response.headers.get('x-ratelimit-remaining'), data };
      } catch { return { status: 'request_or_schema_failed', checkedAt: now }; }
    }
    for (let i = 0; i < cycles; i++) {
      const rank = new URL('https://openapi.gmgn.ai/v1/market/rank');
      for (const [k, v] of Object.entries({ chain: 'sol', interval: '1m', limit: '20', timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() })) rank.searchParams.set(k, v);
      const gmgn = await request('gmgn', rank.href, { headers: { 'X-APIKEY': keys.gmgn } }, unwrapGmgn);
      const bags = await request('bags', 'https://public-api-v2.bags.fm/api/v1/token-launch/feed', { headers: { 'x-api-key': keys.bags } }, body => {
        if (body?.success !== true || !Array.isArray(body.response)) throw new Error('invalid_bags_response');
        return body.response;
      });
      const helius = await request('helius', keys.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }) }, body => {
        if (body.error || !Number.isSafeInteger(body.result)) throw new Error('invalid_slot');
        return body.result;
      });
      report.candidates = [
        ...(gmgn.data || []).map(r => ({ mint: r.address, symbol: r.symbol, source: 'gmgn' })),
        ...(bags.data || []).map(r => ({ mint: r.tokenMint, symbol: r.symbol, pool: r.dbcPoolKey, source: 'bags', launchStatus: r.status })),
      ].filter(r => typeof r.mint === 'string').map(r => ({ ...r, decision: 'watch_only', reason: 'independent_mark_and_mint_checks_pending' }));
      for (const [provider, result] of Object.entries({ gmgn, bags, helius })) {
        const { data, ...health } = result;
        report.providers[provider] = { ...health, records: Array.isArray(data) ? data.length : undefined, confirmedSlot: provider === 'helius' ? data : undefined };
      }
      report.generatedAt = Date.now();
      report.completedCycles = i + 1;
      report.requests = usage.requests;
      report.heliusEstimatedCredits = usage.reservations.reduce((s, r) => s + r.cost, 0);
      atomic(path.join(DIR, 'latest.json'), report);
      fs.appendFileSync(path.join(DIR, 'observations.jsonl'), JSON.stringify(report) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ cycle: i + 1, providers: report.providers, candidates: report.candidates.length, heliusEstimatedCredits: report.heliusEstimatedCredits }));
      if (i + 1 < cycles) await sleep(5000);
    }
    report.status = 'completed';
    atomic(path.join(DIR, 'latest.json'), report);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { reserve, unwrapGmgn, MONTH_CAP, DAY_CAP, credentials, atomic };
if (require.main === module) main(Number(process.argv[2] || 3)).catch(() => { console.error('Provider trial stopped; check credentials, lock, or accounting. No secret details logged.'); process.exitCode = 1; });
