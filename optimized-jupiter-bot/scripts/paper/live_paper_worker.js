'use strict';
const { marketCap } = require('./market_cap');
const { POLICY, qualityIssues, supportPattern, accelerationPattern, convictionPattern, flowMomentumPattern, selectEntryPattern, executionIssues } = require('./quality_entry');
const { candleRequest, normalizeCandles } = require('./candle_data');
const { exitQuote, retryDelay, nextExit } = require('./exit_quotes');
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { atomic } = require('./provider_trial');
const { Providers, SOL, validateMint, sanitizeError } = require('./live_providers');
const { createLocalPaperTraderState, runLocalPaperTrader } = require('./local_paper_trader.ts');
const { buildStagedLaunchRadar } = require('./staged_launch_radar.ts');
const { normalize, admissionIssues, reserveEvidence, updateTraffic } = require('./discovery_evidence');
const { normalizeHeliusTokenEvidence, reinforceDiscoveryEvidence } = require('./helius_token_evidence');
const { getSupplyControlProfile, deriveSupplyControl } = require('./supply_control');
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'artifacts/paper');
const STATE = process.env.PAPER_STATE_FILE ? path.resolve(process.env.PAPER_STATE_FILE) : path.join(DIR, 'local-paper-trader-state.json');
const LOCK = path.join(DIR, 'live-worker.lock');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CANDIDATES_PER_CYCLE = 20;
const IDLE_TICKS_PER_CYCLE = 3;
// Coalesce synchronous whole-ledger checkpoints so a cycle performs one durable
// write instead of one per apply()/serviceExits() hop.
const PERSIST_DEBOUNCE_MS = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function validAddress(s) { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }
function rawAmount(tokens, decimals) {
  const n = Math.floor(tokens * 10 ** decimals);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('amount_out_of_range');
  return String(n);
}
function samePool(a, b) {
  if (a.routePlan[0].marketKey !== b.routePlan[0].marketKey) throw new Error('cross_pool_quote');
}
function readEventIds(file) {
  if (!fs.existsSync(file)) return new Set();
  const ids = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('invalid_event_journal'); }
    if (typeof event?.id !== 'string' || !event.id || ids.has(event.id)) throw new Error('invalid_event_journal');
    ids.add(event.id);
  }
  return ids;
}
function appendMissingEvents(file, events, journalIds = readEventIds(file)) {
  const stateIds = new Set();
  for (const event of events) {
    if (typeof event?.id !== 'string' || !event.id || stateIds.has(event.id)) throw new Error('invalid_state_events');
    stateIds.add(event.id);
  }
  const missing = events.filter(event => !journalIds.has(event.id));
  if (!missing.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    for (const event of missing) fs.writeSync(fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  for (const event of missing) journalIds.add(event.id);
  return missing.length;
}

const DISCOVERY_LANES = ['gmgn-1m', 'gmgn-1h', 'bags', 'other'];
function rankDiscoveryQueue(rows, observations = new Map()) {
  const unique = new Map();
  const sourceRank = source => {
    const index = DISCOVERY_LANES.indexOf(source);
    return index < 0 ? DISCOVERY_LANES.length : index;
  };
  for (const row of rows) {
    if (!row?.mint) continue;
    const existing = unique.get(row.mint);
    if (!existing) {
      unique.set(row.mint, { ...row, discoverySources: [row.source] });
      continue;
    }
    const preferred = sourceRank(row.source) < sourceRank(existing.source) ? row : existing;
    unique.set(row.mint, {
      ...existing,
      ...row,
      source: preferred.source,
      liquidityUsd: Math.max(Number(existing.liquidityUsd || 0), Number(row.liquidityUsd || 0)),
      discoverySources: [...new Set([...(existing.discoverySources || [existing.source]), row.source])],
    });
  }
  const buckets = Object.fromEntries(DISCOVERY_LANES.map(lane => [lane, []]));
  for (const row of unique.values()) {
    const lane = DISCOVERY_LANES.includes(row.source) ? row.source : 'other';
    buckets[lane].push(row);
  }
  const compare = (a, b) => {
    const aChecked = observations.get(a.mint)?.checkedAt;
    const bChecked = observations.get(b.mint)?.checkedAt;
    if (Boolean(aChecked) !== Boolean(bChecked)) return aChecked ? 1 : -1;
    if (aChecked !== bChecked) return Number(aChecked || 0) - Number(bChecked || 0);
    const liquidity = Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0);
    if (liquidity) return liquidity;
    return String(a.mint).localeCompare(String(b.mint));
  };
  for (const lane of DISCOVERY_LANES) buckets[lane].sort(compare);
  const ranked = [];
  while (DISCOVERY_LANES.some(lane => buckets[lane].length)) {
    for (const lane of DISCOVERY_LANES) {
      const row = buckets[lane].shift();
      if (row) ranked.push(row);
    }
  }
  return ranked;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const lockFd = fs.openSync(LOCK, 'wx', 0o600);
  let stop = false;
  const stopHandler = () => { stop = true; };
  process.on('SIGTERM', stopHandler); process.on('SIGINT', stopHandler);
  let state;
  try {
    fs.writeFileSync(lockFd, String(process.pid));
    state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : createLocalPaperTraderState();
    if (state.execution?.mode !== 'paper_only' || state.execution?.signing !== 'disabled' || state.execution?.broadcasting !== 'disabled') throw new Error('unsafe_state');
    const eventFile = `${STATE}.events.jsonl`;
    const journalEventIds = readEventIds(eventFile);
    appendMissingEvents(eventFile, state.events, journalEventIds);
    state.execution.paperExecution = 'enabled';
    const providers = new Providers(DIR);
    if (state.run?.strategy !== POLICY.id) {
      state.run = { ...state.run, previousStrategy: state.run?.strategy || null, strategy: POLICY.id, strategyTransitionAt: Date.now() };
    }
    state.config.rotationTrigger = 'inactivity';
    // Exit policy: arm the stop at entry once a position banks +3% net, then trail
    // 4% below its peak. A winner that fades exits near flat instead of riding the
    // full 8% base stop back down, which is what most acceleration stop-outs did.
    state.config.breakevenAtPct = 3;
    state.config.trailingStopPct = 4;
    // Recycle capital on live winners: once a position is ten minutes old and up at
    // least +5% net, harvest 75% now instead of waiting on the +15% take-profit while
    // fresh candidates go untaken. Quiet positions still clear via inactivity, and a
    // 25% runner rides on toward the take-profit or the four-hour cap.
    state.config.rotationMinGainPct = 5;
    const trafficByMint = {};
    let queue = [], offset = 0, discoveredAt = 0;
    let healthCheckedAt = 0;
    const observations = new Map();
    // Completed 1m candles only change once per minute, so reuse a mint's candle
    // window within the same minute instead of re-paying the GMGN lease per re-check.
    const candleCacheByMint = new Map();
    let persistTimer = null, pendingPersist = false;
    const evidenceDir = path.join(DIR, 'discovery-evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    async function enrich(mint) {
      const start = Date.now();
      const evidenceFile = path.join(evidenceDir, `${mint}.json`);
      let previousEvidence = null;
      try { previousEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); } catch { /* First observation or invalid prior evidence. */ }
      const heliusProbe = Promise.all([providers.tokenSupply(mint), providers.largestTokenAccounts(mint)])
        .then(([supply, largest]) => ({ value: normalizeHeliusTokenEvidence(mint, supply, largest, Date.now()) }))
        .catch(error => ({ error }));
      const info = await providers.call('gmgn', '/v1/token/info', { chain: 'sol', address: mint });
      await serviceExits();
      const security = await providers.call('gmgn', '/v1/token/security', { chain: 'sol', address: mint });
      await serviceExits();
      const pool = await providers.call('gmgn', '/v1/token/pool_info', { chain: 'sol', address: mint });
      const e = normalize(mint, info, security, pool, start);
      const helius = await heliusProbe;
      if (helius.value) {
        reinforceDiscoveryEvidence(e, helius.value);
        const profile = getSupplyControlProfile(mint, Date.now());
        if (helius.value.top10AccountRatio > POLICY.maxTop10 || profile) {
          try {
            const largest = helius.value.largestAccounts.slice(0, 10);
            const tokenAccounts = await providers.accounts(largest.map(row => row.address));
            await serviceExits();
            const authorities = [...new Set(tokenAccounts.value.map(account => account?.data?.parsed?.info?.owner).filter(Boolean))];
            const authorityAccounts = await providers.accounts(authorities);
            e.supplyControl = deriveSupplyControl(e, helius.value, tokenAccounts, authorityAccounts, Date.now(), previousEvidence?.supplyControl);
          } catch (error) {
            e.supplyControl = { schemaVersion: 'pcp-paper-supply-control/v1', observedAt: Date.now(), status: 'unavailable', reason: error.message,
              profile: profile ? { id: profile.id, active: profile.active, expiresAt: profile.expiresAt } : null };
          }
        }
      }
      else e.reinforcement = { source: 'helius_rpc', observedAt: Date.now(), status: 'unavailable', reason: helius.error.message };
      e.checks = require('./discovery_evidence').deriveChecks(e);
      e.marketCap = marketCap(info, mint, start, pool);
      e.strategy = POLICY.id;
      e.issues = admissionIssues(e, Date.now());
      if (e.issues.length) {
        atomic(evidenceFile, e);
        return e;
      }
      const keys = [pool.pool_address, pool.base_vault_address, pool.quote_vault_address];
      let reserveIssue = null;
      try {
        if (keys.some(k => !validAddress(k))) throw new Error('missing_pool_vault_identity');
        e.reserves = reserveEvidence(e, await providers.accounts(keys), Date.now());
      } catch (error) { reserveIssue = error.message; }
      try {
        const now = Date.now();
        let cached = candleCacheByMint.get(mint);
        if (!cached) {
          await serviceExits();
          let candles = normalizeCandles(await providers.call('gmgn', '/v1/market/token_kline', candleRequest(mint, now)), now);
          let source = 'gmgn';
          // GMGN only charts tokens with recent activity, so a quiet launch comes
          // back empty; the pool OHLCV fallback restores the candle-pattern path.
          if (!candles.length && validAddress(pool.pool_address)) {
            await serviceExits();
            try {
              const gecko = normalizeCandles(await providers.geckoCandles(pool.pool_address, now), now);
              if (gecko.length) { candles = gecko; source = 'gecko'; }
            } catch { /* GMGN returned empty and no pool OHLCV is available either. */ }
          }
          cached = { candles, source };
          candleCacheByMint.set(mint, cached);
          while (candleCacheByMint.size > 300) candleCacheByMint.delete(candleCacheByMint.keys().next().value);
        }
        const candles = cached.candles;
        e.candles = { source: cached.source === 'gecko' ? 'gecko_pool_ohlcv' : 'gmgn_not_independent', observedAt: Date.now(), count: candles.length, latest: candles, historyStatus: 'unvalidated', timestampUnit: 'seconds' };
        try {
          const selected = selectEntryPattern(e, candles, Date.now());
          e.pattern = selected.pattern;
          e.entryLane = selected.entryLane;
          e.candles.historyStatus = selected.entryLane === 'conviction' ? 'available_no_strict_candle_pattern_conviction_fallback'
            : selected.entryLane === 'flow_momentum' ? 'available_no_candle_history_flow_momentum_fallback' : 'available';
          if (selected.pattern.lastClosedAt) e.candles.lastClosedAt = selected.pattern.lastClosedAt;
        } catch (error) {
          e.patternIssue = error.message;
          e.candles.historyStatus = 'available_no_entry_pattern';
        }
      } catch (error) {
        e.patternIssue = error.message;
        if (!e.candles) e.candles = { source: 'gmgn_not_independent', historyStatus: 'unavailable' };
        else if (!e.candles.historyStatus.startsWith('available')) e.candles.historyStatus = 'invalid_or_insufficient';
      }
      e.issues = [...admissionIssues(e, Date.now()), ...qualityIssues(e, e.entryLane || 'retrace')];
      if (!e.pattern) e.issues.push(e.patternIssue || 'pattern_unavailable');
      if (reserveIssue) e.issues.push(reserveIssue);
      atomic(evidenceFile, e);
      return e;
    }
    const maximum = process.argv.includes('--once') ? 1 : Infinity;
    let count = 0;
    state.live = { startedAt: Date.now(), status: 'starting', pid: process.pid, mode: 'paper_only', entryPolicy: POLICY };
    async function probeConnections() {
      if (Date.now() - healthCheckedAt < 300000) return;
      healthCheckedAt = Date.now();
      const probes = [
        ...providers.rpcProviderNames().map(provider => () => providers.call(provider, 'getSlot', [{ commitment: 'confirmed' }])),
        () => providers.call('bags', '/token-launch/feed'),
        () => providers.call('jupiter', '/swap/v1/quote', { inputMint: SOL, outputMint: USDC, amount: '10000000', swapMode: 'ExactIn', slippageBps: 50 }),
      ];
      for (const probe of probes) {
        try { await probe(); } catch { /* Provider ledger records sanitized health details. */ }
      }
    }
    function persist() {
      state.live.heartbeat = Date.now();
      state.live.usage = providers.usage();
      state.live.candidates = [...observations.values()].slice(-150).reverse();
      state.rpcUsage = providers.state.providers;
      state.pipeline = Object.fromEntries(Object.entries(providers.state.providers).map(([name, p]) => [name, {
        status: p.status === 'ok' && Date.now() - (p.lastSuccess || 0) < 360000 ? 'fresh' : 'stale',
        updatedAt: p.lastSuccess || 0, detail: p.status === 'ok' ? 'Authenticated read-only connection' : p.lastError || 'Provider unavailable',
      }]));
      state.pipeline.market = { status: Object.values(state.marksByMint).some(m => m.fresh && Date.now() - m.updatedAt < 30000) ? 'fresh' : 'missing', updatedAt: Date.now(), detail: 'Bags/Jupiter direct size-specific quotes; not independent trade OHLC' };
      const open = state.positions.filter(p => p.closedAt === null);
      const blocked = open.filter(p => p.exitHealth?.status === 'blocked' || !state.marksByMint[p.mint]?.fresh || Date.now() - (state.marksByMint[p.mint]?.updatedAt || 0) > 30000);
      state.pipeline.exits = { status: blocked.length ? 'stale' : 'fresh', updatedAt: Date.now(), detail: `${blocked.length} of ${open.length} positions lack a fresh verified exit quote; Bags then Jupiter` };
      const candleSamples = [...observations.values()].map(row => row.discovery?.candles).filter(Boolean);
      const latestCandle = candleSamples.sort((a, b) => (b.observedAt || 0) - (a.observedAt || 0))[0];
      state.pipeline.candles = {
        status: !latestCandle ? 'missing' : latestCandle.historyStatus === 'available' && Date.now() - latestCandle.observedAt < 90000 ? 'fresh' : 'stale',
        updatedAt: latestCandle?.observedAt || 0,
        detail: latestCandle ? `${latestCandle.historyStatus}; ${latestCandle.count || 0} completed candles received. ${latestCandle.source === 'gecko_pool_ohlcv' ? 'GeckoTerminal independent pool OHLC fallback (GMGN returned no history).' : 'GMGN token-level, not independent pool OHLC.'}` : 'Awaiting a candidate that passes liquidity and security gates',
      };
      pendingPersist = true;
      if (!persistTimer) persistTimer = setTimeout(() => flushPersist(), PERSIST_DEBOUNCE_MS);
    }
    function flushPersist() {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      if (!pendingPersist) return;
      pendingPersist = false;
      atomic(STATE, state);
    }
    function apply(input) {
      runLocalPaperTrader(state, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: Date.now(), trafficByMint, ...input });
      // A full, fsynced checkpoint preserves every position, including closed trades.
      // Event IDs make the append-only audit idempotently reconcilable after a crash.
      persist();
      appendMissingEvents(eventFile, state.events, journalEventIds);
    }
    async function verifyPool(pool, quoteSlot) {
      if (!validAddress(pool)) throw new Error('invalid_pool');
      const a = await providers.accounts([pool]);
      if (!a.value[0] || a.value[0].executable || a.value[0].owner === '11111111111111111111111111111111') throw new Error('missing_pool_account');
      if (['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(a.value[0].owner)) throw new Error('route_key_is_token_account_not_pool');
      if (Math.abs(a.context.slot - quoteSlot) > 100) throw new Error('stale_quote_slot');
      return a.value[0].owner;
    }
    async function serviceExits() {
      apply({ marksByMint: state.marksByMint, candidates: [] });
      for (const position of nextExit(state.positions)) {
        if (stop) break;
        const health = position.exitHealth ||= { failures: 0, nextRetryAt: 0 };
        if (health.nextRetryAt > Date.now()) continue;
        health.lastAttemptAt = Date.now();
        try {
          const decimals = position.mintDecimals;
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error('missing_exit_decimals');
          const amount = rawAmount(position.remainingTokenAmount, decimals);
          const result = await exitQuote(providers, position.mint, amount, verifyPool, event => {
            health.lastResponse = event;
            const fd = fs.openSync(`${STATE}.exit-quotes.jsonl`, 'a', 0o600);
            try { fs.writeSync(fd, JSON.stringify({ ...event, mint: position.mint, positionId: position.id }) + '\n'); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
          });
          const proceeds = Number(result.quote.outAmount) / 1e9;
          if (!Number.isSafeInteger(Number(result.quote.outAmount))) throw new Error('exit_output_out_of_range');
          const mark = { priceSol: proceeds / position.remainingTokenAmount, updatedAt: result.startedAt, fresh: true,
            exitQuotes: [{ tokenAmount: position.remainingTokenAmount, proceedsSol: proceeds }] };
          health.status = 'fresh'; health.failures = 0; health.lastSuccessAt = Date.now();
          health.nextRetryAt = Date.now() + 5000; health.source = result.source;
          health.previousPool = position.quotePool; health.pool = result.pool;
          position.quotePool = result.pool;
          apply({ marksByMint: { ...state.marksByMint, [position.mint]: mark }, candidates: [] });
        } catch (error) {
          health.status = 'blocked'; health.failures++;
          health.nextRetryAt = Date.now() + retryDelay(health.failures);
          health.reason = error.message;
          health.providers = error.failures || [];
          state.marksByMint[position.mint] = { ...(state.marksByMint[position.mint] || { priceSol: 0, updatedAt: 0 }), fresh: false };
          state.live.lastPositionIssue = { mint: position.mint, reason: error.message, at: Date.now() };
          apply({ marksByMint: state.marksByMint, candidates: [] });
        }
        if (position.closedAt === null) await refreshTraffic(position);
        flushPersist();
      }
    }
    async function refreshTraffic(target) {
      for (const position of [target]) {
        if (stop) break;
        const previous = trafficByMint[position.mint];
        // One GMGN call per position per 20 seconds. serviceExits fires several times
        // per candidate check, so an unthrottled re-check spends most of the host-wide
        // GMGN budget re-marking positions that already have a fresh exit quote; 20s
        // also stays inside the 30s freshness and 60s quiet-chain windows.
        if (previous && Number.isFinite(previous.checkedAt) && Date.now() - previous.checkedAt < 20000) {
          position.traffic = previous;
          continue;
        }
        try {
          const now = Date.now();
          const info = await providers.call('gmgn', '/v1/token/info', { chain: 'sol', address: position.mint });
          if (info.address !== position.mint) throw new Error('traffic_mint_conflict');
          position.marketCap = marketCap(info, position.mint, Date.now());
          const numeric = key => info.price?.[key] == null || info.price[key] === '' ? null : Number(info.price[key]);
          trafficByMint[position.mint] = updateTraffic(previous, { buys1m: numeric('buys_1m'), sells1m: numeric('sells_1m'), swaps1m: numeric('swaps_1m'), volume1mUsd: numeric('volume_1m') }, now);
        } catch { trafficByMint[position.mint] = { checkedAt: Date.now(), quietSince: null }; }
        position.traffic = trafficByMint[position.mint];
        apply({ marksByMint: state.marksByMint, candidates: [] });
      }
    }
    flushPersist();
    while (!stop && count++ < maximum) {
      state.live.status = 'running';
      state.live.cycle = count;
      await serviceExits();
      await probeConnections();
      if (Date.now() - discoveredAt >= 30000) {
        await serviceExits();
        const rows = [];
        try {
          const launches = await providers.call('bags', '/token-launch/feed');
          rows.push(...launches.map(r => ({ mint: r.tokenMint, symbol: r.symbol, source: 'bags', image: r.image || r.logo, pool: r.dbcPoolKey, launchStatus: r.status, discoveredAt: Date.now() })));
        } catch (e) { state.live.bagsDiscoveryIssue = e.message; }
        await serviceExits();
        try {
          const fastRank = await providers.call('gmgn', '/v1/market/rank', { chain: 'sol', interval: '1m', limit: 40, order_by: 'volume', direction: 'desc', min_liquidity: POLICY.minLiquidityUsd });
          rows.push(...fastRank.map(r => ({ mint: r.address, symbol: r.symbol, source: 'gmgn-1m', image: r.logo, liquidityUsd: Number(r.liquidity), discoveredAt: Date.now() })));
          delete state.live.discoveryIssue;
        } catch (e) { state.live.discoveryIssue = e.message; }
        await serviceExits();
        const previousQueue = queue, previousOffset = offset;
        queue = rankDiscoveryQueue(rows.filter(r => validAddress(r.mint)), observations);
        // Resume the round-robin where the last cycle stopped, so a large queue is
        // drained fairly instead of re-scanning only its head every rebuild.
        const lastServedMint = previousQueue.length ? previousQueue[(previousOffset - 1 + previousQueue.length) % previousQueue.length].mint : null;
        const resumeAt = lastServedMint ? queue.findIndex(r => r.mint === lastServedMint) : -1;
        offset = resumeAt >= 0 ? resumeAt + 1 : 0;
        discoveredAt = Date.now();
        for (const r of queue) {
          const prior = observations.get(r.mint);
          observations.set(r.mint, { ...prior, ...r, firstSeenAt: prior?.firstSeenAt || r.discoveredAt, decision: prior?.decision || 'queued', reason: prior?.reason || 'Awaiting discovery evidence and quote' });
        }
        while (observations.size > 150) observations.delete(observations.keys().next().value);
        flushPersist();
      }
      for (let n = 0; n < Math.min(CANDIDATES_PER_CYCLE, queue.length) && !stop; n++) {
        await serviceExits();
        const row = queue[offset++ % queue.length];
        if (state.positions.some(p => p.mint === row.mint)) continue;
        if (Date.now() - row.discoveredAt > 90000) continue;
        try {
          observations.set(row.mint, { ...row, decision: 'checking', reason: 'Confirmed mint / direct quotes' }); flushPersist();
          const discovery = await enrich(row.mint);
          row.discovery = discovery;
          row.liquidityUsd = discovery.liquidityUsd;
          if (discovery.issues.length) throw new Error(discovery.issues.join(', '));
          if (state.positions.filter(p => p.closedAt === null).length >= state.config.maxOpenPositions || state.availableCapitalSol < state.config.initialPositionSol) throw new Error('paper_capacity_full');
          const a = await providers.accounts([row.mint]);
          const decimals = validateMint(a.value[0]);
          const netStake = state.config.initialPositionSol * (1 - state.config.modeledFeeBps / 10000);
          const started = Date.now();
          const buy = await providers.quote(SOL, row.mint, String(Math.floor(netStake * 1e9)));
          await serviceExits();
          const tokenAmount = Number(buy.outAmount) / 10 ** decimals;
          if (!Number.isSafeInteger(Number(buy.outAmount)) || !Number.isFinite(tokenAmount) || tokenAmount <= 0) throw new Error('amount_out_of_range');
          const sell = await providers.quote(row.mint, SOL, buy.outAmount);
          samePool(buy, sell);
          const pool = buy.routePlan[0].marketKey;
          if (pool !== discovery.pool) throw new Error('quote_discovery_pool_conflict');
          const owner = await verifyPool(pool, Math.min(buy.contextSlot, sell.contextSlot));
          const finalIssues = [...admissionIssues(discovery, Date.now()), ...executionIssues(discovery, state.config.initialPositionSol, Number(sell.outAmount) / 1e9, state.config.modeledFeeBps)];
          if (discovery.entryLane === 'acceleration') accelerationPattern(discovery.candles.latest, Date.now());
          else if (discovery.entryLane === 'conviction') convictionPattern(discovery, Date.now());
          else if (discovery.entryLane === 'flow_momentum') flowMomentumPattern(discovery, Date.now());
          else supportPattern(discovery.candles.latest, Date.now());
          if (finalIssues.length) throw new Error(finalIssues.join(', '));
          const mark = { priceSol: Number(sell.outAmount) / 1e9 / tokenAmount, updatedAt: started, fresh: true, exitQuotes: [{ tokenAmount, proceedsSol: Number(sell.outAmount) / 1e9 }] };
          const entryPriceSol = netStake / tokenAmount;
          const radar = buildStagedLaunchRadar({
            schemaVersion: 'staged-launch-radar-input/v1', generatedAt: Date.now(),
            gmgnCandidates: [{ mint: row.mint, symbol: row.symbol, detectedAt: row.discoveredAt, poolId: discovery.pool, imageUrl: discovery.media.image }],
            heliusByMint: { [row.mint]: { confirmed: true, mintSafe: true, observedAt: Date.now(), poolId: pool } },
            marketByMint: { [row.mint]: { priceSol: mark.priceSol, fresh: Date.now() - started <= 30000, observedAt: started, poolId: pool, liquidityUsd: row.liquidityUsd } },
          });
          const decision = radar.candidates[0];
          apply({ marksByMint: { ...state.marksByMint, [row.mint]: mark }, candidates: [{ mint: row.mint, symbol: row.symbol, decision: decision.decision, entryPriceSol }] });
          const position = state.positions.find(p => p.mint === row.mint);
          if (position) { position.quotePool = pool; position.mintDecimals = decimals; position.entryLane = discovery.entryLane; position.evidence = { source: row.source, poolOwner: owner, quoteSlot: buy.contextSlot, discovery, pricing: 'Bags direct quote plus unchanged modeled cost buffer' }; }
          observations.set(row.mint, { ...row, pool, decision: position ? 'paper_open' : 'waiting', reason: position ? 'Renounced SPL mint; two-way direct quote' : decision.reasons.join(', ') || 'Capacity or quote freshness', checkedAt: Date.now() });
        } catch (e) {
          observations.set(row.mint, { ...row, decision: 'watch_only', reason: e.message, checkedAt: Date.now() });
        }
        flushPersist();
      }
      state.live.lastCycleAt = Date.now(); flushPersist();
      if (count < maximum) for (let i = 0; i < IDLE_TICKS_PER_CYCLE && !stop; i++) { await sleep(1000); await serviceExits(); }
    }
    state.live.status = 'stopped'; flushPersist();
  } finally {
    fs.closeSync(lockFd); fs.unlinkSync(LOCK);
    process.removeListener('SIGTERM', stopHandler); process.removeListener('SIGINT', stopHandler);
  }
}
module.exports = { rawAmount, samePool, validAddress, readEventIds, appendMissingEvents, rankDiscoveryQueue };
if (require.main === module) main().catch(error => {
  console.error('Paper worker stopped:', JSON.stringify(sanitizeError({ message: error?.message || 'unknown_error' })));
  process.exitCode = 1;
});
