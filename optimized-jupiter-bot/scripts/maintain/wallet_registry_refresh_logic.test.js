const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWalletRegistryDocs } = require('./wallet_registry_refresh_logic.ts');

test('buildWalletRegistryDocs refreshes alpha and kol registries from local wallet intel artifacts', () => {
  const { alphaDoc, kolDoc } = buildWalletRegistryDocs({
    alphaDoc: {
      tracked_wallets: [
        { address: 'legacyAlpha', score: 0.41, source: 'manual' },
        { address: 'trojanAlpha', score: 0.99, source: 'manual', executable: true, immediate_entry: true },
      ],
    },
    kolDoc: {
      tracked_wallets: [
        { address: 'legacyKol', score: 0.55, source: 'manual', style: 'KOL' },
      ],
    },
    walletIntelDoc: {
      tracked_wallets: [
        { address: 'alphaOne', style: 'FLOW', score: 0.82, executable: true },
        { address: 'kolOne', style: 'KOL', score: 0.78, executable: true },
      ],
      wallets: [
        {
          walletAddr: 'alphaOne',
          primaryStyle: 'FLOW',
          weightedScore: 0.82,
          copyabilityRisk: 'lower',
          executable: true,
          preferredHoldMs: 180000,
          winRate: 0.71,
          tags: ['smart_degen'],
        },
        {
          walletAddr: 'kolOne',
          primaryStyle: 'KOL',
          weightedScore: 0.78,
          copyabilityRisk: 'medium',
          executable: true,
          preferredHoldMs: 240000,
          winRate: 0.64,
          tags: ['kol', 'gmgn'],
          twitter: 'kol_account',
        },
      ],
    },
    walletPnlDoc: {
      wallets: [
        {
          walletAddr: 'alphaTwo',
          primaryStyle: 'SCALP',
          weightedScore: 0.76,
          copyabilityRisk: 'lower',
          executable: false,
          preferredHoldMs: 300000,
          winRate: 0.67,
        },
        {
          walletAddr: 'trojanAlpha',
          primaryStyle: 'SCALP',
          weightedScore: 0.88,
          copyabilityRisk: 'high',
          executable: false,
          immediateEntry: false,
          preferredHoldMs: 120000,
          winRate: 0.72,
          tags: ['trojan'],
        },
      ],
    },
    gmgnSmartMoneyDoc: {
      buys: [
        { maker: 'flowOne', amount_usd: 4200 },
        { maker: 'flowOne', amount_usd: 1800 },
        { maker: 'flowTwo', amount_usd: 2500 },
      ],
      sells: [
        { maker: 'flowOne', amount_usd: 1200 },
      ],
    },
    alphaLimit: 4,
    kolLimit: 3,
    nowIso: '2026-04-25T12:00:00.000Z',
  });

  assert.equal(alphaDoc.updated_at, '2026-04-25T12:00:00.000Z');
  assert.equal(kolDoc.updated_at, '2026-04-25T12:00:00.000Z');
  assert.ok(alphaDoc.tracked_wallets.some((row) => row.address === 'alphaOne'));
  assert.ok(alphaDoc.tracked_wallets.some((row) => row.address === 'alphaTwo'));
  assert.ok(alphaDoc.tracked_wallets.some((row) => row.address === 'flowOne'));
  assert.ok(!alphaDoc.tracked_wallets.some((row) => row.address === 'kolOne'));
  assert.ok(!alphaDoc.tracked_wallets.some((row) => row.address === 'trojanAlpha'));
  assert.ok(kolDoc.tracked_wallets.some((row) => row.address === 'kolOne'));
  assert.ok(kolDoc.tracked_wallets.some((row) => row.address === 'legacyKol'));
  assert.equal(alphaDoc.summary.top_wallet, 'alphaOne');
  assert.equal(kolDoc.summary.top_wallet, 'kolOne');
});
