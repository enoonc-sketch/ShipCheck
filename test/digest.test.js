// Tests for the ShipCheck weekly digest (pure logic, no Forge calls, no email).
// Written FIRST, before src/digest.js existed (TDD, per T's Claude-method standard).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, digestToAdf, shouldSendDigest } from '../src/digest.js';
import { scoreRelease } from '../src/scoring.js';

const result = (overrides = {}) => ({
  score: 23,
  verdict: 'BLOCKED',
  breakdown: { blockers: 0, pullRequests: 13, issuesDone: 10, docs: 0 },
  warnings: ['PR #102 is open with no approvals.', 'SHIP-3 is still In Progress.'],
  ...overrides,
});

const blockers = [
  { kind: 'bug', key: 'SHIP-9', summary: 'Data loss when saving offline draft' },
  { kind: 'deployment', key: 'dep-2', summary: 'Deployment to production failed' },
];

test('buildDigest subject names project, version, verdict and score', () => {
  const d = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: result(), blockers });
  assert.match(d.subject, /SHIP/);
  assert.match(d.subject, /1\.4\.0/);
  assert.match(d.subject, /BLOCKED/);
  assert.match(d.subject, /23\/100/);
});

test('buildDigest markdown contains score, breakdown, blockers and warnings', () => {
  const d = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: result(), blockers });
  assert.match(d.markdown, /23\/100/);
  assert.match(d.markdown, /BLOCKED/);
  assert.match(d.markdown, /SHIP-9/);
  assert.match(d.markdown, /dep-2/);
  assert.match(d.markdown, /PR #102 is open with no approvals/);
  assert.match(d.markdown, /Blockers 0/);
  assert.match(d.markdown, /PRs 13/);
});

test('buildDigest with no blockers says so instead of rendering an empty list', () => {
  const d = buildDigest({
    projectKey: 'SHIP',
    version: '2.0.0',
    result: result({ score: 100, verdict: 'READY', breakdown: { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 }, warnings: [] }),
    blockers: [],
  });
  assert.match(d.markdown, /No blockers/i);
  assert.match(d.markdown, /READY/);
});

test('buildDigest includes the version trend line when a trend is given', () => {
  const d = buildDigest({
    projectKey: 'SHIP',
    version: '1.4.0',
    result: result(),
    blockers,
    trend: { current: { version: '1.4.0', score: 23 }, previous: { version: '1.3.0', score: 80 }, delta: -57, direction: 'down' },
  });
  assert.match(d.markdown, /57 pts/);
  assert.match(d.markdown, /1\.3\.0/);
});

test('buildDigest requires project, version and a scored result', () => {
  assert.throws(() => buildDigest({ projectKey: '', version: '1.4.0', result: result(), blockers }), /projectKey/);
  assert.throws(() => buildDigest({ projectKey: 'SHIP', version: '', result: result(), blockers }), /version/);
  assert.throws(() => buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: null, blockers }), /result/);
});

test('buildDigest exposes structured blocks for the Confluence ADF render', () => {
  const d = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: result(), blockers });
  assert.equal(d.blocks.score, 23);
  assert.equal(d.blocks.verdict, 'BLOCKED');
  assert.equal(d.blocks.blockers.length, 2);
  assert.equal(d.blocks.warnings.length, 2);
  assert.equal(d.blocks.breakdown.pullRequests, 13);
});

test('digestToAdf renders valid ADF JSON containing the score and blockers', () => {
  const d = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: result(), blockers });
  const adf = JSON.parse(digestToAdf(d));
  assert.equal(adf.type, 'doc');
  assert.equal(adf.version, 1);
  const text = JSON.stringify(adf);
  assert.match(text, /23\/100/);
  assert.match(text, /SHIP-9/);
  assert.match(text, /BLOCKED/);
});

test('digestToAdf handles a clean release without a blockers section', () => {
  const d = buildDigest({
    projectKey: 'SHIP',
    version: '2.0.0',
    result: result({ score: 100, verdict: 'READY', breakdown: { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 }, warnings: [] }),
    blockers: [],
  });
  const adf = JSON.parse(digestToAdf(d));
  assert.match(JSON.stringify(adf), /No blockers/i);
  assert.match(JSON.stringify(adf), /READY/);
});

test('buildDigest output is deterministic', () => {
  const a = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: result(), blockers });
  const b = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: result(), blockers });
  assert.equal(a.subject, b.subject);
  assert.equal(a.markdown, b.markdown);
});

const settings = (overrides = {}) => ({
  digestEnabled: true,
  digestDay: 5, // Friday — just before the weekly release
  projectKey: 'SHIP',
  version: '1.4.0',
  ...overrides,
});

// 2026-11-20 is a Friday.
const friday = new Date('2026-11-20T09:00:00.000Z');
const thursday = new Date('2026-11-19T09:00:00.000Z');

test('shouldSendDigest fires on the configured weekday when enabled', () => {
  assert.equal(shouldSendDigest(settings(), friday, null), true);
});

test('shouldSendDigest does not fire on other weekdays', () => {
  assert.equal(shouldSendDigest(settings(), thursday, null), false);
});

test('shouldSendDigest does not fire when disabled', () => {
  assert.equal(shouldSendDigest(settings({ digestEnabled: false }), friday, null), false);
});

test('shouldSendDigest does not fire twice within six days', () => {
  assert.equal(shouldSendDigest(settings(), friday, '2026-11-16T09:00:00.000Z'), false);
  // Last sent a full week ago: fires again.
  assert.equal(shouldSendDigest(settings(), friday, '2026-11-13T09:00:00.000Z'), true);
});

test('shouldSendDigest does not fire without a configured release', () => {
  assert.equal(shouldSendDigest(settings({ projectKey: '' }), friday, null), false);
  assert.equal(shouldSendDigest(settings({ version: '' }), friday, null), false);
});

test('shouldSendDigest rejects an out-of-range digestDay', () => {
  assert.equal(shouldSendDigest(settings({ digestDay: 7 }), friday, null), false);
  assert.equal(shouldSendDigest(settings({ digestDay: -1 }), friday, null), false);
});

test('digest verdict and blocker list agree: unapproved PR blocks both (P0-1)', () => {
  // 0.6.0: trigger.js builds the digest from result.blockers (the same list
  // the verdict is built from), so a release blocked only by an unapproved
  // PR shows BLOCKED *and* a non-empty blocker list — never one without the other.
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 9, state: 'OPEN', approvals: 0, checks: 'pending', title: 'Unreviewed' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const scored = scoreRelease(input);
  const d = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result: scored, blockers: scored.blockers });
  assert.equal(scored.verdict, 'BLOCKED');
  assert.ok(scored.blockers.length > 0);
  assert.match(d.subject, /BLOCKED/);
  assert.match(d.markdown, /PR-9/);
});

// --- 0.7.0 P1-8: blocker diff in the digest; P1-11: push decision ---

test('0.7.0 P1-8: diffBlockers splits added, resolved and unchanged', async () => {
  const { diffBlockers } = await import('../src/digest.js');
  const prev = [
    { kind: 'bug', key: 'SHIP-4', summary: 'old' },
    { kind: 'bug', key: 'SHIP-5', summary: 'stays' },
  ];
  const cur = [
    { kind: 'bug', key: 'SHIP-5', summary: 'stays' },
    { kind: 'pullRequest', key: 'PR-9', summary: 'new' },
  ];
  const diff = diffBlockers(prev, cur);
  assert.deepEqual(diff.added.map((b) => b.key), ['PR-9']);
  assert.deepEqual(diff.resolved.map((b) => b.key), ['SHIP-4']);
  assert.deepEqual(diff.unchanged.map((b) => b.key), ['SHIP-5']);
  assert.deepEqual(diffBlockers(null, cur).added.map((b) => b.key), ['SHIP-5', 'PR-9']);
  assert.deepEqual(diffBlockers(prev, []).resolved.map((b) => b.key), ['SHIP-4', 'SHIP-5']);
});

test('0.7.0 P1-11: decidePush fires on a drop to BLOCKED or on new blockers, never otherwise', async () => {
  const { decidePush } = await import('../src/digest.js');
  assert.equal(decidePush({ previousVerdict: 'CAUTION', currentVerdict: 'BLOCKED', added: [] }), true);
  assert.equal(decidePush({ previousVerdict: 'BLOCKED', currentVerdict: 'BLOCKED', added: [{ kind: 'bug', key: 'SHIP-9' }] }), true);
  assert.equal(decidePush({ previousVerdict: 'BLOCKED', currentVerdict: 'BLOCKED', added: [] }), false);
  assert.equal(decidePush({ previousVerdict: 'BLOCKED', currentVerdict: 'CAUTION', added: [] }), false);
  assert.equal(decidePush({ previousVerdict: undefined, currentVerdict: 'BLOCKED', added: [] }), true);
});

test('0.7.0 P1-8: buildDigest renders new/resolved sections when a previous list is given', async () => {
  const { buildDigest, digestToAdf } = await import('../src/digest.js');
  const result = { score: 67, verdict: 'BLOCKED', breakdown: { blockers: 25, pullRequests: null, issuesDone: 10, docs: 15 }, warnings: [] };
  const blockers = [{ kind: 'bug', key: 'SHIP-4', summary: 'Data loss' }];
  const prev = [{ kind: 'bug', key: 'SHIP-4', summary: 'Data loss' }, { kind: 'bug', key: 'SHIP-8', summary: 'Old bug' }];
  const d = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result, blockers, previousBlockers: prev });
  assert.match(d.markdown, /New blockers since last week/);
  assert.match(d.markdown, /Resolved since last week/);
  assert.match(d.markdown, /SHIP-8/);
  assert.deepEqual(d.blocks.addedBlockers, []);
  assert.deepEqual(d.blocks.resolvedBlockers, [{ kind: 'bug', key: 'SHIP-8', summary: 'Old bug' }]);
  const adf = JSON.parse(digestToAdf(d));
  assert.ok(JSON.stringify(adf).includes('Resolved since last week'));
  // Without a previous list, no diff sections at all.
  const first = buildDigest({ projectKey: 'SHIP', version: '1.4.0', result, blockers });
  assert.doesNotMatch(first.markdown, /New blockers since last week/);
  assert.equal(first.blocks.addedBlockers, null);
});
