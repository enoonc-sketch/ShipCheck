// Tests for the Bitbucket Cloud client (src/bitbucket.js) — PURE logic +
// injected fetchFn, no Forge calls, no real Bitbucket account.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPullRequests, fetchDeployments, mapChecksFromStatuses } from '../src/bitbucket.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Route-table stub: keys are URL substrings, values are responses. `calls`
// records every URL so tests can assert pagination walked the `next` link.
// NOTE: routes are matched in insertion order — put a more specific URL
// (e.g. the `page=2` link) BEFORE the prefix it extends.
function stubFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v;
    return json(404, {});
  };
  fn.calls = calls;
  return fn;
}

const PR = (overrides) => ({
  id: 1,
  title: 'Add dark mode',
  description: '',
  state: 'OPEN',
  source: { branch: { name: 'feature/dark-mode' }, commit: { hash: 'abc123' } },
  reviewers: [],
  ...overrides,
});

const base = { fetchFn: null, workspace: 'acme', repo: 'shipcheck', token: 'TOK', issueKeys: ['SHIP-1'] };

test('fetchPullRequests walks two pages via next and merges OPEN + MERGED', async () => {
  const fetchFn = stubFetch({
    'state=OPEN&page=2': json(200, {
      values: [PR({ id: 2, title: 'SHIP-1 follow-up', state: 'OPEN' })],
      next: null,
    }),
    'pullrequests?state=OPEN': json(200, {
      values: [PR({ id: 1, title: 'SHIP-1 dark mode' })],
      next: 'https://api.bitbucket.org/2.0/repositories/acme/shipcheck/pullrequests?state=OPEN&page=2',
    }),
    'pullrequests?state=MERGED': json(200, {
      values: [PR({ id: 3, title: 'SHIP-1 merged', state: 'MERGED', reviewers: [{ approved: true }] })],
      next: null,
    }),
    '/commit/abc123/statuses': json(200, { values: [{ state: 'SUCCESSFUL' }] }),
  });
  const out = await fetchPullRequests({ ...base, fetchFn });
  assert.equal(out.gap, null);
  assert.deepEqual(out.pullRequests.map((p) => p.id), [1, 2, 3]);
  assert.ok(fetchFn.calls.some((u) => u.includes('page=2')), 'expected the next page to be fetched');
});

test('fetchPullRequests counts approvals and maps commit statuses to checks', async () => {
  const fetchFn = stubFetch({
    '/pullrequests?state=OPEN': json(200, {
      values: [
        PR({ id: 1, title: 'SHIP-1 green', reviewers: [{ approved: true }, { approved: true }, { approved: false }] }),
        PR({ id: 2, title: 'SHIP-1 red', source: { branch: { name: 'x' }, commit: { hash: 'bad999' } } }),
        PR({ id: 3, title: 'SHIP-1 none', source: { branch: { name: 'x' }, commit: { hash: 'nope000' } } }),
      ],
      next: null,
    }),
    '/pullrequests?state=MERGED': json(200, { values: [], next: null }),
    '/commit/abc123/statuses': json(200, { values: [{ state: 'SUCCESSFUL' }, { state: 'SUCCESSFUL' }] }),
    '/commit/bad999/statuses': json(200, { values: [{ state: 'FAILED' }] }),
    '/commit/nope000/statuses': json(200, { values: [] }),
  });
  const out = await fetchPullRequests({ ...base, fetchFn });
  assert.equal(out.pullRequests[0].approvals, 2);
  assert.equal(out.pullRequests[0].checks, 'pass');
  assert.equal(out.pullRequests[1].checks, 'fail');
  assert.equal(out.pullRequests[2].checks, 'pending');
});

test('mapChecksFromStatuses: empty/in-progress is pending, any failure is fail', () => {
  assert.equal(mapChecksFromStatuses([]), 'pending');
  assert.equal(mapChecksFromStatuses([{ state: 'INPROGRESS' }]), 'pending');
  assert.equal(mapChecksFromStatuses([{ state: 'SUCCESSFUL' }]), 'pass');
  assert.equal(mapChecksFromStatuses([{ state: 'SUCCESSFUL' }, { state: 'STOPPED' }]), 'fail');
});

test('fetchPullRequests keeps only PRs linked to a release issue key', async () => {
  const fetchFn = stubFetch({
    '/pullrequests?state=OPEN': json(200, {
      values: [
        PR({ id: 1, title: 'SHIP-1 dark mode' }),
        PR({ id: 2, title: 'Unrelated refactor', description: 'no keys here' }),
        PR({ id: 3, title: 'Fix login', description: 'for ship-1', source: { branch: { name: 'fix' }, commit: { hash: 'h3' } } }),
        PR({ id: 4, title: 'Other', source: { branch: { name: 'feature/SHIP-1-x' }, commit: { hash: 'h4' } } }),
      ],
      next: null,
    }),
    '/pullrequests?state=MERGED': json(200, { values: [], next: null }),
    '/statuses': json(200, { values: [] }),
  });
  const out = await fetchPullRequests({ ...base, fetchFn });
  // 1: title hit; 3: description hit (case-insensitive); 4: branch hit; 2: miss.
  assert.deepEqual(out.pullRequests.map((p) => p.id), [1, 3, 4]);
});

test('fetchPullRequests returns a gap, never throws, on missing token and HTTP 500', async () => {
  const noToken = await fetchPullRequests({ ...base, token: '' });
  assert.deepEqual(noToken.pullRequests, []);
  assert.match(noToken.gap, /not configured/);
  const failing = stubFetch({
    '/pullrequests?state=OPEN': json(500, { error: { message: 'boom' } }),
  });
  const out = await fetchPullRequests({ ...base, fetchFn: failing });
  assert.deepEqual(out.pullRequests, []);
  assert.match(out.gap, /500/);
  const throwing = await fetchPullRequests({
    ...base,
    fetchFn: async () => { throw new Error('network down'); },
  });
  assert.deepEqual(throwing.pullRequests, []);
  assert.match(throwing.gap, /network down/);
});

test('fetchDeployments maps the latest run for the branch', async () => {
  const fetchFn = stubFetch({
    '/pipelines/': json(200, {
      values: [
        { uuid: 'p-new', target: { ref_name: 'main' }, state: { name: 'COMPLETED', result: { name: 'FAILED' } } },
        { uuid: 'p-old', target: { ref_name: 'main' }, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } },
        { uuid: 'p-other', target: { ref_name: 'dev' }, state: { name: 'COMPLETED', result: { name: 'FAILED' } } },
      ],
      next: null,
    }),
  });
  const out = await fetchDeployments({ fetchFn, workspace: 'acme', repo: 'shipcheck', token: 'TOK', branch: 'main' });
  assert.equal(out.gap, null);
  assert.equal(out.deployments.length, 1);
  assert.equal(out.deployments[0].id, 'p-new');
  assert.equal(out.deployments[0].environment, 'main');
  assert.equal(out.deployments[0].state, 'FAILED');
});

test('fetchDeployments maps SUCCESSFUL and reports a gap when no run exists', async () => {
  const ok = stubFetch({
    '/pipelines/': json(200, {
      values: [{ uuid: 'p1', target: { ref_name: 'main' }, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } }],
      next: null,
    }),
  });
  const good = await fetchDeployments({ fetchFn: ok, workspace: 'acme', repo: 'shipcheck', token: 'TOK', branch: 'main' });
  assert.equal(good.deployments[0].state, 'SUCCESSFUL');
  assert.equal(good.gap, null);

  const empty = stubFetch({ '/pipelines/': json(200, { values: [], next: null }) });
  const none = await fetchDeployments({ fetchFn: empty, workspace: 'acme', repo: 'shipcheck', token: 'TOK', branch: 'main' });
  assert.deepEqual(none.deployments, []);
  assert.match(none.gap, /No Bitbucket pipeline runs/);

  const missing = await fetchDeployments({ fetchFn: ok, workspace: 'acme', repo: 'shipcheck', token: '', branch: 'main' });
  assert.deepEqual(missing.deployments, []);
  assert.match(missing.gap, /not configured/);
});

// --- 0.7.0 P1-4: enrichPrFromBitbucket + commitHash on list PRs ---

test('0.7.0 P1-4: fetchPullRequests now carries commitHash and matchedVia=title', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/pullrequests?state=OPEN')) {
      return { ok: true, json: async () => ({ values: [
        { id: 7, title: 'Fix SHIP-4', state: 'OPEN', source: { branch: { name: 'fix/ship-4' }, commit: { hash: 'abc123' } }, reviewers: [{ approved: true }] },
      ], next: null }) };
    }
    if (url.includes('/pullrequests?state=MERGED')) {
      return { ok: true, json: async () => ({ values: [], next: null }) };
    }
    if (url.includes('/commit/abc123/statuses')) {
      return { ok: true, json: async () => ({ values: [{ state: 'SUCCESSFUL' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { pullRequests, gap } = await fetchPullRequests({
    fetchFn, workspace: 'acme', repo: 'shipcheck', token: 'tok', issueKeys: ['SHIP-4'],
  });
  assert.equal(gap, null);
  assert.equal(pullRequests.length, 1);
  assert.equal(pullRequests[0].commitHash, 'abc123');
  assert.equal(pullRequests[0].matchedVia, 'title');
  assert.equal(pullRequests[0].approvals, 1);
  assert.equal(pullRequests[0].checks, 'pass');
});

test('0.7.0 P1-4: enrichPrFromBitbucket returns approvals, checks and hash; null on 404', async () => {
  const { enrichPrFromBitbucket } = await import('../src/bitbucket.js');
  const fetchFn = async (url) => {
    if (url.endsWith('/pullrequests/9')) {
      return { ok: true, json: async () => ({
        id: 9, title: 'Offline sync', state: 'OPEN',
        source: { commit: { hash: 'def456' } }, reviewers: [{ approved: false }, { approved: true }],
      }) };
    }
    if (url.includes('/commit/def456/statuses')) {
      return { ok: true, json: async () => ({ values: [{ state: 'INPROGRESS' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const pr = await enrichPrFromBitbucket({ fetchFn, workspace: 'acme', repo: 'shipcheck', token: 'tok', prId: 9 });
  assert.deepEqual(pr, {
    id: 9, title: 'Offline sync', state: 'OPEN', approvals: 1, checks: 'pending', commitHash: 'def456',
  });
  assert.equal(await enrichPrFromBitbucket({ fetchFn, workspace: 'acme', repo: 'shipcheck', token: 'tok', prId: 999 }), null);
  assert.equal(await enrichPrFromBitbucket({ fetchFn, workspace: 'acme', repo: 'shipcheck', token: '', prId: 9 }), null);
});
