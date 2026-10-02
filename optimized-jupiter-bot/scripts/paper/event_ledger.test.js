const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readEventIds, appendMissingEvents } = require('./live_paper_worker');

test('event journal restart reconciliation appends only a missing durable tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-events-'));
  const file = path.join(dir, 'events.jsonl');
  const events = [{ id: 'a', type: 'open' }, { id: 'b', type: 'close' }];
  try {
    fs.writeFileSync(file, JSON.stringify(events[0]) + '\n');
    const ids = readEventIds(file);
    assert.equal(appendMissingEvents(file, events, ids), 1);
    assert.equal(appendMissingEvents(file, events, ids), 0);
    assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse), events);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('event journal reconciliation fails closed on malformed or duplicate IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-events-invalid-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    fs.writeFileSync(file, '{bad json}\n');
    assert.throws(() => readEventIds(file), /invalid_event_journal/);
    fs.rmSync(file, { force: true });
    assert.throws(() => appendMissingEvents(file, [{ id: 'a' }, { id: 'a' }]), /invalid_state_events/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
