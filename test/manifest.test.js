// Tests for manifest.yml — structural guardrails verified 2026-11-16 against
// the official Forge docs (manifest-reference + module pages). No YAML
// library is available (zero dependencies), so this asserts on the raw text
// with indentation-aware checks. Run `forge lint` on T's machine as the
// final authority — this file only guards against regressions of the three
// manifest bugs fixed in the Claude merge (0.3.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const m = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Comment lines explain the fixes and name the wrong values — strip them so
// the scope assertions only see live manifest content.
const stripped = m.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('function declarations live UNDER modules: (Function module doc example)', () => {
  // `function:` indented two spaces (a key under `modules:`), after `modules:`.
  assert.match(m, /^  function:\n/m);
  assert.ok(m.indexOf('  function:') > m.indexOf('modules:'));
  // No top-level `function:` (column 0) — it is not a documented property.
  assert.doesNotMatch(m, /^function:/m);
});

test('scheduledTrigger uses interval: day with a weekday gate (not week)', () => {
  assert.match(m, /scheduledTrigger:/);
  assert.match(m, /interval: day/);
  assert.doesNotMatch(m, /interval: week/);
  assert.match(m, /handler: trigger\.handler/);
  assert.match(m, /timeoutSeconds: 120/);
});

test('manifest has storage:app scope (required for the Storage API)', () => {
  assert.match(m, /storage:app/);
});

test('Bitbucket scopes are NOT in the manifest (Forge forbids mixing workspace + site scopes)', () => {
  // forge lint 2026-11-16: "Workspace scopes can not be used with site scopes"
  // (Atlassian community: not possible right now, ECO-223). PRs/deployments
  // are read through the Bitbucket Cloud REST API with an admin-provided
  // read-only token (external fetch, api.bitbucket.org) — no Bitbucket
  // scope is needed for that path. The manifest header comment records
  // the reason so the scopes are never "fixed" back by accident.
  assert.doesNotMatch(stripped, /read:bitbucket-repositories/);
  assert.doesNotMatch(stripped, /read:pullrequest:bitbucket/);
  assert.doesNotMatch(stripped, /read:repository:bitbucket/);
  // The reason lives in the header comment, wrapped over two lines —
  // assert the fragments (and the ECO-223 reference) separately.
  assert.match(m, /Workspace scopes can not be/);
  assert.match(m, /used with site scopes/);
  assert.match(m, /ECO-223/);
});

test('manifest has no Rovo / LLM modules', () => {
  assert.ok(!/rovo:/i.test(stripped));
  assert.ok(!/llm/i.test(stripped.replace(/No LLM/g, '')));
});

test('Custom UI resource points at the Vite build output (0.5.0 layout)', () => {
  assert.match(m, /path: static\/ui\/build/);
  const app = readFileSync(new URL('../static/ui/src/app.js', import.meta.url), 'utf8');
  assert.match(app, /from '@forge\/bridge'/);
  const vite = readFileSync(new URL('../static/ui/vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /base: '\.\/'/);
  assert.match(vite, /outDir: 'build'/);
  // The old unbundled bridge shim is gone — Vite resolves @forge/bridge.
  assert.ok(!existsSync(new URL('../static/bridge.js', import.meta.url)));
  assert.ok(!existsSync(new URL('../static/app.js', import.meta.url)));
  assert.ok(!existsSync(new URL('../static/index.html', import.meta.url)));
});

test('manifest has exactly one top-level key of each kind (no duplicates)', () => {
  // 2026-11-17 regression: a 0.9.0 header-comment edit left a second
  // `modules:` line in the file (line 115); Forge deploy failed with
  // "Map keys must be unique" (valid-yaml-required). The sandbox has no
  // YAML library, so this counts the column-0 keys by regex instead.
  // Top-level keys in a Forge manifest: modules, resources, app,
  // permissions — each exactly once.
  for (const key of ['modules', 'resources', 'app', 'permissions']) {
    const hits = (m.match(new RegExp(`^${key}:`, 'gm')) ?? []).length;
    assert.equal(hits, 1, `expected exactly one top-level ${key}:, found ${hits}`);
  }
});

test('package version is 0.9.5 (0.9.4 + admin checks on publish/AI + audit log)', () => {
  assert.equal(pkg.version, '0.9.5');
});

test('manifest allowlists hooks.slack.com for backend fetch (0.9.0, P2-3)', () => {
  // The Slack alert is posted from the Forge backend function via
  // api.fetch (src/slack.js) — no Slack scope exists, only the egress
  // entry. The scope list itself is UNCHANGED (0.7.0 freeze holds).
  assert.match(m, /- 'https:\/\/hooks\.slack\.com'/);
  assert.ok(m.indexOf("- 'https://hooks.slack.com'") > m.indexOf("- 'https://api.bitbucket.org'"));
});

test('manifest allowlists api.bitbucket.org for backend fetch (0.6.0, P0-2b/2c)', () => {
  // Bitbucket PRs + pipelines are read through the Cloud REST API with an
  // admin-provided token (external fetch) — no Bitbucket scope is used
  // (see the "Bitbucket scopes are NOT in the manifest" test above).
  assert.match(m, /- 'https:\/\/api\.bitbucket\.org'/);
  assert.ok(m.indexOf("- 'https://api.bitbucket.org'") > m.indexOf("- 'https://coarena.ai'"));
});

test('manifest has the frozen 0.7.0 scope list: granular v2 scopes + dev-info + write:jira-work, classic scopes removed', () => {
  // Confluence REST v2 endpoints require GRANULAR scopes: GET /api/v2/spaces
  // needs read:space:confluence, POST /api/v2/pages needs write:page:confluence,
  // GET /api/v2/pages/{id} needs read:page:confluence (v2 API reference,
  // "OAuth 2.0 scopes required" on each operation). 0.7.0 (P0-1) adds
  // read:page:confluence — the 0.6.0 publish 401 was exactly that missing
  // scope on the update-in-place read.
  assert.match(m, /- read:space:confluence/);
  assert.match(m, /- read:page:confluence/);
  assert.match(m, /- write:page:confluence/);
  // 0.7.0 (P0-2 freeze): write:jira-work (P1-11 Jira-comment push) and
  // read:dev-info:jira (P1-4 dev-status layer 2) are added.
  assert.match(m, /- write:jira-work/);
  assert.match(m, /- read:dev-info:jira/);
  // 0.7.0 (P0-2 freeze): the three classic Confluence scopes are REMOVED
  // — the tree has no v1 Confluence call at all (grep `/wiki/rest/api/`
  // is empty), so they are dead weight. This is the permission freeze:
  // after 0.7.0, no more scope changes without a task-book decision.
  assert.doesNotMatch(stripped, /- read:confluence-space\.summary/);
  assert.doesNotMatch(stripped, /- read:confluence-content\.summary/);
  assert.doesNotMatch(stripped, /- write:confluence-content/);
});
