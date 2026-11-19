// Wiring tests: the admin guard and the audit call sites in the Forge
// glue (src/index.js / src/trigger.js) — 0.9.5, Stage 0 review Q2/T2.
//
// Why static: index.js and trigger.js import @forge/api at module top
// and cannot run locally (the file header says so; node --test has no
// module-mocking hook for @forge/api in this sandbox — mock.module is
// not available on the Node 24.22.1 build here, verified 2026-11-17).
// The guard's BEHAVIOUR (clean "no" denies, failure-to-verify allows)
// is pinned behaviourally in test_admin.js; the audit module's behaviour
// is pinned in audit.test.js. These tests pin the remaining risk: that
// a resolver forgets to call the guard, calls it after doing work, or
// forgets to record the audit event. Precedent: the 0.9.2 static wiring
// test at the end of publish-chain.test.js.
// Run: node --test test/admin-wiring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexSrc = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const triggerSrc = readFileSync(new URL('../src/trigger.js', import.meta.url), 'utf8');

// Resolvers in file order; getAuditLog is last (appended by 0.9.5).
const ORDER = [
  'getReadiness', 'getBlockers', 'getReleaseNotes', 'publishReleaseNotes',
  'getIssueContext', 'getSettings', 'saveSettings', 'getAiSummary',
  'getScoreTrend', 'recordScore', 'getLatestDigest', 'getDigestStatus',
  'runDigestNow', 'getAuditLog',
];

/** Slice one resolver's body out of src/index.js. */
function bodyOf(name) {
  const start = indexSrc.indexOf(`  ${name}: async`);
  assert.ok(start >= 0, `${name} resolver missing from src/index.js`);
  let end = indexSrc.indexOf('\n});', start);
  for (let i = ORDER.indexOf(name) + 1; i < ORDER.length; i++) {
    const next = indexSrc.indexOf(`  ${ORDER[i]}: async`, start);
    if (next >= 0) { end = next; break; }
  }
  assert.ok(end > start, `could not find the end of ${name}`);
  return indexSrc.slice(start, end);
}

/** Slice the requireAdmin helper out of src/index.js. */
function requireAdminBody() {
  const start = indexSrc.indexOf('async function requireAdmin(');
  assert.ok(start >= 0, 'requireAdmin helper missing from src/index.js');
  const end = indexSrc.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of requireAdmin');
  return indexSrc.slice(start, end);
}

// The five admin-only resolvers and the action name each one audits under.
const GUARDED = [
  ['saveSettings', 'settings.save', 'loadSettings('],
  ['publishReleaseNotes', 'notes.publish', 'getContextFromJira('],
  ['getAiSummary', 'ai.summary', 'loadSettings('],
  ['runDigestNow', 'digest.run', 'runDigestNowForConfig('],
  ['getAuditLog', 'audit.read', 'readAuditEvents('],
];

for (const [name, action, firstWork] of GUARDED) {
  test(`${name} checks admin first, before any work`, () => {
    const body = bodyOf(name);
    const guard = `requireAdmin('${action}', context)`;
    assert.ok(body.includes(guard), `${name} must call ${guard}`);
    assert.ok(
      body.indexOf(guard) < body.indexOf(firstWork),
      `${name} must check admin before ${firstWork}`,
    );
  });
}

test('requireAdmin passes the caller accountId (the fail-open fallback needs it)', () => {
  const body = requireAdminBody();
  assert.match(body, /context\?\.accountId/);
  assert.match(body, /assertAdmin\(api, route, context\?\.accountId\)/);
});

test('requireAdmin audits a denied attempt and rethrows the denial', () => {
  // A denied admin attempt is itself an audit event (review T3): the
  // site owner can see WHO tried WHAT. The denial must still propagate
  // — the audit write must not swallow it.
  const body = requireAdminBody();
  assert.match(body, /recordAuditEvent\(/, 'denial must be recorded');
  assert.match(body, /ok: false/, 'denial is recorded as a failed operation');
  assert.match(body, /reason: 'admin-denied'/, 'denial carries its reason');
  assert.match(body, /throw e/, 'the denial must still be thrown after recording');
});

// The four audited operations record their outcome where the work happens.
test('publishReleaseNotes records the publish outcome in the audit log', () => {
  const body = bodyOf('publishReleaseNotes');
  assert.match(body, /recordAuditEvent\(/, 'publish must record an audit event');
  assert.ok(body.includes("'notes.publish'"), 'publish records under notes.publish');
});

test('getAiSummary records the AI call outcome (never the summary text)', () => {
  const body = bodyOf('getAiSummary');
  assert.match(body, /recordAuditEvent\(/, 'AI summary must record an audit event');
  assert.ok(body.includes("'ai.summary'"), 'AI summary records under ai.summary');
  assert.ok(!body.includes('summary: result.summary'), 'the summary text itself is never logged');
});

test('saveSettings records the save outcome in the audit log', () => {
  const body = bodyOf('saveSettings');
  assert.match(body, /recordAuditEvent\(/, 'settings save must record an audit event');
  assert.ok(body.includes("'settings.save'"), 'settings save records under settings.save');
});

test('runDigestForConfig records the digest run (manual and scheduled share this path)', () => {
  // The digest audit lives in trigger.js, not the resolver: the scheduled
  // handler and the manual "Run now" both go through runDigestForConfig.
  const start = triggerSrc.indexOf('export async function runDigestForConfig(');
  assert.ok(start >= 0, 'runDigestForConfig missing from src/trigger.js');
  const end = triggerSrc.indexOf('\nexport async function runDigestNow(', start);
  const body = triggerSrc.slice(start, end >= 0 ? end : undefined);
  assert.match(body, /recordAuditEvent\(/, 'digest runs must record an audit event');
  assert.ok(body.includes("'digest.run'"), 'digest records under digest.run');
});

test('runDigestNow passes the caller accountId through to the digest run', () => {
  // The manual run knows who clicked "Run now"; the scheduled run has no
  // caller (accountId null = scheduled). The resolver must forward it.
  const body = bodyOf('runDigestNow');
  assert.match(body, /runDigestNowForConfig\(configKey, context\?\.accountId\)/);
  assert.ok(triggerSrc.includes('runDigestNow(configKey, accountId'), 'trigger runDigestNow must accept the accountId');
  assert.ok(triggerSrc.includes('accountId'), 'trigger must forward accountId into runDigestForConfig');
});

test('getAuditLog reads the audit log through the audit module', () => {
  const body = bodyOf('getAuditLog');
  assert.match(body, /readAuditEvents\(/, 'getAuditLog must read via readAuditEvents');
});
