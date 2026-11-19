// Tests for the ShipCheck per-issue context (pure logic, no Forge calls).
// Written FIRST, before src/issue-context.js existed (TDD, per T's Claude-method standard).
// Powers the jira.issuePanel view: which release the issue is in, whether it
// blocks that release, and the release score it contributes to.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIssueContext } from '../src/issue-context.js';
import { fetchReleaseContext } from '../src/adapters.js';

const ctx = await fetchReleaseContext({ adapter: 'mock', version: '1.4.0' });

test('finds a normal issue and reports its release score', () => {
  const out = getIssueContext(ctx, 'SHIP-3');
  assert.equal(out.found, true);
  assert.equal(out.issue.key, 'SHIP-3');
  assert.equal(out.issue.status, 'In Progress');
  assert.equal(out.isBlocker, false);
  assert.equal(out.release.version, '1.4.0');
  assert.equal(out.release.score, 23);
  assert.equal(out.release.verdict, 'BLOCKED');
});

test('flags an open Blocker bug as a release blocker', () => {
  const out = getIssueContext(ctx, 'SHIP-9');
  assert.equal(out.found, true);
  assert.equal(out.isBlocker, true);
  assert.equal(out.blockerReason, 'Open Blocker bug');
  assert.ok(out.releaseBlockers.some((b) => b.key === 'SHIP-9'));
});

test('a Done bug is not a blocker even with Blocker priority', () => {
  const doneCtx = {
    ...ctx,
    issues: [{ key: 'SHIP-2', type: 'Bug', status: 'Done', priority: 'Blocker', summary: 'Fixed' }],
  };
  const out = getIssueContext(doneCtx, 'SHIP-2');
  assert.equal(out.found, true);
  assert.equal(out.isBlocker, false);
});

test('reports not-found instead of inventing context for an unknown key', () => {
  const out = getIssueContext(ctx, 'SHIP-404');
  assert.equal(out.found, false);
  assert.equal(out.issueKey, 'SHIP-404');
  assert.equal(out.issue, undefined);
});

test('empty release context still answers (found=false, no crash)', () => {
  const out = getIssueContext({ issues: [], pullRequests: [], deployments: [], docsReady: false, version: '0.0.0', projectKey: 'SHIP' }, 'SHIP-1');
  assert.equal(out.found, false);
});

// --- 0.7.0 P1-9: scoreDrag + linked PRs ---

test('0.7.0 P1-9: a blocker bug drags the score by 20 (blocker + issues slices)', () => {
  const out = getIssueContext(ctx, 'SHIP-9');
  assert.deepEqual(out.scoreDrag, { ifFixed: 43, delta: 20 });
});

test('0.7.0 P1-9: an ordinary open issue drags only the issues slice', () => {
  const out = getIssueContext(ctx, 'SHIP-3');
  assert.deepEqual(out.scoreDrag, { ifFixed: 28, delta: 5 });
});

test('0.7.0 P1-9: an already-Done issue has zero drag', () => {
  const out = getIssueContext(ctx, 'SHIP-1');
  assert.deepEqual(out.scoreDrag, { ifFixed: 23, delta: 0 });
});

test('0.7.0 P1-9: linked PRs match by dev-status issueKey or by title', () => {
  const linkedCtx = {
    ...ctx,
    pullRequests: [
      { id: 42, title: 'Unrelated work', state: 'OPEN', approvals: 0, checks: 'pending', matchedVia: 'devStatus', issueKey: 'SHIP-9' },
      { id: 43, title: 'Fix SHIP-3 offline sync', state: 'MERGED', approvals: 2, checks: 'pass', matchedVia: 'title' },
      { id: 44, title: 'Something else', state: 'OPEN', approvals: 0, checks: 'pending', matchedVia: 'title' },
    ],
  };
  assert.deepEqual(getIssueContext(linkedCtx, 'SHIP-9').linkedPullRequests, [
    { id: 42, title: 'Unrelated work', state: 'OPEN', matchedVia: 'devStatus' },
  ]);
  assert.deepEqual(getIssueContext(linkedCtx, 'SHIP-3').linkedPullRequests, [
    { id: 43, title: 'Fix SHIP-3 offline sync', state: 'MERGED', matchedVia: 'title' },
  ]);
  assert.deepEqual(getIssueContext(linkedCtx, 'SHIP-1').linkedPullRequests, []);
});
