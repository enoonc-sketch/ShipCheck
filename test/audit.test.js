// Tests for the audit log (src/audit.js) — 0.9.5, Stage 0 review T10.
// The review found `audit` appears 0 times in src/: settings changes,
// publishes, AI calls and digest runs left no trace. The audit module
// is pure logic + storage-injected helpers (same split as history.js),
// so it is fully testable here with a fake storage — no Forge runtime.
// Run: node --test test/audit.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_STORAGE_KEY,
  AUDIT_MAX_EVENTS,
  AUDIT_ACTIONS,
  buildAuditEvent,
  appendAuditEvent,
  recordAuditEvent,
  readAuditEvents,
} from '../src/audit.js';

// Map-backed Forge Storage stand-in (same shape as publish-chain.test.js).
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key) => (map.has(key) ? map.get(key) : null),
    set: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}

const ev = (overrides = {}) => buildAuditEvent({
  action: 'notes.publish',
  accountId: 'account-1',
  ok: true,
  detail: { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', pageId: '688131' },
  at: '2026-11-17T10:00:00.000Z',
  ...overrides,
});

test('buildAuditEvent builds a well-formed event with the fields given', () => {
  const e = ev();
  assert.equal(e.at, '2026-11-17T10:00:00.000Z');
  assert.equal(e.action, 'notes.publish');
  assert.equal(e.accountId, 'account-1');
  assert.equal(e.ok, true);
  assert.deepEqual(e.detail, { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', pageId: '688131' });
});

test('buildAuditEvent defaults: accountId null, ok true, empty detail, now as at', () => {
  const before = new Date().toISOString();
  const e = buildAuditEvent({ action: 'digest.run' });
  const after = new Date().toISOString();
  assert.equal(e.accountId, null);
  assert.equal(e.ok, true);
  assert.deepEqual(e.detail, {});
  assert.ok(e.at >= before && e.at <= after, `at ${e.at} must be between ${before} and ${after}`);
});

test('buildAuditEvent rejects an unknown action', () => {
  assert.throws(() => buildAuditEvent({ action: 'notes.delete' }), /unknown audit action/);
  assert.throws(() => buildAuditEvent({}), /unknown audit action/);
});

test('buildAuditEvent rejects a bad accountId, ok flag, or detail shape', () => {
  assert.throws(() => buildAuditEvent({ action: 'ai.summary', accountId: 42 }), /accountId/);
  assert.throws(() => buildAuditEvent({ action: 'ai.summary', ok: 'yes' }), /ok must be a boolean/);
  assert.throws(() => buildAuditEvent({ action: 'ai.summary', detail: null }), /detail must be a plain object/);
  assert.throws(() => buildAuditEvent({ action: 'ai.summary', detail: [] }), /detail must be a plain object/);
  assert.throws(() => buildAuditEvent({ action: 'ai.summary', at: 123 }), /at must be an ISO timestamp string/);
});

test('buildAuditEvent rejects secret-looking detail keys (a key must never reach the log)', () => {
  // Review T9: secrets must never be written to logs. The guard is the
  // last line of defence if a call site ever passes the wrong field.
  for (const key of ['apiKey', 'coarenaApiKey', 'bitbucketApiToken', 'token', 'secret', 'password', 'webhookUrl', 'credential']) {
    assert.throws(
      () => buildAuditEvent({ action: 'settings.save', detail: { [key]: 'x' } }),
      /must never be recorded in the audit log/,
      `detail key ${key} must be rejected`,
    );
  }
});

test('buildAuditEvent rejects nested detail values and truncates long strings', () => {
  assert.throws(() => buildAuditEvent({ action: 'settings.save', detail: { errors: ['a', 'b'] } }), /detail values must be flat/);
  assert.throws(() => buildAuditEvent({ action: 'settings.save', detail: { nested: { a: 1 } } }), /detail values must be flat/);
  const long = 'x'.repeat(600);
  const e = buildAuditEvent({ action: 'settings.save', ok: false, detail: { reason: 'validation', errors: long } });
  assert.ok(e.detail.errors.length <= 501, 'long detail strings are capped');
  assert.ok(e.detail.errors.endsWith('…'), 'truncation is marked');
});

test('appendAuditEvent appends in order, never mutates its input, and caps FIFO at max', () => {
  const first = ev({ at: '2026-11-17T10:00:00.000Z' });
  const second = ev({ at: '2026-11-17T10:01:00.000Z', action: 'ai.summary' });
  const base = [first];
  const next = appendAuditEvent(base, second);
  assert.deepEqual(base, [first], 'input must not be mutated');
  assert.deepEqual(next, [first, second]);

  // Fill to the cap, then one more: the oldest drops off.
  let list = [];
  for (let i = 0; i < AUDIT_MAX_EVENTS; i++) {
    list = appendAuditEvent(list, ev({ at: `2026-11-17T10:${String(i).padStart(2, '0')}:00.000Z` }));
  }
  assert.equal(list.length, AUDIT_MAX_EVENTS);
  const over = appendAuditEvent(list, ev({ at: '2026-11-17T11:00:00.000Z', action: 'digest.run' }));
  assert.equal(over.length, AUDIT_MAX_EVENTS);
  assert.equal(over[over.length - 1].action, 'digest.run');
  assert.equal(over[0].at, '2026-11-17T10:01:00.000Z', 'the oldest event is the one dropped');

  assert.deepEqual(appendAuditEvent([], ev(), 1), [ev()]);
});

test('recordAuditEvent writes through fake storage and readAuditEvents returns newest-first', async () => {
  const storage = fakeStorage();
  await recordAuditEvent(storage, ev({ at: '2026-11-17T10:00:00.000Z' }));
  await recordAuditEvent(storage, ev({ at: '2026-11-17T10:05:00.000Z', action: 'ai.summary', accountId: 'account-2' }));
  const stored = await storage.get(AUDIT_STORAGE_KEY);
  assert.equal(stored.length, 2, 'events are stored oldest-first');
  const read = await readAuditEvents(storage);
  assert.equal(read.length, 2);
  assert.equal(read[0].action, 'ai.summary', 'reads come back newest-first');
  assert.equal(read[1].action, 'notes.publish');
  const limited = await readAuditEvents(storage, { limit: 1 });
  assert.deepEqual(limited, [read[0]]);
});

test('recordAuditEvent starts fresh on a missing key or garbage, and readAuditEvents tolerates both', async () => {
  const storage = fakeStorage();
  await recordAuditEvent(storage, ev());
  assert.equal((await readAuditEvents(storage)).length, 1);

  const garbage = fakeStorage({ [AUDIT_STORAGE_KEY]: { not: 'a list' } });
  await recordAuditEvent(garbage, ev({ action: 'digest.run' }));
  assert.equal((await readAuditEvents(garbage)).length, 1, 'garbage is replaced, not appended to');

  assert.deepEqual(await readAuditEvents(fakeStorage()), []);
  assert.deepEqual(await readAuditEvents(fakeStorage({ [AUDIT_STORAGE_KEY]: 'junk' })), []);
});

test('recordAuditEvent never throws — a failed audit write must never break the operation', async () => {
  const failingGet = { get: async () => { throw new Error('storage down'); }, set: async () => {} };
  await recordAuditEvent(failingGet, ev());
  const failingSet = {
    get: async () => [],
    set: async () => { throw new Error('storage down'); },
  };
  await recordAuditEvent(failingSet, ev());
});

test('a full audit log stays far below the 240 KiB Forge Storage value limit', () => {
  // Worst realistic case: 100 events with the longest plausible details.
  let list = [];
  for (let i = 0; i < AUDIT_MAX_EVENTS; i++) {
    list = appendAuditEvent(list, ev({
      at: '2026-11-17T10:00:00.000Z',
      action: 'notes.publish',
      detail: { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', pageId: '688131' },
    }));
  }
  const bytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
  assert.ok(bytes < 240 * 1024, `full audit log is ${bytes} bytes, must stay under 240 KiB`);
});

test('the admin operations all have an audit action name', () => {
  // The task's four operations, plus audit.read: reading the log is not
  // itself logged (that would spam the log with its own reads), but a
  // DENIED read attempt is recorded under audit.read.
  assert.deepEqual(
    [...AUDIT_ACTIONS].sort(),
    ['ai.summary', 'audit.read', 'digest.run', 'notes.publish', 'settings.save'],
  );
});
