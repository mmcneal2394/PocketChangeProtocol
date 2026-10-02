'use strict';
const fs = require('fs');
const path = require('path');
const { Providers, SOL, validateMint } = require('./live_providers');
const { normalize, admissionIssues, reserveEvidence } = require('./discovery_evidence');
const { candleRequest, normalizeCandles } = require('./candle_data');
const { closedCandles, supportPattern, qualityIssues } = require('./quality_entry');
const { atomic } = require('./provider_trial');

// Exclusive read-only probe: share durable rate accounting, never race the worker.
async function check(dir) {
  const lock = path.join(dir, 'live-worker.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  const report = { startedAt: Date.now(), mode: 'read_only_no_fills', candidates: [] };
  try {
    fs.writeFileSync(fd, String(process.pid));
    const p = new Providers(dir);
    const rank = await p.call('gmgn', '/v1/market/rank', { chain: 'sol', interval: '1h', order_by: 'volume', direction: 'desc', limit: 10, min_liquidity: 100000, min_created: '1h' });
    report.discoveryCount = rank.length;
    for (const row of rank.slice(0, 3)) {
      const result = { mint: row.address, symbol: row.symbol, checks: {} };
      report.candidates.push(result);
      const probe = async (name, action) => {
        try { result.checks[name] = { status: 'ok', value: await action() }; }
        catch (e) { result.checks[name] = { status: 'blocked', reason: e.message }; }
      };
      let evidence;
      await probe('discoveryEvidence', async () => {
        const at = Date.now();
        const info = await p.call('gmgn', '/v1/token/info', { chain: 'sol', address: row.address });
        const security = await p.call('gmgn', '/v1/token/security', { chain: 'sol', address: row.address });
        const pool = await p.call('gmgn', '/v1/token/pool_info', { chain: 'sol', address: row.address });
        evidence = normalize(row.address, info, security, pool, at);
        return { liquidityUsd: evidence.liquidityUsd, ageSeconds: evidence.ageSeconds, flow: evidence.flow, pool: evidence.pool, admissionIssues: admissionIssues(evidence, Date.now()), qualityIssues: qualityIssues(evidence) };
      });
      await probe('mintControls', async () => validateMint((await p.accounts([row.address])).value[0]));
      await probe('reserves', async () => {
        if (!evidence) throw Error('missing_discovery');
        const pool = evidence.poolDescription;
        return reserveEvidence(evidence, await p.accounts([pool.pool_address, pool.base_vault_address, pool.quote_vault_address]), Date.now());
      });
      await probe('candles', async () => {
        const now = Date.now();
        const candles = normalizeCandles(await p.call('gmgn', '/v1/market/token_kline', candleRequest(row.address, now)), now);
        const closed = closedCandles(candles, Date.now());
        let pattern;
        try { pattern = supportPattern(candles, Date.now()); } catch (e) { pattern = { rejection: e.message }; }
        return { received: candles.length, validatedClosed: closed.length, lastClosedAt: closed.at(-1).time * 1000, pattern };
      });
      for (const source of ['bags', 'jupiter']) await probe(`${source}RoundTrip`, async () => {
        const quote = source === 'bags' ? p.quote.bind(p) : p.jupiterQuote.bind(p);
        const buy = await quote(SOL, row.address, '49500000');
        const sell = await quote(row.address, SOL, buy.outAmount);
        const pool = buy.routePlan[0].marketKey;
        if (sell.routePlan[0].marketKey !== pool) throw Error('cross_pool_quote');
        if (evidence && evidence.pool !== pool) throw Error('quote_discovery_pool_conflict');
        const accounts = await p.accounts([pool]);
        const account = accounts.value[0];
        if (!account || account.executable || ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(account.owner)) throw Error('invalid_pool_account');
        if ([buy.contextSlot, sell.contextSlot].some(slot => Math.abs(accounts.context.slot - slot) > 100)) throw Error('stale_quote_slot');
        return { pool, netRoundTripReturnPct: (Number(sell.outAmount) / 1e9 * .99 / .05 - 1) * 100 };
      });
    }
    report.usage = p.usage();
  } finally {
    report.completedAt = Date.now();
    atomic(path.join(dir, 'live-data-check.json'), report);
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
  return report;
}
module.exports = { check };
