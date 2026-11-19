// Tests for the admin permission check (src/admin.js) — P0-3.
// The check runs against a stubbed @forge/api: no real Jira account needed.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAdmin } from '../src/admin.js';

// Minimal stand-in for the `route` template tag (no URL encoding needed
// here — the permission name has no special characters).
const route = (strings, ...values) =>
  strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '');

const apiWith = (requestJira) => ({ asUser: () => ({ requestJira }) });
const apiWithBoth = ({ asUserJira, asAppJira }) => ({
  asUser: () => ({ requestJira: asUserJira }),
  asApp: () => ({ requestJira: asAppJira }),
});
const ok = (havePermission) => ({
  ok: true,
  json: async () => ({ permissions: { ADMINISTER_JIRA: { havePermission } } }),
});
const groupsOk = (names) => ({
  ok: true,
  json: async () => names.map((name) => ({ name })),
});
const thrower = async () => { throw new Error('consent missing'); };

test('assertAdmin passes when the caller has ADMINISTER_JIRA', async () => {
  await assertAdmin(apiWith(async () => ok(true)), route);
});

test('assertAdmin rejects when the caller lacks ADMINISTER_JIRA', async () => {
  await assert.rejects(
    () => assertAdmin(apiWith(async () => ok(false)), route),
    /Jira administrator permission/,
  );
});

test('assertAdmin allows when the permissions call is not ok and nothing else can verify', async () => {
  // 0.9.3 fail-open: an asUser call that cannot even run (no consent in
  // this install) must not block the site owner from saving. A clean
  // "no" still denies (see the permission-field test below); only a
  // failure TO VERIFY allows.
  await assertAdmin(apiWith(async () => ({ ok: false, status: 403, json: async () => ({}) })), route);
});

test('assertAdmin allows when the permissions call throws and nothing else can verify', async () => {
  await assertAdmin(apiWith(async () => { throw new Error('network down'); }), route);
});

test('assertAdmin fails closed when the permission field is missing', async () => {
  await assert.rejects(
    () => assertAdmin(apiWith(async () => ({ ok: true, json: async () => ({ permissions: {} }) })), route),
    /Jira administrator permission/,
  );
});

// ---- 0.9.3: fail OPEN when the check itself cannot verify ----
// Live failure 2026-11-17 06:34: the 0.9.2 save failed with "could not
// verify Jira administrator permission" for the site owner. Both the
// asUser call (no consent in this install) and the asApp groups fallback
// failed to verify — and the old code blocked the save on that. A check
// that cannot verify must not block the only admin: the settings page
// lives under Jira's /settings/apps/, which Jira serves only to Jira
// administrators, so the page itself is the gate. A clean "no" from
// either path still denies; only a failure TO VERIFY allows.

test('assertAdmin falls back to asApp groups when the asUser call throws (site-admins)', async () => {
  const api = apiWithBoth({ asUserJira: thrower, asAppJira: async () => groupsOk(['site-admins', 'jira-software-users']) });
  await assertAdmin(api, route, 'account-123');
});

test('assertAdmin falls back to asApp groups (administrators group)', async () => {
  const api = apiWithBoth({ asUserJira: async () => ({ ok: false, status: 403, json: async () => ({}) }), asAppJira: async () => groupsOk(['administrators']) });
  await assertAdmin(api, route, 'account-123');
});

test('assertAdmin rejects when asUser throws and the asApp groups have no admin group', async () => {
  const api = apiWithBoth({ asUserJira: thrower, asAppJira: async () => groupsOk(['jira-software-users']) });
  await assert.rejects(
    () => assertAdmin(api, route, 'account-123'),
    /require Jira administrator permission/,
  );
});

test('assertAdmin does NOT fall back when asUser cleanly says no permission', async () => {
  // A definitive "no" from asUser is trusted even if the group lookup
  // would say otherwise — the fallback only covers a FAILED asUser call.
  const api = apiWithBoth({ asUserJira: async () => ok(false), asAppJira: async () => groupsOk(['site-admins']) });
  await assert.rejects(
    () => assertAdmin(api, route, 'account-123'),
    /require Jira administrator permission/,
  );
});

test('assertAdmin allows when asUser throws and no accountId is given (cannot verify — fail open)', async () => {
  const api = apiWithBoth({ asUserJira: thrower, asAppJira: async () => groupsOk(['site-admins']) });
  await assertAdmin(api, route);
});

test('assertAdmin allows when the asApp groups call throws (cannot verify — fail open)', async () => {
  const api = apiWithBoth({ asUserJira: thrower, asAppJira: thrower });
  await assertAdmin(api, route, 'account-123');
});

test('assertAdmin allows when the asApp groups call is not ok (cannot verify — fail open)', async () => {
  const api = apiWithBoth({ asUserJira: thrower, asAppJira: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  await assertAdmin(api, route, 'account-123');
});
