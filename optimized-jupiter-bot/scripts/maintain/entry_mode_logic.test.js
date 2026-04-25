const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMicroOnlyProbeEntryOptions,
  buildMicroScoutEntryOptions,
  resolveEffectiveEntryMode,
} = require('./entry_mode_logic.ts');

test('keeps normal entry mode when micro-only is disabled', () => {
  assert.equal(
    resolveEffectiveEntryMode({ requestedEntryMode: 'normal', microOnlyMode: false }),
    'normal',
  );
});

test('maps normal entry mode to micro-scout when micro-only is enabled', () => {
  assert.equal(
    resolveEffectiveEntryMode({ requestedEntryMode: 'normal', microOnlyMode: true }),
    'micro-scout',
  );
});

test('preserves explicit micro-scout entry mode', () => {
  assert.equal(
    resolveEffectiveEntryMode({ requestedEntryMode: 'micro-scout', microOnlyMode: true }),
    'micro-scout',
  );
});

test('preserves explicit last-stand entry mode', () => {
  assert.equal(
    resolveEffectiveEntryMode({ requestedEntryMode: 'last-stand', microOnlyMode: true }),
    'last-stand',
  );
});

test('builds no micro-only probe sizing when micro-only is disabled', () => {
  assert.deepEqual(
    buildMicroOnlyProbeEntryOptions({
      requestedEntryMode: 'normal',
      microOnlyMode: false,
      microScoutConfig: {
        fixedBuySol: 0.001,
        reserveSol: 0.79,
        portfolioSizingEnabled: false,
        portfolioFraction: 1,
        maxDynamicBuySol: 0,
        stopLossPct: 6,
        maxHoldMinutes: 2,
        maxTPpct: 10,
      },
    }),
    { entryMode: 'normal' },
  );
});

test('builds micro-only probe sizing when normal entries are downshifted', () => {
  assert.deepEqual(
    buildMicroOnlyProbeEntryOptions({
      requestedEntryMode: 'normal',
      microOnlyMode: true,
      microScoutConfig: {
        fixedBuySol: 0.001,
        reserveSol: 0.79,
        portfolioSizingEnabled: false,
        portfolioFraction: 1,
        maxDynamicBuySol: 0,
        stopLossPct: 6,
        maxHoldMinutes: 2,
        maxTPpct: 10,
      },
    }),
    {
      entryMode: 'micro-scout',
      fixedBuySol: 0.001,
      reserveSol: 0.79,
      minDeploySol: 0.001,
      stopLossPct: 0.06,
      maxHoldMinutes: 2,
      maxTPpct: 0.1,
    },
  );
});

test('builds portfolio-sized micro-only probe options when enabled', () => {
  assert.deepEqual(
    buildMicroOnlyProbeEntryOptions({
      requestedEntryMode: 'normal',
      microOnlyMode: true,
      microScoutConfig: {
        fixedBuySol: 0.001,
        reserveSol: 0.05,
        portfolioSizingEnabled: true,
        portfolioFraction: 1,
        maxDynamicBuySol: 0,
        stopLossPct: 6,
        maxHoldMinutes: 2,
        maxTPpct: 10,
      },
    }),
    {
      entryMode: 'micro-scout',
      fixedBuySol: 0.001,
      reserveSol: 0.05,
      portfolioFraction: 1,
      minDeploySol: 0.001,
      stopLossPct: 0.06,
      maxHoldMinutes: 2,
      maxTPpct: 0.1,
    },
  );
});

test('builds portfolio-sized direct micro-scout options', () => {
  assert.deepEqual(
    buildMicroScoutEntryOptions({
      requestedEntryMode: 'micro-scout',
      microScoutConfig: {
        fixedBuySol: 0.001,
        reserveSol: 0.05,
        portfolioSizingEnabled: true,
        portfolioFraction: 1,
        maxDynamicBuySol: 0,
        stopLossPct: 6,
        maxHoldMinutes: 2,
        maxTPpct: 10,
      },
    }),
    {
      entryMode: 'micro-scout',
      fixedBuySol: 0.001,
      reserveSol: 0.05,
      portfolioFraction: 1,
      minDeploySol: 0.001,
      stopLossPct: 0.06,
      maxHoldMinutes: 2,
      maxTPpct: 0.1,
    },
  );
});
