// Tests for the ShipCheck readiness-score engine (pure logic, no Atlassian calls).
// Written FIRST, before src/scoring.js existed (TDD, per T's Claude-method standard).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRelease,
  READINESS_WEIGHTS,
  verdictFor,
} from '../src/scoring.js';
import { collectBlockers } from '../src/blockers.js';

const baseInput = () => ({
  issues: [
    { key: 'SHIP-1', type: 'Story', status: 'Done', priority: 'Medium' },
    { key: 'SHIP-2', type: 'Bug', status: 'Done', priority: 'High' },
    { key: 'SHIP-3', type: 'Story', status: 'In Progress', priority: 'Medium' },
  ],
  pullRequests: [
    { id: 1, state: 'MERGED', approvals: 2, checks: 'pass' },
    { id: 2, state: 'OPEN', approvals: 0, checks: 'pending' },
  ],
  deployments: [
    { id: 'd1', environment: 'staging', state: 'SUCCESSFUL' },
  ],
  docsReady: true,
});

test('weights sum to 100', () => {
  const total = Object.values(READINESS_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test('all-green release scores 100 and verdict READY', () => {
  const input = {
    issues: [
      { key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' },
      { key: 'A-2', type: 'Bug', status: 'Done', priority: 'Low' },
    ],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const r = scoreRelease(input);
  assert.equal(r.score, 100);
  assert.equal(r.verdict, 'READY');
  assert.deepEqual(r.blockers, []);
});

test('open Blocker bug forces BLOCKED verdict regardless of score', () => {
  const input = baseInput();
  input.issues.push({ key: 'SHIP-9', type: 'Bug', status: 'To Do', priority: 'Blocker' });
  const r = scoreRelease(input);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blockers.some((b) => b.key === 'SHIP-9'));
});

test('failed deployment is a blocker and verdict BLOCKED', () => {
  const input = baseInput();
  input.deployments = [{ id: 'd1', environment: 'staging', state: 'FAILED' }];
  const r = scoreRelease(input);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blockers.some((b) => b.kind === 'deployment'));
});

test('unfinished non-blocker work lowers score but stays CAUTION, not BLOCKED', () => {
  // baseInput() has an unapproved OPEN PR (#2), which IS a hard blocker
  // since 0.6.0 (unified collectBlockers) — give it one approval here so
  // the only unfinished work is the in-progress story (its checks are
  // still pending, so the PR slice stays partial and the score stays
  // CAUTION rather than jumping to READY).
  const input = baseInput();
  input.pullRequests[1].approvals = 1;
  const r = scoreRelease(input);
  assert.ok(r.score > 0 && r.score < 100);
  assert.equal(r.verdict, 'CAUTION');
  assert.deepEqual(r.blockers, []);
  assert.ok(r.warnings.length > 0);
});

test('unapproved open PR is a hard blocker: verdict BLOCKED, PR slice 0, warning kept', () => {
  // 0.6.0 (P0-1): the only fault is one OPEN PR with no approvals — the
  // verdict must be BLOCKED and the blockers list must contain it, while
  // the 40-pt blockers slice is untouched (unapproved PRs block the
  // verdict but do not deduct from that slice).
  // 0.7.0 (P1-1, T approved tiered deductions): the unapproved PR now
  // deducts 5 from the blockers slice, so this input scores 70, not 75.
  // (The 0.7.0 task book's example said 95 — that was an arithmetic slip:
  // 35 + 0 + 20 + 15 = 70; a 95 would need the PR slice to be 25, which
  // an unapproved PR can never earn. The rule is right, the example was
  // wrong; see TEST-REPORT.md 0.7.0.)
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 9, state: 'OPEN', approvals: 0, checks: 'pending', title: 'Unreviewed' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const r = scoreRelease(input);
  assert.equal(r.score, 70); // 35 + 0 + 20 + 15
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.blockers.some((b) => b.kind === 'pullRequest' && b.key === 'PR-9'));
  assert.equal(r.breakdown.blockers, 35);
  assert.equal(r.breakdown.pullRequests, 0);
  assert.ok(r.warnings.some((w) => w.includes('PR #9')));
});

test('scoreRelease blockers equal collectBlockers output (single entry point)', () => {
  // The verdict and the blockers list must never disagree: scoreRelease
  // must return exactly what collectBlockers() returns for the same input.
  const input = baseInput();
  input.issues.push({ key: 'SHIP-9', type: 'Bug', status: 'To Do', priority: 'Blocker' });
  input.deployments = [{ id: 'd1', environment: 'production', state: 'FAILED' }];
  const r = scoreRelease(input);
  assert.deepEqual(r.blockers, collectBlockers(input));
  assert.equal(r.verdict, 'BLOCKED');
});

test('empty release (no issues, no PRs, no deployments) scores 0 and is BLOCKED', () => {
  const r = scoreRelease({ issues: [], pullRequests: [], deployments: [], docsReady: false });
  assert.equal(r.score, 0);
  assert.equal(r.verdict, 'BLOCKED');
});

test('missing docsReady costs exactly the docs weight', () => {
  const green = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 1, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const noDocs = { ...green, docsReady: false };
  assert.equal(scoreRelease(green).score - scoreRelease(noDocs).score, READINESS_WEIGHTS.docs);
});

test('verdictFor thresholds: >=90 READY, >=60 CAUTION, else BLOCKED', () => {
  assert.equal(verdictFor(100, []), 'READY');
  assert.equal(verdictFor(90, []), 'READY');
  assert.equal(verdictFor(89, []), 'CAUTION');
  assert.equal(verdictFor(60, []), 'CAUTION');
  assert.equal(verdictFor(59, []), 'BLOCKED');
  // any hard blocker overrides even a 100 score
  assert.equal(verdictFor(100, [{ key: 'X-1', kind: 'bug' }]), 'BLOCKED');
});

test('score is deterministic: same input twice gives identical output', () => {
  const a = scoreRelease(baseInput());
  const b = scoreRelease(baseInput());
  assert.deepEqual(a, b);
});

test('truncated input adds a page-limit warning (P1-1)', () => {
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 1, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
    truncated: true,
  };
  const r = scoreRelease(input);
  assert.ok(r.warnings.some((w) => w.includes('first 1000 issues')));
  assert.equal(scoreRelease({ ...input, truncated: false }).warnings.some((w) => w.includes('first 1000')), false);
});

test('score never goes below 0 or above 100', () => {
  const input = baseInput();
  input.issues.push(
    { key: 'B-1', type: 'Bug', status: 'To Do', priority: 'Blocker' },
    { key: 'B-2', type: 'Bug', status: 'To Do', priority: 'Highest' },
  );
  input.deployments = [{ id: 'd1', environment: 'staging', state: 'FAILED' }];
  input.docsReady = false;
  const r = scoreRelease(input);
  assert.ok(r.score >= 0 && r.score <= 100);
});

// --- 0.7.0 P1-1: tiered blocker deductions (T approved) ---

test('0.7.0 P1-1: one blocker bug deducts 15 (slice 25), one failed deployment 20', () => {
  const oneBug = {
    issues: [
      { key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' },
      { key: 'A-2', type: 'Bug', status: 'To Do', priority: 'Blocker' },
    ],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const r = scoreRelease(oneBug);
  assert.equal(r.breakdown.blockers, 25);
  assert.equal(r.verdict, 'BLOCKED'); // hard rule unchanged

  const oneDep = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'production', state: 'FAILED' }],
    docsReady: true,
  };
  assert.equal(scoreRelease(oneDep).breakdown.blockers, 20);
});

test('0.7.0 P1-1: three blockers (2 bugs + 1 failed deploy) deduct the full 40', () => {
  const input = baseInput();
  input.issues.push(
    { key: 'B-1', type: 'Bug', status: 'To Do', priority: 'Blocker' },
    { key: 'B-2', type: 'Bug', status: 'To Do', priority: 'Highest' },
  );
  input.deployments = [{ id: 'd1', environment: 'production', state: 'FAILED' }];
  const r = scoreRelease(input);
  assert.equal(r.breakdown.blockers, 0); // 15 + 15 + 20 = 50, floored at 40
  assert.equal(r.verdict, 'BLOCKED');
});

test('0.7.0 P1-1: demo blocked seed still scores 23/100 (deductions exactly 40)', () => {
  // 2 blocker bugs are not in the seed — it has 1 bug (-15) + 1 failed
  // deploy (-20) + 1 unapproved PR (-5) = 40, so the slice stays 0 and
  // the total stays 0 + 13 + 10 + 0 = 23.
  const seed = {
    issues: [
      { key: 'SHIP-1', type: 'Story', status: 'Done', priority: 'Medium' },
      { key: 'SHIP-2', type: 'Bug', status: 'Done', priority: 'High' },
      { key: 'SHIP-3', type: 'Story', status: 'In Progress', priority: 'Medium' },
      { key: 'SHIP-9', type: 'Bug', status: 'To Do', priority: 'Blocker' },
    ],
    pullRequests: [
      { id: 101, state: 'MERGED', approvals: 2, checks: 'pass' },
      { id: 102, state: 'OPEN', approvals: 0, checks: 'pending' },
    ],
    deployments: [
      { id: 'dep-1', environment: 'staging', state: 'SUCCESSFUL' },
      { id: 'dep-2', environment: 'production', state: 'FAILED' },
    ],
    docsReady: false,
  };
  const r = scoreRelease(seed);
  assert.equal(r.score, 23);
  assert.equal(r.verdict, 'BLOCKED');
  assert.deepEqual(
    [r.breakdown.blockers, r.breakdown.pullRequests, r.breakdown.issuesDone, r.breakdown.docs],
    [0, 13, 10, 0],
  );
});

// --- 0.7.0 P1-2: rescaling over connected slices only ---

const liveSources = { jira: 'live', pullRequests: 'live', deployments: 'live', docs: 'live' };

test('0.7.0 P1-2: unwired PRs are excluded, the rest rescale to 100', () => {
  // Real SHIP 1.4.0: SHIP-4 blocker bug (-15), PRs unwired, 2/4 issues
  // done, docs ready. (25 + 10 + 15) / 75 * 100 = 66.67 -> 67.
  const input = {
    issues: [
      { key: 'SHIP-1', type: 'Story', status: 'Done', priority: 'Medium' },
      { key: 'SHIP-2', type: 'Bug', status: 'Done', priority: 'High' },
      { key: 'SHIP-3', type: 'Story', status: 'In Progress', priority: 'Medium' },
      { key: 'SHIP-4', type: 'Bug', status: 'To Do', priority: 'Highest' },
    ],
    pullRequests: [],
    deployments: [],
    docsReady: true,
    dataSources: { jira: 'live', pullRequests: 'unwired', deployments: 'unwired', docs: 'live' },
  };
  const r = scoreRelease(input);
  assert.equal(r.score, 67);
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.breakdown.blockers, 25);
  assert.equal(r.breakdown.pullRequests, null);
  assert.equal(r.breakdown.issuesDone, 10);
  assert.equal(r.breakdown.docs, 15);
  assert.equal(r.rescaled, true);
  assert.equal(r.coverage.connected, 3);
  assert.equal(r.coverage.label, 'Based on 3/4 data sources');
});

test('0.7.0 P1-2: all sources connected scores exactly as before (no rescale)', () => {
  const input = { ...baseInput(), dataSources: liveSources };
  const r = scoreRelease(input);
  assert.equal(r.rescaled, false);
  assert.equal(r.coverage.connected, 4);
  // baseInput: 1 unapproved PR (-5) -> blockers 35; PRs 1/2 good -> 13;
  // issues 2/3 done -> 13; docs 15. Total 76.
  assert.equal(r.score, 76);
  assert.equal(r.verdict, 'BLOCKED');
});

test('0.7.0 P1-2: a connected slice scoring 0 is NOT excluded', () => {
  // PRs connected but all bad: slice is a measured 0, still in the total.
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'OPEN', approvals: 0, checks: 'pending' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
    dataSources: liveSources,
  };
  const r = scoreRelease(input);
  assert.equal(r.breakdown.pullRequests, 0);
  assert.equal(r.rescaled, false);
  assert.equal(r.score, 70); // 35 + 0 + 20 + 15
});

test('0.7.0 P1-2: empty release still scores 0, never rescales', () => {
  const r = scoreRelease({
    issues: [], pullRequests: [], deployments: [], docsReady: false,
    dataSources: { jira: 'live', pullRequests: 'unwired', deployments: 'unwired', docs: 'live' },
  });
  assert.equal(r.score, 0);
  assert.equal(r.verdict, 'BLOCKED');
});

test('0.7.0 P1-2: demo sources count as connected (demo seed unchanged)', () => {
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
    dataSources: { jira: 'demo', pullRequests: 'demo', deployments: 'demo', docs: 'demo' },
  };
  const r = scoreRelease(input);
  assert.equal(r.score, 100);
  assert.equal(r.rescaled, false);
});

// --- 0.7.0 P1-3: configurable weights ---

test('0.7.0 P1-3: custom weights rescale the slices', () => {
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: false,
  };
  const weights = { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 10 };
  const r = scoreRelease(input, weights);
  assert.deepEqual(
    [r.breakdown.blockers, r.breakdown.pullRequests, r.breakdown.issuesDone, r.breakdown.docs],
    [50, 20, 20, 0],
  );
  assert.equal(r.score, 90);
});

test('0.7.0 P1-3: invalid weights fall back to the defaults', () => {
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  assert.equal(scoreRelease(input, { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 5 }).score, 100);
  assert.equal(scoreRelease(input, { blockers: 'x', pullRequests: 25, issuesDone: 20, docs: 15 }).score, 100);
  assert.equal(scoreRelease(input, null).score, 100);
});

// --- 0.7.0 P1-7: "what's missing" todos ---

test('0.7.0 P1-7: real SHIP 1.4.0 todos are ordered with correct gains', () => {
  const input = {
    issues: [
      { key: 'SHIP-1', type: 'Story', status: 'Done', priority: 'Medium' },
      { key: 'SHIP-2', type: 'Bug', status: 'Done', priority: 'High' },
      { key: 'SHIP-3', type: 'Story', status: 'In Progress', priority: 'Medium' },
      { key: 'SHIP-4', type: 'Bug', status: 'To Do', priority: 'Highest' },
    ],
    pullRequests: [],
    deployments: [],
    docsReady: true,
    dataSources: { jira: 'live', pullRequests: 'unwired', deployments: 'unwired', docs: 'live' },
  };
  const r = scoreRelease(input);
  assert.equal(r.score, 67);
  assert.equal(r.todos.length, 2);
  assert.equal(r.todos[0].key, 'SHIP-4');
  // Fixing SHIP-4 clears its 15-pt blocker deduction AND makes it Done
  // (issues 2/4 -> 3/4, slice 10 -> 15): (40+15+15)/75*100 = 93.33
  // -> 93, gain 26. The task book's example said +20 (to 87) — it
  // counted only the blocker slice and forgot the bug is also an issue
  // that becomes Done; the rule (re-score the fixed context) is right,
  // the book's number was a slip. See TEST-REPORT.md 0.7.0.
  assert.equal(r.todos[0].gain, 26); // fixed -> 93
  assert.equal(r.todos[1].key, 'SHIP-3');
  assert.equal(r.todos[1].gain, 6); // done -> 73
  // PRs are unwired, so no PR todo can be computed for them.
  assert.ok(!r.todos.some((t) => t.kind === 'pullRequest'));
});

test('0.7.0 P1-7: all-green release has an empty todo list', () => {
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  assert.deepEqual(scoreRelease(input).todos, []);
});

test('0.7.0 P1-7: unapproved PR todo gains exactly its 5-pt deduction', () => {
  const input = {
    issues: [{ key: 'A-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 9, state: 'OPEN', approvals: 0, checks: 'pending', title: 'Unreviewed' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
    docsReady: true,
  };
  const r = scoreRelease(input);
  assert.equal(r.score, 70);
  assert.equal(r.todos.length, 1);
  assert.equal(r.todos[0].key, 'PR-9');
  assert.equal(r.todos[0].gain, 5); // approved -> 75
});
