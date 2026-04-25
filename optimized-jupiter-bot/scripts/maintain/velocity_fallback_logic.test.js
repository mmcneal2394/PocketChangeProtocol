const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCompositeVelocityEntries } = require('./velocity_fallback_logic.ts');

test('buildCompositeVelocityEntries converts trending entries into velocity-shaped mints', () => {
  const result = buildCompositeVelocityEntries({
    rawTrending: [{
      baseToken: { address: 'MintA', symbol: 'ALPHA' },
      volume: { h1: 60000, m5: 15000 },
      priceChange: { h1: 120, m5: 18 },
      liquidity: { usd: 12000 },
      txns: { h1: { buys: 720, sells: 180 } },
      dexId: 'bags-fm',
    }],
    solPriceUsd: 150,
    now: 123,
  });

  assert.ok(result.MintA);
  assert.equal(result.MintA.symbol, 'ALPHA');
  assert.equal(result.MintA.isAccelerating, true);
  assert.ok(result.MintA.buys60s >= 6);
  assert.ok(result.MintA.solVolume60s > 0);
  assert.equal(result.MintA.isSynthetic, true);
  assert.equal(result.MintA.refinementOnly, true);
  assert.ok(result.MintA.solVolume60s <= 25);
});

test('buildCompositeVelocityEntries boosts executable wallet signals', () => {
  const result = buildCompositeVelocityEntries({
    rawTrending: [{
      baseToken: { address: 'MintB', symbol: 'BETA' },
      volume: { h1: 12000, m5: 3000 },
      priceChange: { h1: 25, m5: 4 },
      liquidity: { usd: 9000 },
      txns: { h1: { buys: 120, sells: 60 } },
    }],
    walletSignalsDocument: {
      buy_signals: [{
        mint: 'MintB',
        symbol: 'BETA',
        executable: true,
        sizeUp: true,
        swapSolAmount: 2.5,
      }],
    },
    solPriceUsd: 150,
  });

  assert.ok(result.MintB);
  assert.ok(result.MintB.buyRatio60s >= 0.75);
  assert.ok(result.MintB.buys60s >= 8);
  assert.equal(result.MintB.isSynthetic, true);
  assert.equal(result.MintB.refinementOnly, true);
});

test('buildCompositeVelocityEntries can synthesize wallet-only candidates', () => {
  const result = buildCompositeVelocityEntries({
    walletSignalsDocument: {
      buy_signals: [{
        mint: 'MintC',
        symbol: 'GAMMA',
        executable: true,
        sizeUp: false,
        swapSolAmount: 1.1,
        expired: false,
      }],
    },
  });

  assert.ok(result.MintC);
  assert.equal(result.MintC.syntheticSource, 'composite-wallet');
  assert.equal(result.MintC.isAccelerating, true);
  assert.equal(result.MintC.refinementOnly, true);
});

test('buildCompositeVelocityEntries filters weak onchain-launchpad placeholders', () => {
  const result = buildCompositeVelocityEntries({
    rawTrending: [{
      mint: 'MintLaunchpadWeak',
      symbol: 'WEAK',
      source: 'onchain-launchpad',
      volume5m: 2_000,
      volume1h: 12_000,
      priceChange5m: 0,
      priceChange1h: -5,
      liquidityUsd: 7_000,
      buys1h: 720,
      sells1h: 720,
      buyRatio: 1,
    }],
    solPriceUsd: 150,
  });

  assert.equal(result.MintLaunchpadWeak, undefined);
});

test('buildCompositeVelocityEntries keeps strong onchain-launchpad entries', () => {
  const result = buildCompositeVelocityEntries({
    rawTrending: [{
      mint: 'MintLaunchpadStrong',
      symbol: 'STRONG',
      source: 'onchain-launchpad',
      volume5m: 18_000,
      volume1h: 72_000,
      priceChange5m: 12,
      priceChange1h: 45,
      liquidityUsd: 28_000,
      buys1h: 720,
      sells1h: 180,
      buyRatio: 4,
    }],
    solPriceUsd: 150,
  });

  assert.ok(result.MintLaunchpadStrong);
  assert.equal(result.MintLaunchpadStrong.syntheticSource, 'composite-onchain-launchpad');
});

test('buildCompositeVelocityEntries filters flat gmgn plateau candidates without support', () => {
  const now = Date.now();
  const result = buildCompositeVelocityEntries({
    rawTrending: [{
      mint: 'MintGmgnFlat',
      symbol: 'PLATEAU',
      source: 'gmgn-bridge',
      volume5m: 12_000,
      volume1h: 84_000,
      priceChange5m: 0,
      priceChange1h: 0,
      liquidityUsd: 8_000,
      buys1h: 720,
      sells1h: 720,
      buyRatio: 1,
      holders: 140,
      smartMoney: 0,
      pairCreatedAt: Math.floor((now - (20 * 60_000)) / 1000),
    }],
    solPriceUsd: 150,
    now,
  });

  assert.equal(result.MintGmgnFlat, undefined);
});

test('buildCompositeVelocityEntries keeps flat gmgn candidate when executable wallet confirms it', () => {
  const now = Date.now();
  const result = buildCompositeVelocityEntries({
    rawTrending: [{
      mint: 'MintGmgnWallet',
      symbol: 'CONFIRMED',
      source: 'gmgn-bridge',
      volume5m: 12_000,
      volume1h: 84_000,
      priceChange5m: 0,
      priceChange1h: 0,
      liquidityUsd: 8_000,
      buys1h: 720,
      sells1h: 720,
      buyRatio: 1,
      holders: 140,
      smartMoney: 0,
      pairCreatedAt: Math.floor((now - (20 * 60_000)) / 1000),
    }],
    walletSignalsDocument: {
      buy_signals: [{
        mint: 'MintGmgnWallet',
        symbol: 'CONFIRMED',
        executable: true,
        sizeUp: false,
        swapSolAmount: 1.2,
      }],
    },
    solPriceUsd: 150,
    now,
  });

  assert.ok(result.MintGmgnWallet);
});
