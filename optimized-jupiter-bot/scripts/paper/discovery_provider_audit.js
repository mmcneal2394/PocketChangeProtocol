'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'artifacts/paper/discovery-provider-audit.json');
const NORMALIZED_OUTPUT = path.join(ROOT, 'artifacts/paper/discovery-normalized-sample.json');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_MINTS = new Set([SOL_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);

function readEnv(file) {
  try { return dotenv.parse(fs.readFileSync(file)); } catch { return {}; }
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function first(...values) {
  return values.map(value => String(value || '').trim()).find(Boolean) || '';
}

function number(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function records(payload) {
  for (const candidate of [payload, payload?.data, payload?.data?.data, payload?.tokens, payload?.pools, payload?.pairs, payload?.response, payload?.results]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeProviderCandidate(provider, row) {
  const attrs = row?.attributes || {};
  const token = row?.token || row?.baseToken || {};
  const pool = Array.isArray(row?.pools) ? row.pools[0] || {} : {};
  const poolToken = Array.isArray(row?.tokens) ? row.tokens.find(item => !QUOTE_MINTS.has(String(item?.id || item?.address || ''))) || {} : {};
  const txns = row?.txns || pool?.txns || attrs?.transactions || {};
  const volume = row?.volume || attrs?.volume_usd || {};
  return {
    source: provider,
    mint: first(row?.tokenAddress, row?.tokenMint, row?.mint, provider === 'jupiter' ? row?.id : '', token?.mint, token?.address, poolToken?.id, poolToken?.address),
    symbol: first(row?.symbol, token?.symbol, attrs?.symbol),
    name: first(row?.name, token?.name, attrs?.name),
    poolAddress: first(row?.pairAddress, row?.poolAddress, provider === 'dexpaprika' || provider === 'gecko_terminal' ? row?.id : '', attrs?.address),
    liquidityUsd: number(row?.liquidityUsd, row?.liquidity_usd, row?.liquidity, row?.liquidity?.usd, pool?.liquidity?.usd, attrs?.reserve_in_usd),
    volume5mUsd: number(row?.volume5mUsd, volume?.m5, row?.volume_usd_5m),
    volume1hUsd: number(row?.volume1hUsd, volume?.h1, row?.volume_1h, row?.volume),
    buys5m: number(row?.buys5m, txns?.m5?.buys),
    sells5m: number(row?.sells5m, txns?.m5?.sells),
    marketCapUsd: number(row?.marketCap, row?.marketCapUsd, row?.market_cap, row?.fdv, attrs?.market_cap_usd, attrs?.fdv_usd),
    observedAt: new Date().toISOString(),
  };
}

function geckoRows(payload) {
  const included = new Map((payload?.included || []).map(item => [item.id, item?.attributes || {}]));
  return (payload?.data || []).map(row => {
    const base = included.get(row?.relationships?.base_token?.data?.id) || {};
    return { ...row, tokenAddress: base.address, symbol: base.symbol, name: base.name };
  });
}

function loadCredentials() {
  const legacy = readEnv(path.join(ROOT, '../pcp_live_work/.env'));
  const snapshot = readEnv(path.join(ROOT, '../pcp_live_remote_snapshot/.env'));
  const v2 = readEnv(path.join(ROOT, '../pcp_vps_edit/.env'));
  const gmgn = readEnv('/mnt/c/Users/admin/.config/gmgn/.env');
  return {
    bags: first(process.env.BAGS_API_KEY, v2.BAGS_API_KEY, legacy.BAGS_API_KEY),
    gmgn: first(process.env.GMGN_API_KEY, gmgn.GMGN_API_KEY, legacy.GMGN_API_KEY),
    heliusRpc: first(process.env.HELIUS_RPC_URL, legacy.HELIUS_RPC_URL, snapshot.HELIUS_RPC_URL),
    jupiter: first(process.env.JUPITER_API_KEY, legacy.JUPITER_API_KEY),
    solanaTracker: first(process.env.SOLANATRACKER_API_KEY, v2.SOLANATRACKER_API_KEY),
    orbitflareKey: first(process.env.ORBITFLARE_API_KEY, v2.ORBITFLARE_API_KEY),
    orbitflareRpc: first(process.env.ORBITFLARE_RPC_URL, v2.ORBITFLARE_RPC_URL),
    quicknodeRpc: first(process.env.QUICKNODE_RPC_URL, legacy.QUICKNODE_RPC_URL),
    chainstackRpc: first(process.env.CHAINSTACK_RPC_ENDPOINT, legacy.CHAINSTACK_RPC_ENDPOINT),
    vybe: first(process.env.VYBE_API_KEY, v2.VYBE_API_KEY, legacy.VYBE_API_KEY),
    birdeye: first(process.env.BIRDEYE_API_KEY, v2.BIRDEYE_API_KEY, legacy.BIRDEYE_API_KEY),
    mobula: first(process.env.MOBULA_API_KEY, v2.MOBULA_API_KEY, legacy.MOBULA_API_KEY),
    coinapi: first(process.env.COINAPI_KEY, legacy.COINAPI_KEY, snapshot.COINAPI_KEY),
  };
}

async function probe({ name, role, url, options = {}, credentialPresent = false, parse = records, historical = null }) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, timeout: 10_000, redirect: 'error' });
    let payload = null;
    try { payload = await response.json(); } catch {}
    const rows = parse(payload);
    return {
      provider: name,
      role,
      credentialPresent,
      status: response.ok ? 'active' : response.status === 401 || response.status === 403 ? 'credential_rejected' : response.status === 429 ? 'rate_limited' : 'http_error',
      httpStatus: response.status,
      latencyMs: Date.now() - started,
      records: Array.isArray(rows) ? rows.length : null,
      quota: {
        limit: response.headers.get('x-ratelimit-limit'),
        remaining: response.headers.get('x-ratelimit-remaining'),
        reset: response.headers.get('x-ratelimit-reset'),
        retryAfter: response.headers.get('retry-after'),
      },
      historical,
      checkedAt: new Date().toISOString(),
      sample: Array.isArray(rows) ? rows.slice(0, 3).map(row => normalizeProviderCandidate(name, row)) : [],
    };
  } catch (error) {
    return {
      provider: name,
      role,
      credentialPresent,
      status: 'unreachable',
      latencyMs: Date.now() - started,
      records: null,
      quota: {},
      historical,
      checkedAt: new Date().toISOString(),
      error: String(error?.type || error?.code || error?.message || 'request_failed').slice(0, 120),
      sample: [],
    };
  }
}

function rpcProbe(name, role, url, credentialPresent, historical) {
  return probe({
    name,
    role,
    url,
    credentialPresent,
    historical,
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'pcp-read-only-audit', method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
    },
    parse: payload => Number.isSafeInteger(payload?.result) ? [{ confirmedSlot: payload.result }] : [],
  });
}

function historicalUsage() {
  const current = readJson(path.join(ROOT, 'artifacts/paper/provider-usage.json'));
  const old = readJson(path.join(ROOT, '../pcp_vps_edit/signals/v2_provider_budget.json'));
  const result = {};
  for (const [provider, row] of Object.entries(current.providers || {})) {
    result[provider] = { scope: current.scope || 'current worker', requests: row.requests || 0, successes: row.successes || 0, errors: row.errors || 0, averageLatencyMs: row.averageLatencyMs ?? null, lastSuccess: row.lastSuccess || null };
  }
  for (const [provider, row] of Object.entries(old.providers || {})) {
    result[provider] = { ...(result[provider] || {}), archivedV2: { callsTodayAtShutdown: row.callsToday || 0, callsThisMonthAtShutdown: row.callsThisMonth || 0, failuresAtShutdown: row.failures || 0, lastCallAt: row.lastCallAt || null, lastError: row.lastError || null } };
  }
  return result;
}

async function main() {
  const credentials = loadCredentials();
  const history = historicalUsage();
  const get = (name, role, url, headers = {}, credentialPresent = false, parse = records) => probe({ name, role, url, options: { headers: { accept: 'application/json', ...headers } }, credentialPresent, parse, historical: history[name] || null });
  const checks = [
    get('dexscreener', 'discovery_and_market_data', 'https://api.dexscreener.com/token-profiles/latest/v1', {}, false, payload => records(payload).filter(row => row?.chainId === 'solana')),
    get('dexpaprika', 'discovery_and_market_data', 'https://api.dexpaprika.com/networks/solana/pools/search?limit=10&order_by=volume_usd_24h&sort=desc'),
    get('gecko_terminal', 'discovery_and_market_data', 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,quote_token', {}, false, geckoRows),
    get('pump_fun', 'launch_discovery', 'https://frontend-api.pump.fun/coins?offset=0&limit=10&sort=last_trade_timestamp&order=DESC&includeNsfw=false', { 'user-agent': 'PocketChangeProtocol/1.0' }),
    get('rugcheck', 'safety', `https://api.rugcheck.xyz/v1/tokens/${SOL_MINT}/report/summary`),
    get('goplus', 'safety', `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${SOL_MINT}`),
    get('solanatracker', 'discovery_market_and_safety', 'https://data.solanatracker.io/tokens/trending/5m', credentials.solanaTracker ? { 'x-api-key': credentials.solanaTracker } : {}, Boolean(credentials.solanaTracker)),
    get('gmgn', 'discovery_and_flow', `https://openapi.gmgn.ai/v1/market/rank?chain=sol&interval=1h&limit=10&order_by=volume&direction=desc&min_liquidity=7000&timestamp=${Math.floor(Date.now() / 1000)}&client_id=${randomUUID()}`, credentials.gmgn ? { 'X-APIKEY': credentials.gmgn } : {}, Boolean(credentials.gmgn), payload => payload?.data?.data?.rank || []),
    get('bags', 'launch_discovery_and_quotes', 'https://public-api-v2.bags.fm/api/v1/token-launch/feed', credentials.bags ? { 'x-api-key': credentials.bags } : {}, Boolean(credentials.bags), payload => records(payload?.response)),
    get('jupiter', 'token_search_and_routes', 'https://lite-api.jup.ag/tokens/v2/search?query=SOL', credentials.jupiter ? { 'x-api-key': credentials.jupiter } : {}, Boolean(credentials.jupiter)),
  ];
  if (credentials.coinapi) checks.push(get('coinapi', 'reference_price_enrichment', 'https://rest.coinapi.io/v1/exchangerate/SOL/USD', { 'X-CoinAPI-Key': credentials.coinapi }, true, payload => payload?.rate ? [payload] : []));
  if (credentials.heliusRpc) checks.push(rpcProbe('helius', 'rpc_event_and_asset_enrichment', credentials.heliusRpc, true, history.helius || null));
  if (credentials.orbitflareRpc && credentials.orbitflareKey) {
    const endpoint = new URL(credentials.orbitflareRpc);
    if (endpoint.protocol === 'http:' && endpoint.hostname.endsWith('.orbitflare.com')) endpoint.protocol = 'https:';
    if (endpoint.protocol === 'https:') {
      endpoint.searchParams.set('api_key', credentials.orbitflareKey);
      checks.push(rpcProbe('orbitflare', 'readonly_rpc_safety', endpoint.href, true, history.orbitflare || null));
    }
  }
  if (credentials.quicknodeRpc) checks.push(rpcProbe('quicknode', 'backup_rpc', credentials.quicknodeRpc, true, history.quicknode || null));
  if (credentials.chainstackRpc) checks.push(rpcProbe('chainstack', 'backup_rpc', credentials.chainstackRpc, true, history.chainstack || null));

  const providers = await Promise.all(checks);
  for (const [name, present, role] of [
    ['vybe', Boolean(credentials.vybe), 'optional_enrichment'],
    ['birdeye', Boolean(credentials.birdeye), 'optional_enrichment'],
    ['mobula', Boolean(credentials.mobula), 'optional_enrichment'],
    ['quicknode', Boolean(credentials.quicknodeRpc), 'backup_rpc'],
    ['chainstack', Boolean(credentials.chainstackRpc), 'backup_rpc'],
  ]) {
    if (!providers.some(row => row.provider === name)) providers.push({ provider: name, role, credentialPresent: present, status: present ? 'stored_not_probed' : 'credential_missing', historical: history[name] || null, checkedAt: new Date().toISOString(), sample: [] });
  }
  const samples = providers.flatMap(row => row.sample || []).filter(row => row.mint || row.poolAddress).slice(0, 100);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'read_only_provider_audit',
    executionEnabled: false,
    admissionEnabled: false,
    normalizationContract: ['source', 'mint', 'symbol', 'name', 'poolAddress', 'liquidityUsd', 'volume5mUsd', 'volume1hUsd', 'buys5m', 'sells5m', 'marketCapUsd', 'observedAt'],
    accountingLimitations: ['Current counts cover only this local worker.', 'Archived V2 counts are point-in-time counters from its final saved day/month, not provider billing totals.', 'Public APIs generally do not expose account usage headers.'],
    summary: {
      checked: providers.length,
      active: providers.filter(row => row.status === 'active').length,
      degraded: providers.filter(row => !['active', 'credential_missing', 'stored_not_probed'].includes(row.status)).length,
      normalizedSamples: samples.length,
    },
    providers: providers.map(({ sample, ...row }) => row),
  };
  atomicWrite(OUTPUT, report);
  atomicWrite(NORMALIZED_OUTPUT, { generatedAt: report.generatedAt, schema: report.normalizationContract, records: samples });
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { normalizeProviderCandidate, records, historicalUsage, loadCredentials };
if (require.main === module) main().catch(error => { console.error(String(error?.message || error)); process.exitCode = 1; });
