const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWalletSignalArtifacts,
  createEmptyWalletSignalState,
} = require('./wallet_signal_logic.ts');

test('bootstraps without emitting ghost buy signals', () => {
  const now = 1_700_000_000_000;
  const trackedWallets = [
    { address: 'walletA', style: 'SCALP', score: 0.98, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
  ];
  const result = buildWalletSignalArtifacts({
    state: createEmptyWalletSignalState(now - 1),
    snapshots: [{ wallet: 'walletA', balances: { mint1: 12.5 }, timestamp: now }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now,
  });

  assert.equal(result.emittedEvents.length, 0);
  assert.equal(result.document.buy_signals.length, 0);
  assert.equal(result.state.initialized, true);
});

test('single immediate wallet buy becomes executable scalp signal', () => {
  const base = 1_700_000_000_000;
  const trackedWallets = [
    { address: 'walletA', style: 'SCALP', score: 0.98, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
  ];
  const initial = buildWalletSignalArtifacts({
    state: createEmptyWalletSignalState(base - 1),
    snapshots: [{ wallet: 'walletA', balances: {}, timestamp: base }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now: base,
  }).state;

  const result = buildWalletSignalArtifacts({
    state: initial,
    snapshots: [{ wallet: 'walletA', balances: { mint1: 3.2 }, timestamp: base + 30_000 }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    walletPnlRows: [{
      walletAddr: 'walletA',
      profitabilityScore: 0.82,
      weightedScore: 0.84,
      winRate: 0.61,
      realizedProfitUsd: 14000,
      tradeCount: 5400,
      copyabilityRisk: 'lower',
      styleProfile: ['SCALP'],
    }],
    now: base + 30_000,
  });

  assert.equal(result.emittedEvents.length, 1);
  assert.equal(result.document.buy_signals.length, 1);
  assert.equal(result.document.buy_signals[0].priority, 'SCALP');
  assert.equal(result.document.buy_signals[0].executable, true);
  assert.equal(result.document.buy_signals[0].conviction, 'HIGH');
  assert.ok(result.document.buy_signals[0].walletCompositeScore >= 0.7);
});

test('two executable wallets align into very high size-up signal', () => {
  const base = 1_700_000_000_000;
  const trackedWallets = [
    { address: 'walletA', style: 'SCALP', score: 0.98, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
    { address: 'walletB', style: 'SCALP', score: 0.84, executable: true, immediate_entry: true, preferred_hold_ms: 180000 },
  ];
  const initial = buildWalletSignalArtifacts({
    state: createEmptyWalletSignalState(base - 1),
    snapshots: [
      { wallet: 'walletA', balances: {}, timestamp: base },
      { wallet: 'walletB', balances: {}, timestamp: base },
    ],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now: base,
  }).state;

  const result = buildWalletSignalArtifacts({
    state: initial,
    snapshots: [
      { wallet: 'walletA', balances: { mint1: 2 }, timestamp: base + 20_000 },
      { wallet: 'walletB', balances: { mint1: 4 }, timestamp: base + 25_000 },
    ],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    walletPnlRows: [
      { walletAddr: 'walletA', profitabilityScore: 0.82, weightedScore: 0.84, winRate: 0.61, realizedProfitUsd: 14000, tradeCount: 5400, copyabilityRisk: 'lower', styleProfile: ['SCALP'] },
      { walletAddr: 'walletB', profitabilityScore: 0.74, weightedScore: 0.79, winRate: 0.58, realizedProfitUsd: 9000, tradeCount: 4100, copyabilityRisk: 'lower', styleProfile: ['FLOW'] },
    ],
    now: base + 30_000,
  });

  assert.equal(result.document.buy_signals.length, 1);
  assert.equal(result.document.buy_signals[0].priority, 'VERY_HIGH');
  assert.equal(result.document.buy_signals[0].sizeUp, true);
  assert.equal(result.document.buy_signals[0].wallets.length, 2);
  assert.ok(result.document.buy_signals[0].walletCompositeScore >= 0.74);
  assert.equal(result.document.buy_signals[0].copyabilityRisk, 'lower');
});

test('high-risk wallet clusters stay info-only even with strong raw scores', () => {
  const base = 1_700_000_000_000;
  const trackedWallets = [
    { address: 'walletA', style: 'SCALP', score: 0.96, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
    { address: 'walletB', style: 'SCALP', score: 0.91, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
  ];
  const initial = buildWalletSignalArtifacts({
    state: createEmptyWalletSignalState(base - 1),
    snapshots: [
      { wallet: 'walletA', balances: {}, timestamp: base },
      { wallet: 'walletB', balances: {}, timestamp: base },
    ],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now: base,
  }).state;

  const result = buildWalletSignalArtifacts({
    state: initial,
    snapshots: [
      { wallet: 'walletA', balances: { mint1: 2 }, timestamp: base + 20_000 },
      { wallet: 'walletB', balances: { mint1: 4 }, timestamp: base + 25_000 },
    ],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    walletPnlRows: [
      { walletAddr: 'walletA', profitabilityScore: 0.92, weightedScore: 0.91, winRate: 0.82, realizedProfitUsd: 24000, tradeCount: 22000, copyabilityRisk: 'high', styleProfile: ['SCALP'] },
      { walletAddr: 'walletB', profitabilityScore: 0.88, weightedScore: 0.87, winRate: 0.79, realizedProfitUsd: 18000, tradeCount: 17000, copyabilityRisk: 'high', styleProfile: ['SCALP'] },
    ],
    now: base + 30_000,
  });

  assert.equal(result.document.buy_signals[0].copyabilityRisk, 'high');
  assert.equal(result.document.buy_signals[0].executable, false);
  assert.equal(result.document.buy_signals[0].priority, 'INFO');
});

test('sell signal captures hold time after prior buy', () => {
  const base = 1_700_000_000_000;
  const trackedWallets = [
    { address: 'walletA', style: 'SCALP', score: 0.98, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
  ];
  const boot = buildWalletSignalArtifacts({
    state: createEmptyWalletSignalState(base - 1),
    snapshots: [{ wallet: 'walletA', balances: {}, timestamp: base }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now: base,
  }).state;
  const afterBuy = buildWalletSignalArtifacts({
    state: boot,
    snapshots: [{ wallet: 'walletA', balances: { mint1: 5 }, timestamp: base + 30_000 }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now: base + 30_000,
  }).state;
  const result = buildWalletSignalArtifacts({
    state: afterBuy,
    snapshots: [{ wallet: 'walletA', balances: {}, timestamp: base + 90_000 }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' } },
    now: base + 90_000,
  });

  assert.equal(result.document.sell_signals.length, 1);
  assert.equal(result.document.sell_signals[0].mint, 'mint1');
  assert.ok(result.document.sell_signals[0].holdMs >= 60_000);
});

test('stale events from untracked wallets are pruned from signal state', () => {
  const base = 1_700_000_000_000;
  const trackedWallets = [
    { address: 'walletA', style: 'SCALP', score: 0.98, executable: true, immediate_entry: true, preferred_hold_ms: 120000 },
  ];

  const dirtyState = {
    version: 1,
    initialized: true,
    updatedAt: base,
    balancesByWallet: {
      walletA: { mint1: 1 },
      staleWallet: { mint2: 2 },
    },
    positionsByWalletMint: {
      'walletA:mint1': { openedAt: base - 30_000, lastBuyAt: base - 30_000, currentBalance: 1, symbol: 'TOK' },
      'staleWallet:mint2': { openedAt: base - 30_000, lastBuyAt: base - 30_000, currentBalance: 2, symbol: 'BAD' },
    },
    buyEvents: [
      { type: 'BUY', walletAddr: 'walletA', mint: 'mint1', symbol: 'TOK', ts: base - 10_000, deltaAmount: 1, holdMs: 0, balanceAfter: 1 },
      { type: 'BUY', walletAddr: 'staleWallet', mint: 'mint2', symbol: 'BAD', ts: base - 10_000, deltaAmount: 2, holdMs: 0, balanceAfter: 2 },
    ],
    sellEvents: [
      { type: 'SELL', walletAddr: 'staleWallet', mint: 'mint2', symbol: 'BAD', ts: base - 5_000, deltaAmount: 1, holdMs: 5_000, balanceAfter: 1 },
    ],
  };

  const result = buildWalletSignalArtifacts({
    state: dirtyState,
    snapshots: [{ wallet: 'walletA', balances: { mint1: 1 }, timestamp: base }],
    trackedWallets,
    tokenMetadata: { mint1: { symbol: 'TOK' }, mint2: { symbol: 'BAD' } },
    walletPnlRows: [{
      walletAddr: 'walletA',
      profitabilityScore: 0.82,
      weightedScore: 0.84,
      winRate: 0.61,
      realizedProfitUsd: 14000,
      tradeCount: 5400,
      copyabilityRisk: 'lower',
      styleProfile: ['SCALP'],
    }],
    now: base,
  });

  assert.equal(result.state.buyEvents.length, 1);
  assert.equal(result.state.buyEvents[0].walletAddr, 'walletA');
  assert.equal(result.state.sellEvents.length, 0);
  assert.equal(Object.keys(result.state.balancesByWallet).includes('staleWallet'), false);
  assert.equal(Object.keys(result.state.positionsByWalletMint).some((key) => key.startsWith('staleWallet:')), false);
  assert.equal(result.document.buy_signals.every((signal) => signal.wallets.every((wallet) => wallet !== 'staleWallet')), true);
});
