const test = require('node:test');
const assert = require('node:assert/strict');

const {
  uniqueJournalTargets,
  shouldJournalOrphanRecovery,
  isGhostExecutionSignature,
  shouldPersistTradeRecord,
} = require('./trade_journal_logic.ts');

test('uniqueJournalTargets collapses duplicate trade journal destinations', () => {
  const targets = uniqueJournalTargets(
    '/var/www/pcprotocol/signals/trade_journal.jsonl',
    [
      '/var/www/pcprotocol/signals/trade_journal.jsonl',
      '/var/www/pcprotocol/trade_journal.jsonl',
      '/var/www/pcprotocol/signals/archive/trade_history.jsonl',
    ],
  );

  assert.deepEqual(targets, [
    '/var/www/pcprotocol/signals/trade_journal.jsonl',
    '/var/www/pcprotocol/trade_journal.jsonl',
    '/var/www/pcprotocol/signals/archive/trade_history.jsonl',
  ]);
});

test('shouldJournalOrphanRecovery skips stale orphan recovery sells', () => {
  assert.equal(shouldJournalOrphanRecovery('orphan-recovery', false), false);
  assert.equal(shouldJournalOrphanRecovery('orphan-recovery', true), true);
  assert.equal(shouldJournalOrphanRecovery('TRAIL/STOP_HIT', false), true);
});

test('isGhostExecutionSignature catches paper and all-ones sentinels', () => {
  assert.equal(isGhostExecutionSignature('PAPER_TRADE_12345_abcd'), true);
  assert.equal(isGhostExecutionSignature('1111111111111111111111111111111111111111111111111111111111111111'), true);
  assert.equal(isGhostExecutionSignature('5Ns6cTPBHjZvDUFBF8TRQ8TWkB1aKQVK993FBfBLc5N8kcc6AeBCfA1SBshbVzuT433fpKzpTyajrxXV3mv35zU8'), false);
});

test('shouldPersistTradeRecord blocks ghost buy/sell rows in live mode only', () => {
  assert.equal(shouldPersistTradeRecord({ action: 'BUY', sig: 'PAPER_TRADE_1' }, false), false);
  assert.equal(shouldPersistTradeRecord({ action: 'SELL', sig: '1111111111111111111111111111111111111111111111111111111111111111' }, false), false);
  assert.equal(shouldPersistTradeRecord({ action: 'SELL', sig: '5Ns6cTPBHjZvDUFBF8TRQ8TWkB1aKQVK993FBfBLc5N8kcc6AeBCfA1SBshbVzuT433fpKzpTyajrxXV3mv35zU8' }, false), true);
  assert.equal(shouldPersistTradeRecord({ action: 'BUY', sig: 'PAPER_TRADE_1' }, true), true);
});
