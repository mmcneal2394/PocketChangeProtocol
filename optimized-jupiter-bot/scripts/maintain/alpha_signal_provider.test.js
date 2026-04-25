const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadCatalystSignalsFromFile,
  computeAlphaBoost,
} = require('./alpha_signal_provider.ts');

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

test('loadCatalystSignalsFromFile reads signals arrays from alert documents', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-provider-'));
  const alertsPath = path.join(tempDir, 'catalyst_alerts.json');
  writeJson(alertsPath, {
    updatedAt: 123,
    signals: [
      {
        source: 'dexscreener',
        type: 'DEX_BOOST',
        timestamp: 100,
        token_address: 'MintA',
        sentiment_score: 0.8,
        confidence: 0.5,
        kol_reputation_score: 0,
        expires_at: 10_000,
        metadata: { boost: 0.12, signalKey: 'boost' },
      },
    ],
  });

  const signals = loadCatalystSignalsFromFile(alertsPath);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].token_address, 'MintA');
});

test('computeAlphaBoost combines catalyst and wallet alpha signals for a token', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-provider-'));
  const alertsPath = path.join(tempDir, 'catalyst_alerts.json');
  const walletPath = path.join(tempDir, 'wallet_signals.json');
  writeJson(alertsPath, {
    signals: [
      {
        source: 'dexscreener',
        type: 'DEX_BOOST',
        timestamp: 100,
        token_address: 'MintB',
        sentiment_score: 0.9,
        confidence: 0.6,
        kol_reputation_score: 0,
        expires_at: 10_000,
        metadata: { boost: 0.16, signalKey: 'boost' },
      },
    ],
  });
  writeJson(walletPath, {
    buy_signals: [
      {
        mint: 'MintB',
        expired: false,
        wallets: ['walletA', 'walletB'],
        kolCount: 1,
        consensusScore: 0.82,
        walletPnlScore: 0.7,
        executable: true,
        sizeUp: true,
        priority: 'VERY_HIGH',
      },
    ],
  });

  const decision = computeAlphaBoost({
    tokenAddress: 'MintB',
    now: 500,
    catalystSignalsFile: alertsPath,
    walletSignalsFile: walletPath,
  });

  assert.equal(decision.catalystBoost, 0.16);
  assert.ok(decision.walletBoost > 0);
  assert.ok(decision.totalBoost > 0.16);
  assert.equal(decision.signalCount, 2);
});
