const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Providers, TOKEN, GMGN_REQUEST_GAP_MS, HELIUS_REQUEST_GAP_MS, GECKO_REQUEST_GAP_MS, validateMint, validateQuote, SOL } = require('./live_providers');

test('keeps aggregate provider rates below published ceilings', () => {
  assert.equal(GMGN_REQUEST_GAP_MS, 1100);
  assert.equal(HELIUS_REQUEST_GAP_MS, 125);
  assert.equal(GECKO_REQUEST_GAP_MS, 2100);
});
test('gecko pool OHLCV fallback parses, dedupes repeated minutes, and never leaks the pool URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-gecko-'));
  const seen = [];
  const opts = { keys: {}, fetch: async url => {
    seen.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { attributes: { ohlcv_list: [
      [1800000000, '1.0', '1.2', '0.9', '1.1', '5000'],
      [1800000060, '1.1', '1.3', '1.0', '1.25', '7000'],
      [1800000060, '1.1', '1.3', '1.0', '1.30', '7100'],
      [1800000120, 'bad'],
    ] } } }) };
  } };
  try {
    const candles = await new Providers(dir, opts).geckoCandles('PoolAddress1111111111111111111111111111111');
    assert.deepEqual(candles, [
      { time: 1800000000, open: '1.0', high: '1.2', low: '0.9', close: '1.1', volume: '5000' },
      { time: 1800000060, open: '1.1', high: '1.3', low: '1.0', close: '1.30', volume: '7100' },
    ]);
    assert.match(seen[0], /networks\/solana\/pools\/PoolAddress/);
    assert.match(seen[0], /ohlcv\/minute/);
    const usage = new Providers(dir, opts).usage();
    assert.equal(usage.providers.gecko.successes, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('gecko 429 backs off with the provider signal and blocks the next attempt across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-gecko-429-'));
  let calls = 0;
  const opts = { keys: {}, fetch: async () => { calls++; return { status: 429, ok: false, headers: { get: name => name === 'retry-after' ? '2' : null }, json: async () => ({}) }; } };
  try {
    const before = Date.now();
    await assert.rejects(new Providers(dir, opts).geckoCandles('pool'), /gecko_http_429/);
    const cooled = new Providers(dir, opts);
    assert.ok(cooled.state.providers.gecko.cooldownUntil - before <= 60000);
    await assert.rejects(cooled.geckoCandles('pool'), /gecko_cooldown/);
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('gecko missing-pool and malformed-body errors are sanitized and prefixed once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-gecko-bad-'));
  const opts = { keys: {}, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { attributes: {} } }) }) };
  try {
    const providers = new Providers(dir, opts);
    await assert.rejects(providers.geckoCandles(''), /gecko_missing_pool/);
    await assert.rejects(providers.geckoCandles('pool'), (error) => error.message === 'gecko_response_error');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('the gecko lease is host-wide and shared with other local services', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-gecko-lease-'));
  try {
    const first = new Providers(dir, { keys: {} });
    const second = new Providers(dir, { keys: {} });
    const startedAt = Date.now();
    await Promise.all([
      first.reserveSharedProviderSlot('gecko', GECKO_REQUEST_GAP_MS),
      second.reserveSharedProviderSlot('gecko', GECKO_REQUEST_GAP_MS),
    ]);
    assert.ok(Date.now() - startedAt >= GECKO_REQUEST_GAP_MS - 20);
    const lease = JSON.parse(fs.readFileSync(path.join(dir, '.gecko-rate-lease.json'), 'utf8'));
    assert.equal(lease.provider, 'gecko');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('separate workers share one host-wide provider lease', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-shared-rate-'));
  try {
    const first = new Providers(dir, { keys: {} });
    const second = new Providers(dir, { keys: {} });
    const startedAt = Date.now();
    await Promise.all([
      first.reserveSharedProviderSlot('helius', HELIUS_REQUEST_GAP_MS),
      second.reserveSharedProviderSlot('helius', HELIUS_REQUEST_GAP_MS),
    ]);
    assert.ok(Date.now() - startedAt >= HELIUS_REQUEST_GAP_MS - 20);
    const lease = JSON.parse(fs.readFileSync(path.join(dir, '.helius-rate-lease.json'), 'utf8'));
    assert.equal(lease.provider, 'helius');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const { createLocalPaperTraderState, runLocalPaperTrader } = require('./local_paper_trader.ts');
test('Bags fails over and preserves individual cooldowns across restart without storing secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bags-failover-'));
  const calls = [];
  const options = { keys: { bags: 'secret-one', bagsKeys: ['secret-one', 'secret-two'] }, fetch: async (_url, options) => {
    const key = options.headers['x-api-key']; calls.push(key);
    return { status: key === 'secret-one' ? 429 : 200, ok: key !== 'secret-one', headers: { get: () => null }, json: async () => ({ success: true, response: [] }) };
  } };
  try {
    await new Providers(dir, options).call('bags', '/token-launch/feed');
    await new Providers(dir, options).call('bags', '/token-launch/feed');
    assert.deepEqual(calls, ['secret-one', 'secret-two', 'secret-two']);
    assert.ok(!fs.readFileSync(path.join(dir, 'provider-usage.json'), 'utf8').includes('secret-'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('mint checks reject active authorities and unsupported extensions', () => {
  const a = { owner: TOKEN, data: { parsed: { type: 'mint', info: { isInitialized: true, mintAuthority: null, freezeAuthority: null, decimals: 6 } } } };
  assert.equal(validateMint(a), 6);
  a.data.parsed.info.extensions = [{ extension: 'transferHook' }];
  assert.throws(() => validateMint(a));
  a.data.parsed.info.extensions = []; a.data.parsed.info.freezeAuthority = 'someone';
  assert.throws(() => validateMint(a));
});
test('quote validation checks units, identity, slot and direct route', () => {
  const q = { inputMint: SOL, outputMint: 'mint', inAmount: '100', outAmount: '900', contextSlot: 20, routePlan: [{ inputMint: SOL, outputMint: 'mint', marketKey: 'pool' }] };
  assert.equal(validateQuote(q, SOL, 'mint', '100'), q);
  assert.throws(() => validateQuote(q, SOL, 'mint', '101'));
  assert.throws(() => validateQuote({ ...q, contextSlot: 0 }, SOL, 'mint', '100'));
  assert.throws(() => validateQuote({ ...q, routePlan: [...q.routePlan, ...q.routePlan] }, SOL, 'mint', '100'));
});
test('metadata-only Token-2022 is accepted, transfer fee extensions are not', () => {
  const a = { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: { parsed: { type: 'mint', info: { isInitialized: true, mintAuthority: null, freezeAuthority: null, decimals: 6, extensions: [{ extension: 'metadataPointer' }, { extension: 'tokenMetadata' }] } } } };
  assert.equal(validateMint(a), 6);
  a.data.parsed.info.extensions.push({ extension: 'transferFeeConfig' });
  assert.throws(() => validateMint(a), /unsupported_token_extension/);
});
test('429 cooldown survives restart and blocks another network attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-cooldown-'));
  let calls = 0;
  const opts = { keys: { bags: 'test' }, fetch: async () => { calls++; return { status: 429, ok: false, headers: { get: () => null } }; } };
  try {
    await assert.rejects(new Providers(dir, opts).call('bags', '/token-launch/feed'));
    await assert.rejects(new Providers(dir, opts).call('bags', '/token-launch/feed'), /cooldown/);
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('429 with a retry-after hint uses the provider signal, not the five-minute floor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-retry-after-'));
  const opts = { keys: { rpcEndpoints: [] }, fetch: async () => ({ status: 429, ok: false, headers: { get: name => name === 'retry-after' ? '2' : null } }) };
  try {
    const providers = new Providers(dir, opts);
    const before = Date.now();
    await assert.rejects(providers.call('jupiter', '/swap/v1/quote', { inputMint: SOL, outputMint: 'mint', amount: '100' }), /jupiter_http_429/);
    assert.ok(providers.state.providers.jupiter.cooldownUntil - before <= 60000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('entry quote falls back to a direct Jupiter route while Bags is cooling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-entry-failover-'));
  const calls = [];
  const body = { swapMode: 'ExactIn', inputMint: SOL, outputMint: 'mint', inAmount: '100', outAmount: '900', contextSlot: 20,
    routePlan: [{ percent: 100, swapInfo: { inputMint: SOL, outputMint: 'mint', ammKey: 'pool' } }] };
  const opts = { keys: { bags: 'test', bagsKeys: ['test'], jupiter: 'jupiter-key' }, fetch: async url => {
    const jupiter = String(url).includes('jup.ag'); calls.push(jupiter ? 'jupiter' : 'bags');
    return jupiter
      ? { status: 200, ok: true, headers: { get: () => null }, json: async () => body }
      : { status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) };
  } };
  try {
    const quote = await new Providers(dir, opts).quote(SOL, 'mint', '100');
    assert.equal(quote.outAmount, '900');
    assert.deepEqual(calls, ['bags', 'jupiter']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('usage persists attempts across restart and refuses over-budget request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-provider-'));
  let calls = 0;
  const opts = { keys: { rpc: 'https://mainnet.helius-rpc.com/?api-key=test' }, fetch: async () => { calls++; throw new Error('secret-containing-url'); } };
  try {
    const p = new Providers(dir, opts);
    await assert.rejects(p.call('helius', 'getSlot', []), /helius_request_failed/);
    const next = new Providers(dir, opts);
    assert.equal(next.usage().estimatedCredits, 1);
    next.state.buckets[0].credits = 9000000;
    await assert.rejects(next.call('helius', 'getSlot', []), /budget_exhausted/);
    assert.equal(calls, 1);
    assert.ok(!fs.readFileSync(path.join(dir, 'provider-usage.json'), 'utf8').includes('secret-containing'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('read-only RPC calls fail over from Helius to the configured backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-rpc-failover-'));
  const calls = [];
  const opts = { keys: { rpcEndpoints: [
    { name: 'helius', url: 'https://mainnet.helius-rpc.com/?api-key=test' },
    { name: 'orbitflare', url: 'https://rpc.example.test/?api_key=test' },
  ] }, fetch: async url => {
    calls.push(String(url));
    if (calls.length === 1) throw new Error('primary unavailable');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: 123 }) };
  } };
  try {
    const providers = new Providers(dir, opts);
    assert.equal(await providers.rpc('getSlot', []), 123);
    assert.deepEqual(providers.rpcProviderNames(), ['helius', 'orbitflare']);
    assert.equal(calls.length, 2);
    assert.equal(providers.state.providers.helius.errors, 1);
    assert.equal(providers.state.providers.orbitflare.successes, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('account reads fail over when a primary response is structurally invalid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-rpc-validation-'));
  let calls = 0;
  const opts = { keys: { rpcEndpoints: [
    { name: 'helius', url: 'https://mainnet.helius-rpc.com/?api-key=test' },
    { name: 'orbitflare', url: 'https://rpc.example.test/?api_key=test' },
  ] }, fetch: async () => {
    calls++;
    const result = calls === 1 ? { unexpected: true } : { context: { slot: 123 }, value: [null] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result }) };
  } };
  try {
    const accounts = await new Providers(dir, opts).accounts(['address']);
    assert.equal(accounts.context.slot, 123);
    assert.equal(accounts.rpcProvider, 'orbitflare');
    assert.equal(calls, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('read-only token supply and largest-account RPC methods validate their responses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-token-evidence-'));
  const responses = [
    { context: { slot: 10 }, value: { amount: '1000000', decimals: 6, uiAmountString: '1' } },
    { context: { slot: 11 }, value: [{ address: 'holder', amount: '500000', decimals: 6, uiAmountString: '.5' }] },
  ];
  const opts = { keys: { rpcEndpoints: [{ name: 'helius', url: 'https://mainnet.helius-rpc.com/?api-key=test' }] }, fetch: async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: responses.shift() }),
  }) };
  try {
    const providers = new Providers(dir, opts);
    assert.equal((await providers.tokenSupply('mint')).value.amount, '1000000');
    assert.equal((await providers.largestTokenAccounts('mint')).value[0].address, 'holder');
    assert.equal(providers.usage().estimatedCredits, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('quantity-specific quotes drive rotation and close; stale marks cannot enter', () => {
  const state = createLocalPaperTraderState();
  const mint = SOL, t = 100000;
  const input = (time, mark, candidates = []) => ({ schemaVersion: 'local-paper-trader-input/v1', generatedAt: time, marksByMint: { [mint]: mark }, candidates });
  runLocalPaperTrader(state, input(t, { fresh: true, priceSol: 1, updatedAt: t - 31000 }, [{ mint, decision: 'paper_entry_candidate', entryPriceSol: 1 }]));
  assert.equal(state.positions.length, 0);
  runLocalPaperTrader(state, input(t, { fresh: true, priceSol: 1, updatedAt: t }, [{ mint, decision: 'paper_entry_candidate', entryPriceSol: 1 }]));
  const p = state.positions[0], original = p.originalTokenAmount;
  const rotation = t + 600000;
  runLocalPaperTrader(state, input(rotation, { fresh: true, priceSol: 2, updatedAt: rotation, exitQuotes: [{ tokenAmount: original, proceedsSol: .08 }, { tokenAmount: original * .75, proceedsSol: .06 }] }));
  assert.equal(p.rotationAt, rotation);
  assert.ok(Math.abs(p.realizedPnlSol - (.06 * .99 - .05 * .75)) < 1e-9);
  const end = t + 14400000;
  runLocalPaperTrader(state, input(end, { fresh: true, priceSol: 2, updatedAt: end, exitQuotes: [{ tokenAmount: original * .25, proceedsSol: .02 }] }));
  assert.equal(p.closedAt, end);
  assert.ok(Math.abs(p.realizedPnlSol - (.08 * .99 - .05)) < 1e-9);
});
test('gmgn token info round-trips through the timestamped call path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-gmgn-'));
  const seen = [];
  const opts = { keys: { gmgn: 'gmgn-key' }, fetch: async url => {
    seen.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { code: 0, data: { address: 'mint', symbol: 'X' } } }) };
  } };
  try {
    const result = await new Providers(dir, opts).call('gmgn', '/v1/token/info', { chain: 'sol', address: 'mint' });
    assert.equal(result.address, 'mint');
    assert.match(seen[0], /[?&]timestamp=\d+/);
    assert.match(seen[0], /client_id=/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a transient 5xx is retried once before the request succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-5xx-'));
  let calls = 0;
  const opts = { keys: { rpcEndpoints: [{ name: 'helius', url: 'https://mainnet.helius-rpc.com/?api-key=test' }] }, fetch: async () => {
    calls++;
    return { ok: calls !== 1, status: calls === 1 ? 503 : 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: 7 }) };
  } };
  try {
    const providers = new Providers(dir, opts);
    assert.equal(await providers.rpc('getSlot', []), 7);
    assert.equal(calls, 2);
    assert.equal(providers.state.providers.helius.successes, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a persistent 5xx surfaces as one bounded failure, not a retry storm', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-5xx-fail-'));
  let calls = 0;
  const opts = { keys: { rpcEndpoints: [{ name: 'helius', url: 'https://mainnet.helius-rpc.com/?api-key=test' }] }, fetch: async () => { calls++; return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }; } };
  try {
    await assert.rejects(new Providers(dir, opts).rpc('getSlot', []), /helius_http_503/);
    assert.equal(calls, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
