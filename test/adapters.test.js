// Tests for the blockers rollup + the mock Atlassian adapter.
// The mock adapter lets the whole pipeline run locally with zero Atlassian account.
// Written FIRST, before src/blockers.js / src/adapters.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectBlockers } from '../src/blockers.js';
import { fetchReleaseContext, createForgeAdapter, jqlQuote } from '../src/adapters.js';
import mockData from '../mock-data/release-sample.json' with { type: 'json' };

test('collectBlockers finds open Blocker/Highest bugs, unapproved PRs, failed deploys', () => {
  const blockers = collectBlockers(mockData);
  const kinds = blockers.map((b) => b.kind);
  assert.ok(kinds.includes('bug'), 'open blocker bug expected');
  assert.ok(kinds.includes('pullRequest'), 'unapproved PR expected');
  assert.ok(kinds.includes('deployment'), 'failed deploy expected');
  assert.ok(blockers.every((b) => b.key && b.kind && b.summary));
});

test('collectBlockers returns empty array for an all-green release', () => {
  const green = {
    issues: [{ key: 'G-1', type: 'Story', status: 'Done', priority: 'Medium' }],
    pullRequests: [{ id: 1, state: 'MERGED', approvals: 2, checks: 'pass' }],
    deployments: [{ id: 'd1', environment: 'staging', state: 'SUCCESSFUL' }],
  };
  assert.deepEqual(collectBlockers(green), []);
});

test('mock adapter returns the sample release context without any network call', async () => {
  const ctx = await fetchReleaseContext({ adapter: 'mock', version: '1.4.0' });
  assert.ok(Array.isArray(ctx.issues) && ctx.issues.length > 0);
  assert.ok(Array.isArray(ctx.pullRequests));
  assert.ok(Array.isArray(ctx.deployments));
  assert.equal(ctx.version, '1.4.0');
});

test('mock adapter data matches the shipped sample file', async () => {
  const ctx = await fetchReleaseContext({ adapter: 'mock', version: '1.4.0' });
  assert.equal(ctx.issues.length, mockData.issues.length);
  assert.equal(ctx.pullRequests.length, mockData.pullRequests.length);
});

test('unknown adapter name throws a clear error (no silent fallback)', async () => {
  await assert.rejects(
    () => fetchReleaseContext({ adapter: 'atlassian', version: '1.4.0' }),
    /unknown adapter|not available in local mode/i,
  );
});

// --- createForgeAdapter: the JQL call (fake api, no @forge/api needed) ---

// Minimal stand-in for @forge/api's `route` tag: encodes interpolated values
// once they appear after '?' (same rule as the real one in safeUrl.js).
// Returns a plain string so the fake api can capture it.
function route(strings, ...values) {
  let mode = 'path';
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    if (strings[i].includes('?') || strings[i].includes('#')) mode = 'query';
    result += strings[i];
    if (i < values.length) result += mode === 'query' ? encodeURIComponent(values[i]) : values[i];
  }
  return result;
}

function fakeApi(capture, issues = []) {
  return {
    asApp: () => ({
      requestJira: async (url) => {
        capture.url = url;
        return { ok: true, json: async () => ({ issues }) };
      },
    }),
  };
}

const JIRA_ISSUES = [
  { key: 'SHIP-1', fields: { issuetype: { name: 'Story' }, status: { name: 'Done' }, priority: { name: 'Medium' }, summary: 'Add dark mode toggle' } },
];

test('forge adapter calls GET /rest/api/3/search/jql with quoted, URL-encoded JQL', async () => {
  const capture = {};
  const adapter = createForgeAdapter(fakeApi(capture, JIRA_ISSUES), route);
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.ok(capture.url.startsWith('/rest/api/3/search/jql?jql='), `unexpected URL: ${capture.url}`);
  assert.ok(!capture.url.includes('/rest/api/3/search?'), 'legacy /search endpoint must not be used (410 Gone)');
  const jql = decodeURIComponent(capture.url.split('jql=')[1].split('&')[0]);
  assert.equal(jql, 'project = "SHIP" AND fixVersion = "1.4.0"');
  assert.ok(capture.url.includes('fields=key,summary,status,priority,issuetype'), 'fields must be explicit (endpoint defaults to id only)');
  assert.ok(capture.url.includes('maxResults=100'));
  assert.equal(ctx.issues[0].key, 'SHIP-1');
  assert.equal(ctx.issues[0].type, 'Story');
});

test('forge adapter escapes quotes/backslashes inside JQL string values', () => {
  assert.equal(jqlQuote('1.4.0'), '"1.4.0"');
  assert.equal(jqlQuote('a"b\\c'), '"a\\"b\\\\c"');
});

test('forge adapter throws a clear error when Jira search fails', async () => {
  const failing = { asApp: () => ({ requestJira: async () => ({ ok: false, status: 410 }) }) };
  const adapter = createForgeAdapter(failing, route);
  await assert.rejects(
    () => adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} }),
    /Jira search failed: 410/,
  );
});

test('forge adapter returns the labelled demo seed when nothing is configured', async () => {
  const capture = {};
  const adapter = createForgeAdapter(fakeApi(capture), route);
  const ctx = await adapter.fetchReleaseContext({ version: '', projectKey: '', settings: {} });
  assert.equal(ctx.demo, true);
  assert.equal(ctx.demoReason, 'unconfigured');
  assert.equal(capture.url, undefined, 'no JQL call must fire without project/version');
});

test('index.js and trigger.js use the real `route` tag (plain strings throw at runtime)', () => {
  // @forge/api v5: requestJira/requestConfluence with a plain string throws
  // "You must create your route using the 'route' export..." (seen live
  // 2026-11-16). Guard the call sites, not just the adapter.
  for (const f of ['../src/index.js', '../src/trigger.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /import api, \{ route, storage \} from '@forge\/api'/);
    // 0.6.0: the adapter also takes `storage` (docsReady marker read).
    assert.match(src, /createForgeAdapter\(api, route(, storage)?\)/);
    assert.doesNotMatch(src, /request(Jira|Confluence)\('/);
  }
});

// --- 0.6.0: pagination, docsReady, Bitbucket wiring, dataSources ---

function fakeApiPages(capture, pages, fetchImpl) {
  let n = 0;
  return {
    asApp: () => ({
      requestJira: async (url) => {
        capture.urls.push(url);
        const page = pages[Math.min(n, pages.length - 1)];
        n += 1;
        return { ok: true, json: async () => page };
      },
    }),
    fetch: fetchImpl ?? (async () => ({ ok: false, status: 404, json: async () => ({}) })),
  };
}

function fakeStorage(values) {
  const reads = [];
  return {
    reads,
    get: async (key) => {
      reads.push(key);
      return values[key] ?? null;
    },
  };
}

const jiraPage = (keys, nextPageToken) => ({
  issues: keys.map((key) => ({
    key,
    fields: { issuetype: { name: 'Story' }, status: { name: 'Done' }, priority: { name: 'Medium' }, summary: `Issue ${key}` },
  })),
  nextPageToken: nextPageToken ?? null,
});

test('0.6.0 P1-1: forge adapter follows nextPageToken and merges pages', async () => {
  const capture = { urls: [] };
  const adapter = createForgeAdapter(
    fakeApiPages(capture, [jiraPage(['SHIP-1'], 'tok-2'), jiraPage(['SHIP-2'])]),
    route,
  );
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.deepEqual(ctx.issues.map((i) => i.key), ['SHIP-1', 'SHIP-2']);
  assert.equal(capture.urls.length, 2);
  assert.ok(capture.urls[1].includes('nextPageToken=tok-2'), `second page must carry the token: ${capture.urls[1]}`);
  assert.equal(ctx.truncated, false);
});

test('0.6.0 P1-1: endless pages stop at 1000 issues and mark truncated', async () => {
  const capture = { urls: [] };
  const bigPage = () => jiraPage(Array.from({ length: 100 }, (_, i) => `SHIP-${i}`), 'more');
  const adapter = createForgeAdapter(fakeApiPages(capture, [bigPage()]), route);
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(ctx.issues.length, 1000);
  assert.equal(ctx.truncated, true);
  assert.equal(capture.urls.length, 10, 'exactly 10 pages of 100');
});

test('0.6.0 P0-2a: docsReady follows the published-<version> storage marker', async () => {
  const storage = fakeStorage({ 'published-1.4.0': '688131' });
  const adapter = createForgeAdapter(fakeApiPages({ urls: [] }, [jiraPage(['SHIP-1'])]), route, storage);
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(ctx.docsReady, true);
  assert.ok(storage.reads.includes('published-1.4.0'));

  const emptyStorage = fakeStorage({});
  const adapter2 = createForgeAdapter(fakeApiPages({ urls: [] }, [jiraPage(['SHIP-1'])]), route, emptyStorage);
  const ctx2 = await adapter2.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(ctx2.docsReady, false);
});

test('0.6.0 P0-2a: demo mode never reads storage for docsReady', async () => {
  const storage = fakeStorage({ 'published-1.4.0': '688131' });
  const adapter = createForgeAdapter(fakeApiPages({ urls: [] }, [jiraPage(['SHIP-1'])]), route, storage);
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: { demoMode: true } });
  assert.equal(ctx.demo, true);
  assert.equal(storage.reads.length, 0);
});

test('0.6.0 P0-2b/c: Bitbucket wired settings call api.fetch and fill PRs + deployments', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/pullrequests?state=OPEN')) {
      return { ok: true, json: async () => ({ values: [{ id: 7, title: 'SHIP-1 fix', description: '', state: 'OPEN', source: { branch: { name: 'fix' }, commit: { hash: 'h7' } }, reviewers: [{ approved: true }] }], next: null }) };
    }
    if (url.includes('/pullrequests?state=MERGED')) {
      return { ok: true, json: async () => ({ values: [], next: null }) };
    }
    if (url.includes('/commit/h7/statuses')) {
      return { ok: true, json: async () => ({ values: [{ state: 'SUCCESSFUL' }] }) };
    }
    if (url.includes('/pipelines/')) {
      return { ok: true, json: async () => ({ values: [{ uuid: 'pl-1', target: { ref_name: 'main' }, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } }], next: null }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const adapter = createForgeAdapter(fakeApiPages({ urls: [] }, [jiraPage(['SHIP-1'])], fetchImpl), route, fakeStorage({}));
  const ctx = await adapter.fetchReleaseContext({
    version: '1.4.0',
    projectKey: 'SHIP',
    settings: { bitbucketWorkspace: 'acme', bitbucketRepoSlug: 'shipcheck', bitbucketApiToken: 'TOK' },
  });
  assert.equal(ctx.pullRequests.length, 1);
  assert.equal(ctx.pullRequests[0].id, 7);
  assert.equal(ctx.pullRequests[0].checks, 'pass');
  assert.equal(ctx.deployments.length, 1);
  assert.equal(ctx.deployments[0].state, 'SUCCESSFUL');
  assert.deepEqual(ctx.dataSources, { jira: 'live', pullRequests: 'live', deployments: 'live', docs: 'live' });
  assert.deepEqual(ctx.dataGaps, []);
});

test('0.6.0 P0-2b/c + P1-3: unwired Bitbucket leaves empty arrays, gaps empty, sources unwired', async () => {
  const adapter = createForgeAdapter(fakeApiPages({ urls: [] }, [jiraPage(['SHIP-1'])]), route, fakeStorage({}));
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.deepEqual(ctx.pullRequests, []);
  assert.deepEqual(ctx.deployments, []);
  assert.equal(ctx.docsReady, false);
  assert.deepEqual(ctx.dataSources, { jira: 'live', pullRequests: 'unwired', deployments: 'unwired', docs: 'live' });
  assert.deepEqual(ctx.dataGaps, []);
});

test('0.6.0 P0-2b: Bitbucket HTTP failure is a gap, not a thrown error', async () => {
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const adapter = createForgeAdapter(fakeApiPages({ urls: [] }, [jiraPage(['SHIP-1'])], failingFetch), route, fakeStorage({}));
  const ctx = await adapter.fetchReleaseContext({
    version: '1.4.0',
    projectKey: 'SHIP',
    settings: { bitbucketWorkspace: 'acme', bitbucketRepoSlug: 'shipcheck', bitbucketApiToken: 'TOK' },
  });
  assert.deepEqual(ctx.pullRequests, []);
  assert.deepEqual(ctx.deployments, []);
  assert.equal(ctx.dataSources.pullRequests, 'error');
  assert.equal(ctx.dataSources.deployments, 'error');
  assert.ok(ctx.dataGaps.length > 0);
  assert.equal(ctx.issues.length, 1, 'Jira data still comes through');
});

// --- 0.7.0 P1-4: dev-status layers, merge, P1-6 cache/docs, P1-10 configs ---

function mapStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (key) => (map.has(key) ? map.get(key) : null),
    set: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}

// Fake api that answers JQL, dev-status and Confluence page reads.
function fullFakeApi({ jiraIssues, devStatus, pageStatus = 200, fetchImpl }) {
  return {
    asApp: () => ({
      requestJira: async (url) => {
        if (url.includes('/rest/dev-status/')) {
          const appType = url.includes('applicationType=stash') ? 'stash' : 'bitbucket';
          const dataType = url.includes('dataType=repository') ? 'repository' : 'pullrequest';
          const entry = devStatus?.[`${appType}:${dataType}`];
          return { ok: true, json: async () => ({ detail: entry ?? [] }) };
        }
        return { ok: true, json: async () => ({ issues: jiraIssues }) };
      },
      requestConfluence: async () => {
        if (pageStatus === 200) return { ok: true, status: 200, json: async () => ({ id: '688131', version: { number: 3 } }) };
        return { ok: false, status: pageStatus, json: async () => ({}) };
      },
    }),
    fetch: fetchImpl ?? (async () => ({ ok: false, status: 404, json: async () => ({}) })),
  };
}

const jiraIssueWithId = (key, id) => ({
  key, id,
  fields: {
    issuetype: { name: 'Story' }, status: { name: 'Done' }, priority: { name: 'Medium' },
    summary: `Issue ${key}`, assignee: { displayName: 'Hailin Li' },
  },
});

test('0.7.0 P1-4: dev-status layer associates a PR with no title match', async () => {
  const { mergePullRequests, normalizeDevStatusPr, extractDevStatusCommits } = await import('../src/adapters.js');
  const raw = { id: 42, name: 'Unrelated title', status: 'OPEN' };
  const pr = normalizeDevStatusPr(raw, 'SHIP-1');
  assert.equal(pr.matchedVia, 'devStatus');
  assert.equal(pr.approvals, null);
  assert.equal(pr.checks, 'pending');
  assert.equal(normalizeDevStatusPr({}, 'SHIP-1'), null);
  assert.deepEqual(extractDevStatusCommits({
    repositories: [{ commits: [{ id: 'ABC123' }, { hash: 'def456' }] }],
  }), ['abc123', 'def456']);
  assert.deepEqual(extractDevStatusCommits({}), []);
  // Merge: an enriched record keeps its approvals over a stub.
  const merged = mergePullRequests([
    [{ id: 7, title: 'Fix', state: 'OPEN', approvals: 2, checks: 'pass', commitHash: 'h7', matchedVia: 'title' }],
    [{ id: 7, title: '', state: 'OPEN', approvals: null, checks: 'pending', matchedVia: 'devStatus', issueKey: 'SHIP-1' }],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].approvals, 2);
  assert.equal(merged[0].checks, 'pass');
  assert.equal(merged[0].commitHash, 'h7');
  assert.equal(merged[0].matchedVia, 'devStatus'); // devStatus outranks title? No — commit(3) > devStatus(2) > title(1): devStatus wins over title.
  assert.equal(merged[0].issueKey, 'SHIP-1');
});

test('0.7.0 P1-4: forge adapter pulls PRs from dev-status when Bitbucket is not configured', async () => {
  const api = fullFakeApi({
    jiraIssues: [jiraIssueWithId('SHIP-1', '10001')],
    devStatus: {
      'bitbucket:pullrequest': [{ applicationType: 'bitbucket', dataType: 'pullrequest', pullRequests: [{ id: 42, name: 'Sync work', status: 'OPEN' }] }],
      'bitbucket:repository': [{ applicationType: 'bitbucket', dataType: 'repository', repositories: [] }],
    },
  });
  const adapter = createForgeAdapter(api, route, mapStorage({}));
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(ctx.pullRequests.length, 1);
  assert.equal(ctx.pullRequests[0].id, 42);
  assert.equal(ctx.pullRequests[0].matchedVia, 'devStatus');
  assert.equal(ctx.pullRequests[0].issueKey, 'SHIP-1');
  assert.equal(ctx.dataSources.pullRequests, 'live');
  assert.equal(ctx.issues[0].assignee, 'Hailin Li');
  assert.equal(ctx.issues[0].id, '10001');
});

test('0.7.0 P1-4: unlinked dev-status (empty detail) keeps PRs unwired with a gap', async () => {
  const api = fullFakeApi({
    jiraIssues: [jiraIssueWithId('SHIP-1', '10001')],
    devStatus: { 'bitbucket:pullrequest': [], 'stash:pullrequest': [] },
  });
  const adapter = createForgeAdapter(api, route, mapStorage({}));
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.deepEqual(ctx.pullRequests, []);
  assert.equal(ctx.dataSources.pullRequests, 'unwired');
  assert.ok(ctx.dataGaps.some((g) => g.includes('No development tool is linked')));
});

test('0.7.0 P1-4: a PR whose commit is in the issue commits gets matchedVia=commit', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/pullrequests?state=OPEN')) {
      return { ok: true, json: async () => ({ values: [
        { id: 7, title: 'Misc fix', description: '', state: 'OPEN', source: { branch: { name: 'misc' }, commit: { hash: 'abc123' } }, reviewers: [] },
      ], next: null }) };
    }
    if (url.includes('/pullrequests?state=MERGED')) return { ok: true, json: async () => ({ values: [], next: null }) };
    if (url.endsWith('/pullrequests/7')) {
      return { ok: true, json: async () => ({ id: 7, title: 'Misc fix', state: 'OPEN', source: { commit: { hash: 'abc123' } }, reviewers: [] }) };
    }
    if (url.includes('/commit/abc123/statuses')) return { ok: true, json: async () => ({ values: [] }) };
    if (url.includes('/pipelines/')) return { ok: true, json: async () => ({ values: [], next: null }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // The layer-1 PR is dropped by the title filter ('Misc fix' mentions no
  // issue key), so the PR must arrive via layer 2 (dev-status) and be
  // enriched with its commit hash before layer 3 can match it.
  const api2 = fullFakeApi({
    jiraIssues: [jiraIssueWithId('SHIP-1', '10001')],
    devStatus: {
      'bitbucket:pullrequest': [{ applicationType: 'bitbucket', dataType: 'pullrequest', pullRequests: [{ id: 7, name: 'Misc fix', status: 'OPEN' }] }],
      'bitbucket:repository': [{ applicationType: 'bitbucket', dataType: 'repository', repositories: [{ commits: [{ id: 'ABC123' }] }] }],
    },
    fetchImpl,
  });
  const adapter = createForgeAdapter(api2, route, mapStorage({}));
  const ctx = await adapter.fetchReleaseContext({
    version: '1.4.0', projectKey: 'SHIP',
    settings: { bitbucketWorkspace: 'acme', bitbucketRepoSlug: 'shipcheck', bitbucketApiToken: 'TOK' },
  });
  assert.equal(ctx.pullRequests.length, 1);
  assert.equal(ctx.pullRequests[0].matchedVia, 'commit');
});

test('0.7.0 P1-6: Jira context cache serves the second load without JQL', async () => {
  const storage = mapStorage({});
  let jqlCalls = 0;
  const api = {
    asApp: () => ({
      requestJira: async (url) => {
        if (url.includes('/search/jql')) jqlCalls += 1;
        return { ok: true, json: async () => ({ issues: [jiraIssueWithId('SHIP-1', '10001')] }) };
      },
      requestConfluence: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }),
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  };
  const adapter = createForgeAdapter(api, route, storage);
  const ctx1 = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(jqlCalls, 1);
  assert.equal(ctx1.fromCache, false);
  assert.ok(ctx1.dataUpdatedAt);
  const ctx2 = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(jqlCalls, 1, 'second load must come from cache');
  assert.equal(ctx2.fromCache, true);
  const ctx3 = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {}, refresh: true });
  assert.equal(jqlCalls, 2, 'refresh forces a live fetch');
  assert.equal(ctx3.fromCache, false);
});

test('0.7.0 P1-6: a deleted release-notes page scores Docs 0 and clears the stale marker', async () => {
  const storage = mapStorage({ 'published-1.4.0': '688131' });
  const api = fullFakeApi({
    jiraIssues: [jiraIssueWithId('SHIP-1', '10001')],
    devStatus: {},
    pageStatus: 404,
  });
  const adapter = createForgeAdapter(api, route, storage);
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(ctx.docsReady, false);
  assert.ok(ctx.dataGaps.some((g) => g.includes('deleted in Confluence')));
  assert.equal(storage.map.has('published-1.4.0'), false);
  const { scoreRelease } = await import('../src/scoring.js');
  assert.equal(scoreRelease(ctx).breakdown.docs, 0);
});

test('0.7.0 P1-6: an existing release-notes page keeps Docs ready', async () => {
  const storage = mapStorage({ 'published-1.4.0': '688131' });
  const api = fullFakeApi({
    jiraIssues: [jiraIssueWithId('SHIP-1', '10001')],
    devStatus: {},
    pageStatus: 200,
  });
  const adapter = createForgeAdapter(api, route, storage);
  const ctx = await adapter.fetchReleaseContext({ version: '1.4.0', projectKey: 'SHIP', settings: {} });
  assert.equal(ctx.docsReady, true);
  assert.equal(storage.map.get('published-1.4.0'), '688131');
});

test('0.7.0 P1-10: the adapter uses the matching release config, not the payload', async () => {
  const storage = mapStorage({});
  const api = fullFakeApi({ jiraIssues: [jiraIssueWithId('SHIP-1', '10001')], devStatus: {} });
  const adapter = createForgeAdapter(api, route, storage);
  const settings = {
    demoMode: false,
    configs: [
      { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', digestEnabled: false, bitbucketWorkspace: '', bitbucketRepoSlug: '', bitbucketDeployBranch: 'main' },
      { projectKey: 'SHIP', version: '1.5.0', spaceKey: 'TEAM', digestEnabled: false, bitbucketWorkspace: '', bitbucketRepoSlug: '', bitbucketDeployBranch: 'main' },
    ],
  };
  const ctx = await adapter.fetchReleaseContext({ version: '1.5.0', projectKey: 'SHIP', settings });
  assert.equal(ctx.version, '1.5.0');
  // No config matches this version: the payload values are used instead.
  const ctx2 = await adapter.fetchReleaseContext({ version: '9.9.9', projectKey: 'SHIP', settings });
  assert.equal(ctx2.version, '9.9.9');
});
