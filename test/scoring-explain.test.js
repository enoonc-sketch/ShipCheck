// Tests for explainScore() (0.8.0, P2-2 "why this score") — written FIRST.
// The explanation is structured facts, not rendered prose: the UI formats
// the facts through the i18n dictionary, so the backend stays language-free
// and the numbers here can never disagree with the score (same inputs,
// same deduction constants, same rescaling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainScore, scoreRelease } from '../src/scoring.js';
import { getDemoContext } from '../src/demo-seed.js';

const slice = (ex, key) => ex.slices.find((s) => s.key === key);

test('blocked demo seed (SHIP 1.4.0, 23/100): every deduction is itemised', () => {
  const ctx = getDemoContext('blocked');
  const result = scoreRelease(ctx);
  assert.equal(result.score, 23);
  const ex = explainScore(ctx, undefined, result);
  assert.equal(ex.isEmpty, false);
  assert.equal(ex.rescaled, false);

  const b = slice(ex, 'blockers');
  assert.equal(b.value, 0);
  assert.equal(b.max, 40);
  assert.equal(b.state, 'scored');
  assert.deepEqual(b.facts.bugs, ['SHIP-9']);
  assert.deepEqual(b.facts.failedDeployments, ['dep-2']);
  assert.deepEqual(b.facts.unapprovedPrs, ['PR-102']);

  const pr = slice(ex, 'pullRequests');
  assert.equal(pr.value, 13);
  assert.equal(pr.max, 25);
  assert.deepEqual(pr.facts, { total: 2, good: 1, unapproved: ['PR-102'] });

  const iss = slice(ex, 'issuesDone');
  assert.equal(iss.value, 10);
  assert.equal(iss.max, 20);
  assert.deepEqual(iss.facts, { done: 2, total: 4 });

  const docs = slice(ex, 'docs');
  assert.equal(docs.value, 0);
  assert.equal(docs.max, 15);
  assert.equal(docs.facts.ready, false);
});

test('ready demo seed (2.0.0, 100/100): full marks, no deductions', () => {
  const ctx = getDemoContext('ready');
  const result = scoreRelease(ctx);
  assert.equal(result.score, 100);
  const ex = explainScore(ctx, undefined, result);
  assert.equal(slice(ex, 'blockers').value, 40);
  assert.deepEqual(slice(ex, 'blockers').facts, { bugs: [], failedDeployments: [], unapprovedPrs: [] });
  assert.equal(slice(ex, 'pullRequests').value, 25);
  assert.deepEqual(slice(ex, 'pullRequests').facts, { total: 2, good: 2, unapproved: [] });
  assert.equal(slice(ex, 'issuesDone').value, 20);
  assert.deepEqual(slice(ex, 'issuesDone').facts, { done: 4, total: 4 });
  assert.equal(slice(ex, 'docs').value, 15);
  assert.equal(slice(ex, 'docs').facts.ready, true);
});

test('empty demo seed (0.0.0): slices are 0 but the empty rule is flagged', () => {
  const ctx = getDemoContext('empty');
  const result = scoreRelease(ctx);
  assert.equal(result.score, 0);
  const ex = explainScore(ctx, undefined, result);
  assert.equal(ex.isEmpty, true);
  assert.equal(slice(ex, 'blockers').value, 40);
  assert.equal(slice(ex, 'pullRequests').value, 0);
  assert.equal(slice(ex, 'issuesDone').value, 0);
  assert.equal(slice(ex, 'docs').value, 0);
});

test('real SHIP 1.4.0 shape (PRs/deployments unwired): excluded slice is null, score 67', () => {
  const ctx = {
    issues: [
      { key: 'SHIP-1', priority: 'Medium', status: 'Done', summary: 'Add dark mode toggle', type: 'Story' },
      { key: 'SHIP-2', priority: 'High', status: 'Done', summary: 'Fix login crash on iOS', type: 'Bug' },
      { key: 'SHIP-3', priority: 'Medium', status: 'In Progress', summary: 'Offline sync for mobile', type: 'Story' },
      { key: 'SHIP-4', priority: 'Highest', status: 'To Do', summary: 'Data loss when saving offline draft', type: 'Bug' },
    ],
    pullRequests: [],
    deployments: [],
    docsReady: true,
    dataSources: { jira: 'live', pullRequests: 'unwired', deployments: 'unwired', docs: 'live' },
  };
  const result = scoreRelease(ctx);
  assert.equal(result.score, 67);
  const ex = explainScore(ctx, undefined, result);
  assert.equal(ex.rescaled, true);
  const b = slice(ex, 'blockers');
  assert.equal(b.value, 25);
  assert.deepEqual(b.facts.bugs, ['SHIP-4']);
  const pr = slice(ex, 'pullRequests');
  assert.equal(pr.value, null);
  assert.equal(pr.state, 'excluded');
  assert.equal(slice(ex, 'issuesDone').value, 10);
  assert.equal(slice(ex, 'docs').value, 15);
});

test('explainScore works without a precomputed result (computes it itself)', () => {
  const ex = explainScore(getDemoContext('ready'));
  assert.equal(slice(ex, 'blockers').value, 40);
  assert.equal(slice(ex, 'docs').facts.ready, true);
});

test('custom weights flow through to the explanation maxima', () => {
  const ex = explainScore(getDemoContext('ready'), { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 10 });
  assert.equal(slice(ex, 'blockers').max, 50);
  assert.equal(slice(ex, 'pullRequests').max, 20);
  assert.equal(slice(ex, 'docs').max, 10);
});
