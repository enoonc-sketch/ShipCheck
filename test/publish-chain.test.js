// End-to-end repro of the live publish chain (0.9.2): the exact steps
// publishReleaseNotes takes, with the REAL modules and storage seeded the
// way T's site holds it (flat 0.6.0 settings, as the Settings page shows:
// one release SHIP 1.4.0, docs space TEAM, demo mode off).
//
// Background: the 0.9.0 panel is live at 67/100, but clicking Publish on
// 2026-11-17 05:15 failed with "spaceKey does not match the configured
// docs space." — while the Settings page shows the row SHIP / 1.4.0 /
// TEAM. 0.9.1 fixed the UI fallback; the 0.9.1 panel (live 06:05) then
// failed differently — "No release config found for SHIP 1.4.0" — while
// the Settings page STILL shows the row. 0.9.2 resolves the publish space
// ONCE, on the backend (resolvePublishSpace), and its error now prints
// what was searched for and which rows are saved, so the next live click
// is self-diagnosing. The panel sends only projectKey + version.
// Run: node --test test/publish-chain.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, resolvePublishSpace } from '../src/settings.js';
import { createForgeAdapter } from '../src/adapters.js';
import { assertPublishSpaceKey } from '../src/confluence.js';
import { readFile } from 'node:fs/promises';

// Minimal stand-in for @forge/api's `route` tag (same rule as the real
// one in safeUrl.js): encodes interpolated values once they appear
// after '?' — copied from test/adapters.test.js.
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

// The four real SHIP issues, in the shape Jira returns them.
const JIRA_ISSUES = [
  { key: 'SHIP-1', id: '10001', fields: { issuetype: { name: 'Story' }, status: { name: 'Done' }, priority: { name: 'Medium' }, summary: 'Add dark mode toggle' } },
  { key: 'SHIP-2', id: '10002', fields: { issuetype: { name: 'Bug' }, status: { name: 'Done' }, priority: { name: 'High' }, summary: 'Fix login crash on iOS' } },
  { key: 'SHIP-3', id: '10003', fields: { issuetype: { name: 'Story' }, status: { name: 'In Progress' }, priority: { name: 'Medium' }, summary: 'Offline sync for mobile' } },
  { key: 'SHIP-4', id: '10004', fields: { issuetype: { name: 'Bug' }, status: { name: 'To Do' }, priority: { name: 'Highest' }, summary: 'Data loss when saving offline draft' } },
];

// Fake Forge api: Jira search returns the four issues; the Confluence
// page-exists check finds page 688131 alive.
function fakeApi() {
  return {
    asApp: () => ({
      requestJira: async () => ({ ok: true, json: async () => ({ issues: JIRA_ISSUES }) }),
      requestConfluence: async () => ({ ok: true, status: 200, json: async () => ({ id: '688131' }) }),
    }),
  };
}

// Map-backed Forge Storage stand-in.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}

// Exactly what T's site holds (Settings page, 2026-11-17 05:20): flat
// 0.6.0 shape — one release SHIP 1.4.0, docs space TEAM, demo mode off,
// AI summary off, digest off, Friday, push off, Bitbucket acme/shipcheck.
const FLAT_SETTINGS = {
  projectKey: 'SHIP',
  version: '1.4.0',
  spaceKey: 'TEAM',
  demoMode: false,
  digestEnabled: false,
  digestDay: 5,
  aiSummaryEnabled: false,
  weights: { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 },
  pushEnabled: false,
  bitbucketWorkspace: 'acme',
  bitbucketRepoSlug: 'shipcheck',
  bitbucketDeployBranch: 'main',
};

test('live publish chain: flat stored settings SHIP/1.4.0/TEAM must resolve to TEAM on the backend', async () => {
  const storage = fakeStorage({
    'shipcheck:settings': FLAT_SETTINGS,
    'published-1.4.0': '688131',
  });
  // loadSettings(): normalize the stored object.
  const settings = normalizeSettings(await storage.get('shipcheck:settings'));
  assert.equal(settings.configs.length, 1, 'migration must yield exactly one config');
  assert.equal(settings.configs[0].projectKey, 'SHIP');
  assert.equal(settings.configs[0].version, '1.4.0');
  assert.equal(settings.configs[0].spaceKey, 'TEAM');

  // Backend side: fetch the real context, then resolve the publish space
  // the same way publishReleaseNotes does (0.9.2: resolvePublishSpace,
  // entered values first, then the adapter context).
  const adapter = createForgeAdapter(fakeApi(), route, storage);
  const ctx = await adapter.fetchReleaseContext({
    version: '1.4.0', projectKey: 'SHIP', settings, scenario: 'blocked',
  });
  assert.equal(ctx.demo, false, 'context must be real, not the demo seed');
  assert.equal(ctx.projectKey, 'SHIP');
  assert.equal(ctx.version, '1.4.0');
  assert.equal(ctx.issues.length, 4);

  // The panel sends only projectKey + version; the backend resolves TEAM.
  const { spaceKey } = resolvePublishSpace(settings, { projectKey: 'SHIP', version: '1.4.0' }, ctx);
  assert.equal(spaceKey, 'TEAM', 'backend must resolve the same TEAM row');

  // The P0-3 guard stays strict for a direct invoke that DOES pass a
  // space: a forged space is still refused (the panel sends none, so the
  // guard is skipped for panel clicks).
  assert.throws(
    () => assertPublishSpaceKey('WRONG', spaceKey),
    /does not match the configured docs space/,
  );
});

test('0.9.3: a release with no matching row throws the short self-diagnosing error', () => {
  // Stored configs with NO row for SHIP 1.4.0 (e.g. a stale version, or
  // the live 06:05 case where the panel said "no release config" while
  // the Settings page showed the row): the error must name the release
  // and list which rows the backend actually has — short enough for the
  // panel to show whole (the 0.9.2 wording was cut off live, 06:36).
  const settings = normalizeSettings({
    configs: [{ projectKey: 'SHIP', version: '9.9.9', spaceKey: 'TEAM' }],
    demoMode: false,
  });
  assert.throws(
    () => resolvePublishSpace(settings, { projectKey: 'SHIP', version: '1.4.0' }, { projectKey: 'SHIP', version: '1.4.0' }),
    (e) => /No release config for SHIP 1\.4\.0/.test(e.message)
      && /Saved: \["SHIP", "9\.9\.9", "TEAM"\]/.test(e.message)
      && e.message.length < 140,
  );
});

test('0.9.3: a stored row with a zero-width space still resolves (live 06:05 suspect)', () => {
  // The settings page renders a pasted zero-width space as the plain
  // key, so the row looks right while no strict comparison matches it.
  // Keys are cleaned on read, so the publish must find TEAM anyway.
  const settings = normalizeSettings({
    ...FLAT_SETTINGS,
    projectKey: 'SH\u200bIP',
  });
  const { spaceKey } = resolvePublishSpace(settings, { projectKey: 'SHIP', version: '1.4.0' }, { projectKey: 'SHIP', version: '1.4.0' });
  assert.equal(spaceKey, 'TEAM');
});

test('0.9.4: a stored space-key-only row can no longer reach the publish resolver', () => {
  // Live root cause (0.9.1/0.9.2): storage held ["", "", "TEAM"] — a row
  // with only a space key — and the backend treated it as a real config,
  // so publish failed with "No release config for SHIP 1.4.0" while the
  // Settings page showed the row. Such a row is now dropped on read, so
  // the resolver reports the honest state: nothing saved.
  const settings = normalizeSettings({ configs: [{ projectKey: '', version: '', spaceKey: 'TEAM' }] });
  assert.deepEqual(settings.configs, []);
  assert.throws(
    () => resolvePublishSpace(settings, { projectKey: 'SHIP', version: '1.4.0' }, { projectKey: 'SHIP', version: '1.4.0' }),
    (e) => /No release config for SHIP 1\.4\.0/.test(e.message) && /Saved: \(none\)/.test(e.message),
  );
});

test('0.9.2: publishReleaseNotes resolves the space via resolvePublishSpace and publishes into it', async () => {
  // Static wiring check: the resolver must call resolvePublishSpace and
  // pass the RESOLVED space to publishOrUpdatePage — never the payload's
  // space (the panel no longer sends one).
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = src.indexOf('publishReleaseNotes: async');
  assert.ok(start >= 0, 'publishReleaseNotes resolver missing');
  const end = src.indexOf('\n  getIssueContext', start);
  const body = src.slice(start, end >= 0 ? end : undefined);
  assert.match(body, /resolvePublishSpace\(/, 'resolver must resolve the space via resolvePublishSpace');
  assert.match(body, /publishOrUpdatePage\([\s\S]*?spaceKey/, 'resolver must pass a spaceKey to publishOrUpdatePage');
  assert.ok(!body.includes('spaceKey: payload.spaceKey'), 'resolver must not publish into the payload space');
});
