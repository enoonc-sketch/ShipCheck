// Tests for the ShipCheck score-history engine (pure logic, no Forge calls).
// Written FIRST, before src/history.js existed (TDD, per T's Claude-method standard).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordSnapshot,
  snapshotFromContext,
  computeTrend,
  trendLabel,
  HISTORY_STORAGE_KEY,
  MAX_HISTORY_ENTRIES,
} from '../src/history.js';

const snap = (version, score, verdict, recordedAt) => ({
  version, score, verdict, recordedAt: recordedAt ?? new Date().toISOString(),
});

test('storage key and cap constants are sane', () => {
  assert.equal(typeof HISTORY_STORAGE_KEY, 'string');
  assert.ok(HISTORY_STORAGE_KEY.length > 0);
  assert.equal(MAX_HISTORY_ENTRIES, 50);
});

test('recordSnapshot appends to empty history', () => {
  const out = recordSnapshot([], snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'));
  assert.equal(out.length, 1);
  assert.equal(out[0].version, '1.3.0');
  assert.equal(out[0].score, 80);
});

test('recordSnapshot replaces an existing entry for the same version', () => {
  const first = recordSnapshot([], snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'));
  const second = recordSnapshot(first, snap('1.3.0', 92, 'READY', '2026-11-08T00:00:00.000Z'));
  assert.equal(second.length, 1);
  assert.equal(second[0].score, 92);
  assert.equal(second[0].verdict, 'READY');
});

test('recordSnapshot keeps history sorted by recordedAt', () => {
  let h = recordSnapshot([], snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z'));
  h = recordSnapshot(h, snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'));
  assert.equal(h[0].version, '1.3.0');
  assert.equal(h[1].version, '1.4.0');
});

test('recordSnapshot caps history at MAX_HISTORY_ENTRIES, dropping the oldest', () => {
  let h = [];
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) {
    // Unique dates (2026-01-01 .. 2026-02-24) so "oldest" is unambiguous.
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    h = recordSnapshot(h, snap(`9.${i}.0`, 50 + (i % 50), 'CAUTION', day));
  }
  assert.equal(h.length, MAX_HISTORY_ENTRIES);
  assert.equal(h[0].version, '9.5.0'); // oldest five (9.0.0–9.4.0) dropped
  assert.ok(!h.some((s) => s.version === '9.0.0'));
});

test('recordSnapshot validates its input instead of storing garbage', () => {
  assert.throws(() => recordSnapshot([], { version: '', score: 50, verdict: 'CAUTION' }), /version/);
  assert.throws(() => recordSnapshot([], { version: '1.0.0', score: 101, verdict: 'READY' }), /score/);
  assert.throws(() => recordSnapshot([], { version: '1.0.0', score: -1, verdict: 'BLOCKED' }), /score/);
  assert.throws(() => recordSnapshot([], { version: '1.0.0', score: 50, verdict: 'NOPE' }), /verdict/);
});

test('recordSnapshot does not mutate the input array', () => {
  const before = [snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z')];
  const after = recordSnapshot(before, snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z'));
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});

test('computeTrend with fewer than two entries reports no comparison', () => {
  const t0 = computeTrend([]);
  assert.equal(t0.direction, 'none');
  assert.equal(t0.previous, null);
  assert.equal(t0.delta, 0);
  const t1 = computeTrend([snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z')]);
  assert.equal(t1.direction, 'none');
  assert.equal(t1.current.version, '1.4.0');
  assert.equal(t1.previous, null);
});

test('computeTrend reports up/down/flat deltas against the previous version', () => {
  const up = computeTrend([
    snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'),
    snap('1.4.0', 92, 'READY', '2026-11-16T00:00:00.000Z'),
  ]);
  assert.equal(up.direction, 'up');
  assert.equal(up.delta, 12);
  assert.equal(up.previous.version, '1.3.0');
  assert.equal(up.current.version, '1.4.0');

  const down = computeTrend([
    snap('1.3.0', 92, 'READY', '2026-11-01T00:00:00.000Z'),
    snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z'),
  ]);
  assert.equal(down.direction, 'down');
  assert.equal(down.delta, -69);

  const flat = computeTrend([
    snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'),
    snap('1.4.0', 80, 'CAUTION', '2026-11-16T00:00:00.000Z'),
  ]);
  assert.equal(flat.direction, 'flat');
  assert.equal(flat.delta, 0);
});

test('trendLabel renders a readable one-liner for every direction', () => {
  const up = computeTrend([
    snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'),
    snap('1.4.0', 92, 'READY', '2026-11-16T00:00:00.000Z'),
  ]);
  assert.match(trendLabel(up), /12 pts/);
  assert.match(trendLabel(up), /1\.3\.0/);
  const down = computeTrend([
    snap('1.3.0', 92, 'READY', '2026-11-01T00:00:00.000Z'),
    snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z'),
  ]);
  assert.match(trendLabel(down), /69 pts/);
  const none = computeTrend([snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z')]);
  assert.match(trendLabel(none), /no previous/i);
});

test('snapshotFromContext recomputes the score from the context (P0-4)', () => {
  // The snapshot must match what scoreRelease() computes from the same
  // data — a caller cannot smuggle in its own score/verdict.
  const ctx = {
    version: '1.4.0',
    demo: false,
    issues: [
      { key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' },
      { key: 'A-2', type: 'Story', status: 'In Progress', priority: 'Medium' },
      { key: 'A-3', type: 'Story', status: 'To Do', priority: 'Medium' },
    ],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
    // Forged fields on the context itself must be ignored too.
    score: 100,
    verdict: 'READY',
  };
  const snap = snapshotFromContext(ctx);
  assert.equal(snap.version, '1.4.0');
  assert.equal(snap.score, 87); // 40 + 25 + 7 (1 of 3 done) + 15
  assert.equal(snap.verdict, 'CAUTION'); // not the forged READY above
});

test('snapshotFromContext returns null for demo contexts (P0-4)', () => {
  const demo = {
    version: '1.4.0',
    demo: true,
    issues: [],
    pullRequests: [],
    deployments: [],
    docsReady: false,
  };
  assert.equal(snapshotFromContext(demo), null);
  assert.equal(snapshotFromContext(null), null);
});

// --- 0.7.0 P0-4: rules version on snapshots ---

test('0.7.0 P0-4: snapshotFromContext stamps the rules version', async () => {
  const { snapshotFromContext } = await import('../src/history.js');
  const ctx = {
    version: '1.4.0',
    demo: false,
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const snap = snapshotFromContext(ctx);
  assert.equal(snap.rules, '0.7.0-tiered+rescale:40/25/20/15');
  const custom = snapshotFromContext({ ...ctx, docsReady: false }, { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 10 });
  assert.equal(custom.rules, '0.7.0-tiered+rescale:50/20/20/10');
  assert.equal(custom.score, 90); // 50 + 20 + 20 + 0
});

test('0.7.0 P0-4: trend label flags a rules change between snapshots', () => {
  const oldSnap = { version: '1.3.0', score: 80, verdict: 'CAUTION', recordedAt: '2026-11-01T00:00:00.000Z' };
  const newSnap = {
    version: '1.4.0', score: 67, verdict: 'BLOCKED',
    recordedAt: '2026-11-16T00:00:00.000Z', rules: '0.7.0-tiered+rescale:40/25/20/15',
  };
  const label = trendLabel(computeTrend([oldSnap, newSnap]));
  assert.match(label, /13 pts/);
  assert.match(label, /规则已变：旧规则/);
  // Same rules on both sides: no flag.
  const sameRules = trendLabel(computeTrend([
    { ...oldSnap, rules: '0.7.0-tiered+rescale:40/25/20/15' },
    newSnap,
  ]));
  assert.doesNotMatch(sameRules, /规则已变/);
});

test('0.7.0 P0-4: recordSnapshot accepts a rules string, rejects a bad one', () => {
  const ok = recordSnapshot([], snap('1.4.0', 67, 'BLOCKED', '2026-11-16T00:00:00.000Z'));
  assert.equal(ok.length, 1);
  const withRules = recordSnapshot(ok, {
    version: '1.5.0', score: 90, verdict: 'READY',
    recordedAt: '2026-11-17T00:00:00.000Z', rules: '0.7.0-tiered+rescale:40/25/20/15',
  });
  assert.equal(withRules[1].rules, '0.7.0-tiered+rescale:40/25/20/15');
  assert.throws(() => recordSnapshot([], {
    version: '1.6.0', score: 90, verdict: 'READY', rules: 42,
  }), /rules/);
});

test('0.7.0 P0-4: old snapshots without rules are treated as 0.6.0', async () => {
  const { rulesOf } = await import('../src/history.js');
  assert.equal(rulesOf({ version: '1.3.0', score: 80, verdict: 'CAUTION' }), '0.6.0');
  assert.equal(rulesOf({ version: '1.4.0', score: 67, verdict: 'BLOCKED', rules: '0.7.0-tiered+rescale:40/25/20/15' }), '0.7.0-tiered+rescale:40/25/20/15');
});

// --- 0.7.0 P1-5: per-version history keys ---

test('0.7.0 P1-5: appendSnapshot keeps the last 5 of one version', async () => {
  const { appendSnapshot } = await import('../src/history.js');
  let entries = [];
  for (let i = 0; i < 7; i++) {
    entries = appendSnapshot(entries, snap('1.4.0', 60 + i, 'CAUTION', `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
  }
  assert.equal(entries.length, 5);
  assert.equal(entries[0].score, 62); // oldest two dropped
  assert.equal(entries[4].score, 66);
});

test('0.7.0 P1-5: updateVersionIndex keeps one entry per version, caps at 200', async () => {
  const { updateVersionIndex, MAX_HISTORY_VERSIONS } = await import('../src/history.js');
  let index = [];
  index = updateVersionIndex(index, snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'));
  index = updateVersionIndex(index, snap('1.4.0', 67, 'BLOCKED', '2026-11-16T00:00:00.000Z'));
  index = updateVersionIndex(index, snap('1.4.0', 75, 'CAUTION', '2026-11-17T00:00:00.000Z'));
  assert.equal(index.length, 2);
  assert.equal(index[1].version, '1.4.0');
  assert.equal(index[1].score, 75); // replaced, not duplicated
  for (let i = 0; i < MAX_HISTORY_VERSIONS + 5; i++) {
    index = updateVersionIndex(index, snap(`9.${i}.0`, 50, 'CAUTION', new Date(Date.UTC(2026, 0, 1 + i)).toISOString()));
  }
  assert.equal(index.length, MAX_HISTORY_VERSIONS);
  // The 9.x entries are dated Jan–Jul 2026, older than 1.3.0 (Nov 2026),
  // so the cap drops the oldest 9.x versions, not 1.3.0.
  assert.ok(!index.some((s) => s.version === '9.0.0'));
  assert.ok(index.some((s) => s.version === '1.3.0'));
});

test('0.7.0 P1-5: migrateLegacyHistory groups the flat array by version', async () => {
  const { migrateLegacyHistory } = await import('../src/history.js');
  const flat = [
    snap('1.3.0', 80, 'CAUTION', '2026-11-01T00:00:00.000Z'),
    snap('1.4.0', 23, 'BLOCKED', '2026-11-16T00:00:00.000Z'),
    { version: '', score: 50, verdict: 'CAUTION' }, // garbage: skipped
  ];
  const { index, perVersion } = migrateLegacyHistory(flat);
  assert.equal(index.length, 2);
  assert.equal(perVersion['1.3.0'].length, 1);
  assert.equal(perVersion['1.4.0'][0].score, 23);
  assert.deepEqual(Object.keys(perVersion).sort(), ['1.3.0', '1.4.0']);
});
