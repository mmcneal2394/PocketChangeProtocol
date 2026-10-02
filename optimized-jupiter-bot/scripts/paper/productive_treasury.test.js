const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildProductiveTreasurySnapshot,
  evaluateProductiveCandidate,
  validateProductiveSource,
} = require('./productive_treasury.ts');
const {
  normalizeMemestonksCandidate,
  normalizeGmgnMarket,
  normalizeOtcCandidates,
  normalizeX7Candidates,
  payoutAssetCategory,
} = require('./productive_treasury_worker.ts');

const now = 1_800_000_000_000;
const policy = {
  maxSourceAgeMs: 900000,
  minCompletedPayoutCycles: 3,
  minRecordDays: 30,
  minProjectScore: 50,
  minLiquidityUsd: 7000,
  minVolume24hUsd: 5000,
  minHolders: 100,
  maxRoundTripLossPct: 0.08,
  maxProjectWeightPct: 0.10,
  productiveTokenBudgetPct: 0.45,
  reserveFloorPct: 0.40,
  buybackCapPct: 0.20,
};
const candidate = {
  mint: '4iCRYJHvwUE21duaQ1nQcUXkh7wYNQai9aBihd3FBAGS', symbol: 'VAULT', name: 'VaultBags',
  sourceId: 'example-protocol', sourceKind: 'protocol-api', observedAt: now,
  payout: { assets: [{ mint: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', symbol: 'USDY' }], completedCycles: 50, recordDays: 90, receiptsVerified: true, allRecordedClaimsLanded: true },
  protocol: { projectScore: 90 },
};
const market = { observedAt: now, mintVerified: true, liquidityUsd: 25000, volume24hUsd: 15000, holders: 300, roundTripLossPct: 0.025 };

test('admits a source-neutral productive token only after payout and exit gates pass', () => {
  const result = evaluateProductiveCandidate(candidate, market, policy, now);
  assert.equal(result.decision, 'paper_eligible');
  assert.deepEqual(result.issues, []);
});

test('fails closed when payout receipts or an executable round trip are missing', () => {
  const result = evaluateProductiveCandidate({ ...candidate, payout: { ...candidate.payout, receiptsVerified: false } }, { ...market, roundTripLossPct: null }, policy, now);
  assert.equal(result.decision, 'watch_only');
  assert.ok(result.issues.includes('payout_receipts_unverified'));
  assert.ok(result.issues.includes('round_trip_quote_missing'));
});

test('allocates capped paper weights across any protocol source', () => {
  const source = validateProductiveSource({ schemaVersion: 'pcp-productive-source/v1', sourceId: 'chain-wide', sourceKind: 'onchain-distributor', observedAt: now, status: 'fresh', candidates: [candidate] });
  const snapshot = buildProductiveTreasurySnapshot({ sources: [source], marketsByMint: { [candidate.mint]: market }, policy, generatedAt: now });
  assert.equal(snapshot.coverage.eligible, 1);
  assert.equal(snapshot.candidates[0].targetWeightPct, 0.10);
  assert.equal(snapshot.execution.signing, 'disabled');
  assert.equal(snapshot.allocation.status, 'awaiting_reconciled_fee_input');
});

test('normalizes OTC payout leaders without treating aggregate totals as receipts', () => {
  const rows = normalizeOtcCandidates({ coins: [{
    mint: candidate.mint, symbol: 'PAY', name: 'Pays holders', createdAt: now / 1000 - 86400 * 40,
    rewardMint: candidate.payout.assets[0].mint, rewardSymbol: 'USDY', rewardCycle: 8,
  }] }, { top: [{ mint: candidate.mint, distributed: 1000, holdersPaid: 25 }], lastDistributedAt: now / 1000 - 60 }, { id: 'otc', kind: 'otc', limit: 10 }, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payout.completedCycles, 8);
  assert.equal(rows[0].payout.receiptsVerified, false);
  assert.equal(rows[0].payout.assets[0].symbol, 'USDY');
  assert.equal(rows[0].raw.payoutRecord.holdersPaid, 25);
});

test('x7 only emits holder-directed tokens and keeps payout admission closed', () => {
  const rows = normalizeX7Candidates({ coins: [
    { mint: candidate.mint, symbol: 'HOLD', name: 'Holder rewards', rewardsTarget: 'holders', pairMint: candidate.payout.assets[0].mint, pair: 'USDY', volume24hUsd: 9000, createdAt: new Date(now - 40 * 86400000).toISOString() },
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'SELF', rewardsTarget: 'self', pairMint: candidate.payout.assets[0].mint, pair: 'USDY', volume24hUsd: 100000 },
  ] }, { id: 'x7', kind: 'x7', limit: 10 }, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'HOLD');
  assert.equal(rows[0].payout.receiptsVerified, false);
  assert.equal(rows[0].payout.completedCycles, 0);
});

test('x7 crypto payout lane survives the general volume cap', () => {
  const rows = normalizeX7Candidates({ coins: [
    { mint: candidate.mint, symbol: 'LIQUID', rewardsTarget: 'holders', pairMint: candidate.payout.assets[0].mint, pair: 'USDY', volume24hUsd: 9000 },
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'BTC PAY', rewardsTarget: 'holders', pairMint: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS', pair: 'WBTC', volume24hUsd: 0 },
  ] }, { id: 'x7', kind: 'x7', limit: 1, cryptoPayoutLimit: 10 }, now);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].payout.assets[0].category, 'crypto-representation');
});

test('MemeStonks retains settled payout evidence but fails closed on an off-chain pledge', () => {
  const row = normalizeMemestonksCandidate({
    mint: candidate.mint, symbol: 'MEME', name: 'Meme Stonk', pairSymbol: 'USDY',
    pairMint: candidate.payout.assets[0].mint, pledgeBps: 10000, taxFrozen: true,
    createdAt: new Date(now - 40 * 86400000).toISOString(), marketCapUsd: 10000, volume24hUsd: 7000,
  }, {
    enabled: true, pledgeBps: 10000, pledgeIsOnChain: false, allDirect: true,
    cadence: 'hourly', lifetimePeriodsPaid: 4,
    payout: { mint: candidate.payout.assets[0].mint, symbol: 'USDY' },
    periods: [{ status: 'settled', paidUnits: '100', windowEndMs: now - 1000 }],
  }, { holderStreams: [{ mint: candidate.mint, totalUsd: 50, payments: 4, estimated: false }] }, { id: 'memestonks', kind: 'memestonks' }, now);
  assert.ok(row);
  assert.equal(row.payout.receiptsVerified, true);
  assert.equal(row.protocol.firewallPass, false);
  const evaluated = evaluateProductiveCandidate(row, market, policy, now);
  assert.equal(evaluated.decision, 'watch_only');
  assert.ok(evaluated.issues.includes('protocol_firewall_unverified'));
});

test('normalizes the complete GMGN fee and market model without treating creator rewards as holder payouts', () => {
  const info = {
    address: candidate.mint, symbol: 'PAY', name: 'Pays holders', holder_count: 321,
    circulating_supply: '1000000', liquidity: '25000', trade_fee: '4.5', total_fee: '8.25',
    launchpad: 'pump', launchpad_platform: 'Pump.fun', launchpad_status: 1, ath_price: '0.2',
    price: { price: '0.1', volume_1m: '5', volume_5m: '25', volume_1h: '100', volume_6h: '500', volume_24h: '12000', buy_volume_24h: '7000', sell_volume_24h: '5000', buys_24h: 70, sells_24h: 50, swaps_24h: 120 },
    pool: { pool_address: 'pool', exchange: 'pump_amm', quote_address: 'So11111111111111111111111111111111111111112', quote_symbol: 'SOL' },
    stat: { top_10_holder_rate: '0.2', creator_hold_rate: '0.01', top_bundler_trader_percentage: '0.04' },
    fee_distribution: { launchpad: 'pump', platform_data: { bonus_category: ['creator_reward'], is_locked: true, is_charity: false, list: [{ has_claimed_fee: true }, { has_claimed_fee: false }] } },
    link: { twitter: 'https://example.test' },
  };
  const result = normalizeGmgnMarket(info, candidate.mint, now);
  assert.equal(result.marketCapUsd, 100000);
  assert.equal(result.gmgn.fees.totalFee, 8.25);
  assert.deepEqual(result.gmgn.fees.bonusCategories, ['creator_reward']);
  assert.equal(result.gmgn.pool.quoteSymbol, 'SOL');
  assert.equal(result.gmgn.providerPayload.info, info);
  assert.equal(result.gmgn.fees.recipientCount, 2);
  assert.equal(result.gmgn.fees.claimedRecipientCount, 1);
  assert.equal(result.gmgn.holderPayout, undefined);
});

test('separates wrapped native and unverified crypto representations from stable-value assets', () => {
  assert.equal(payoutAssetCategory('So11111111111111111111111111111111111111112', 'SOL'), 'wrapped-native-crypto');
  assert.equal(payoutAssetCategory('A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS', 'ZEC'), 'crypto-representation');
  assert.equal(payoutAssetCategory(candidate.payout.assets[0].mint, 'USDY', 'treasury'), 'treasury');
});
