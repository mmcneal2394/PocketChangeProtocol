const test = require('node:test');
const assert = require('node:assert/strict');

const {
  capSyntheticRefinementCandidates,
  normalizeVelocitySelectionConfig,
  prioritizeVelocityAssessmentCandidates,
  resolveVelocityAssessmentBudget,
  selectVelocityRecoveryTier,
  shouldAllowVelocitySoftRecheck,
} = require('./velocity_selection_logic.ts');

test('normalizeVelocitySelectionConfig applies safe defaults', () => {
  const config = normalizeVelocitySelectionConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.maxSoftRechecksPerPoll, 2);
  assert.equal(config.softCooldownMaxTtlSeconds, 6);
  assert.deepEqual(config.softCooldownReasons, ['MICRO_CONTINUATION', 'TERRAIN_PRECHECK', 'ZERO_LIQ']);
  assert.equal(config.maxSyntheticRefinementCandidatesPerPoll, 6);
  assert.deepEqual(
    config.fallbackTiers.map((tier) => tier.label),
    ['tier2', 'tier3'],
  );
  assert.deepEqual(config.fallbackTiers.map((tier) => ({
    label: tier.label,
    minBuys60s: tier.minBuys60s,
    minBuyRatio60s: tier.minBuyRatio60s,
    minSolVolume60s: tier.minSolVolume60s,
    maxCandidatesPerPoll: tier.maxCandidatesPerPoll,
  })), [
    { label: 'tier2', minBuys60s: 5, minBuyRatio60s: 0.65, minSolVolume60s: 0.5, maxCandidatesPerPoll: 12 },
    { label: 'tier3', minBuys60s: 3, minBuyRatio60s: 0.6, minSolVolume60s: 0.4, maxCandidatesPerPoll: 12 },
  ]);
});

test('shouldAllowVelocitySoftRecheck allows short soft cooldowns with strong flow', () => {
  const config = normalizeVelocitySelectionConfig({});
  const allowed = shouldAllowVelocitySoftRecheck(
    { active: true, value: 'TERRAIN_PRECHECK', ttlSeconds: 4 },
    { buys60s: 10, solVolume60s: 2.2, velocity: 9 },
    config,
  );
  assert.equal(allowed, true);
});

test('shouldAllowVelocitySoftRecheck rejects hard cooldown reasons', () => {
  const config = normalizeVelocitySelectionConfig({});
  const allowed = shouldAllowVelocitySoftRecheck(
    { active: true, value: 'LOCKED', ttlSeconds: 2 },
    { buys60s: 20, solVolume60s: 4.0, velocity: 20 },
    config,
  );
  assert.equal(allowed, false);
});

test('shouldAllowVelocitySoftRecheck rejects soft cooldowns that are not close to expiry', () => {
  const config = normalizeVelocitySelectionConfig({});
  const allowed = shouldAllowVelocitySoftRecheck(
    { active: true, value: 'ZERO_LIQ', ttlSeconds: 12 },
    { buys60s: 20, solVolume60s: 4.0, velocity: 20 },
    config,
  );
  assert.equal(allowed, false);
});

test('shouldAllowVelocitySoftRecheck rejects weak flow even on soft cooldown', () => {
  const config = normalizeVelocitySelectionConfig({});
  const allowed = shouldAllowVelocitySoftRecheck(
    { active: true, value: 'MICRO_CONTINUATION', ttlSeconds: 3 },
    { buys60s: 5, solVolume60s: 0.8, velocity: 6 },
    config,
  );
  assert.equal(allowed, false);
});

test('selectVelocityRecoveryTier chooses the first fallback tier with fresh candidates', () => {
  const config = normalizeVelocitySelectionConfig({});
  const selection = selectVelocityRecoveryTier(
    [
      { mint: 'strict', buys60s: 10, buyRatio60s: 0.55, solVolume60s: 1.2, velocity: 12 },
      { mint: 'tier2a', buys60s: 6, buyRatio60s: 0.71, solVolume60s: 0.9, velocity: 9 },
      { mint: 'tier2b', buys60s: 7, buyRatio60s: 0.66, solVolume60s: 0.7, velocity: 8 },
      { mint: 'tier3', buys60s: 4, buyRatio60s: 0.8, solVolume60s: 0.6, velocity: 7 },
    ],
    { excludeMints: ['strict'], blacklist: [], heldMints: [] },
    config,
  );

  assert.equal(selection.tier?.label, 'tier2');
  assert.deepEqual(selection.candidates.map((candidate) => candidate.mint), ['tier2a', 'tier2b']);
});

test('selectVelocityRecoveryTier falls through excluded tier and returns next viable tier', () => {
  const config = normalizeVelocitySelectionConfig({});
  const selection = selectVelocityRecoveryTier(
    [
      { mint: 'tier2blocked', buys60s: 6, buyRatio60s: 0.7, solVolume60s: 0.8, velocity: 10 },
      { mint: 'tier3fresh', buys60s: 4, buyRatio60s: 0.82, solVolume60s: 0.6, velocity: 9 },
    ],
    { excludeMints: [], blacklist: ['tier2blocked'], heldMints: [] },
    config,
  );

  assert.equal(selection.tier?.label, 'tier3');
  assert.deepEqual(selection.candidates.map((candidate) => candidate.mint), ['tier3fresh']);
});

test('selectVelocityRecoveryTier uses a genuinely looser tier3 fallback than tier2', () => {
  const config = normalizeVelocitySelectionConfig({});
  const selection = selectVelocityRecoveryTier(
    [
      { mint: 'too-weak-tier3', buys60s: 2, buyRatio60s: 0.61, solVolume60s: 0.5, velocity: 8 },
      { mint: 'tier3fresh', buys60s: 3, buyRatio60s: 0.61, solVolume60s: 0.45, velocity: 8 },
    ],
    { excludeMints: [], blacklist: [], heldMints: [], skipLabels: ['tier2'] },
    config,
  );

  assert.equal(selection.tier?.label, 'tier3');
  assert.deepEqual(selection.candidates.map((candidate) => candidate.mint), ['tier3fresh']);
});

test('selectVelocityRecoveryTier can skip an already exhausted fallback tier', () => {
  const config = normalizeVelocitySelectionConfig({});
  const selection = selectVelocityRecoveryTier(
    [
      { mint: 'tier2fresh', buys60s: 6, buyRatio60s: 0.7, solVolume60s: 0.8, velocity: 10 },
      { mint: 'tier3fresh', buys60s: 4, buyRatio60s: 0.82, solVolume60s: 0.6, velocity: 9 },
    ],
    { excludeMints: [], blacklist: [], heldMints: [], skipLabels: ['tier2'] },
    config,
  );

  assert.equal(selection.tier?.label, 'tier3');
  assert.deepEqual(selection.candidates.map((candidate) => candidate.mint), ['tier3fresh', 'tier2fresh']);
});

test('selectVelocityRecoveryTier over-selects beyond per-poll cap so cooldown filtering can look deeper', () => {
  const config = normalizeVelocitySelectionConfig({});
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    mint: `tier3-${index}`,
    buys60s: 4,
    buyRatio60s: 0.82,
    solVolume60s: 0.7,
    velocity: 8 - (index % 2),
  }));

  const selection = selectVelocityRecoveryTier(
    candidates,
    { excludeMints: ['no-match'], blacklist: [], heldMints: [] },
    config,
  );

  assert.equal(selection.tier?.label, 'tier3');
  assert.equal(selection.candidates.length, 10);
});

test('resolveVelocityAssessmentBudget targets multiple eligible names when the book is underfilled', () => {
  const budget = resolveVelocityAssessmentBudget({
    underfilledBookActive: true,
    scoutCandidatesPerPoll: 8,
    currentOpenPositions: 0,
    maxOpenPositions: 10,
    currentEligibleCandidates: 3,
  });

  assert.equal(budget.underfilledBookActive, true);
  assert.equal(budget.desiredEligibleCandidates, 8);
  assert.equal(budget.additionalCandidatesNeeded, 5);
});

test('resolveVelocityAssessmentBudget stays minimal when the underfilled mode is inactive', () => {
  const budget = resolveVelocityAssessmentBudget({
    underfilledBookActive: false,
    scoutCandidatesPerPoll: 8,
    currentOpenPositions: 4,
    maxOpenPositions: 10,
    currentEligibleCandidates: 2,
  });

  assert.equal(budget.desiredEligibleCandidates, 1);
  assert.equal(budget.additionalCandidatesNeeded, 0);
});

test('prioritizeVelocityAssessmentCandidates prefers non-synthetic live candidates first', () => {
  const ordered = prioritizeVelocityAssessmentCandidates([
    { mint: 'synthetic-refine', isSynthetic: true, refinementOnly: true },
    { mint: 'live', isSynthetic: false, refinementOnly: false },
    { mint: 'synthetic-confirmed', isSynthetic: true, refinementOnly: false },
    { mint: 'live-refine', isSynthetic: false, refinementOnly: true },
  ]);

  assert.deepEqual(ordered.map((candidate) => candidate.mint), [
    'live',
    'live-refine',
    'synthetic-confirmed',
    'synthetic-refine',
  ]);
});

test('capSyntheticRefinementCandidates keeps only a bounded number of synthetic/refinement names', () => {
  const config = normalizeVelocitySelectionConfig({ maxSyntheticRefinementCandidatesPerPoll: 2 });
  const capped = capSyntheticRefinementCandidates([
    { mint: 'live-a', isSynthetic: false, refinementOnly: false },
    { mint: 'synthetic-a', isSynthetic: true, refinementOnly: true },
    { mint: 'synthetic-b', isSynthetic: true, refinementOnly: true },
    { mint: 'live-b', isSynthetic: false, refinementOnly: false },
    { mint: 'synthetic-c', isSynthetic: true, refinementOnly: true },
  ], config);

  assert.deepEqual(capped.map((candidate) => candidate.mint), [
    'live-a',
    'synthetic-a',
    'synthetic-b',
    'live-b',
  ]);
});

test('capSyntheticRefinementCandidates tightens synthetic allowance when real names are already present', () => {
  const config = normalizeVelocitySelectionConfig({ maxSyntheticRefinementCandidatesPerPoll: 6 });
  const capped = capSyntheticRefinementCandidates([
    { mint: 'live-a', isSynthetic: false, refinementOnly: false },
    { mint: 'live-b', isSynthetic: false, refinementOnly: false },
    { mint: 'live-c', isSynthetic: false, refinementOnly: false },
    { mint: 'live-d', isSynthetic: false, refinementOnly: false },
    { mint: 'synthetic-a', isSynthetic: true, refinementOnly: true },
    { mint: 'synthetic-b', isSynthetic: true, refinementOnly: true },
  ], config);

  assert.deepEqual(capped.map((candidate) => candidate.mint), [
    'live-a',
    'live-b',
    'live-c',
    'live-d',
    'synthetic-a',
  ]);
});
