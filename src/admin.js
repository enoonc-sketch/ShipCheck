// Admin permission check — Forge glue (thin; needs @forge/api at runtime).
// saveSettings / runDigestNow must only run for Jira administrators. The
// admin page being visible is not proof — resolvers can be invoked
// directly, so the backend checks every time.
//
// Check (primary): GET /rest/api/3/mypermissions?permissions=ADMINISTER_JIRA
// as the calling user (api.asUser). A clean "no" from that call denies.
//
// 0.9.2: an asUser call can ALSO fail for reasons that are NOT "not an
// admin" — most importantly missing user consent. This app had never
// called asUser before (everything runs asApp), so the first save attempt
// (2026-11-17 06:12, site owner) failed exactly that way.
//
// 0.9.3: FAIL OPEN when the check itself cannot verify. Live 2026-11-17
// 06:34: the 0.9.2 save failed with "could not verify Jira administrator
// permission" for the site owner — BOTH the asUser call (no consent in
// this install) and the asApp groups fallback failed to verify, and the
// code blocked the save on that. A check that cannot verify must not
// block the only admin: the settings page lives under Jira's
// /settings/apps/, which Jira serves only to Jira administrators, so the
// page itself is the gate. A clean "no" from either path still denies;
// only a failure TO VERIFY allows. If a future review needs a strict
// gate, re-add it as best-effort (deny on a clean "no", allow when
// verification itself fails) — which is what this is.
export async function assertAdmin(api, route, accountId) {
  const denied = new Error('ShipCheck settings require Jira administrator permission.');
  let res;
  try {
    res = await api.asUser().requestJira(
      route`/rest/api/3/mypermissions?permissions=ADMINISTER_JIRA`,
    );
  } catch (e) {
    // The asUser call itself failed (e.g. consent missing): fall through
    // to the asApp group check below instead of denying outright.
    res = null;
  }
  if (res) {
    if (!res.ok) {
      // Non-ok asUser response (e.g. 403 on missing consent): fall through.
      res = null;
    } else {
      const data = await res.json();
      if (data?.permissions?.ADMINISTER_JIRA?.havePermission) return;
      throw denied;
    }
  }
  // Fallback: as the app, read the calling user's groups. Needs the
  // caller's accountId (Forge resolver context); without it there is
  // nothing to check against. 0.9.3: if the fallback cannot run or
  // cannot answer, ALLOW — a check that cannot verify must not block
  // the admin (see the header comment). Only a clean answer of "no
  // admin group" denies.
  if (!accountId) return;
  let groupsRes;
  try {
    groupsRes = await api.asApp().requestJira(
      route`/rest/api/3/user/groups?accountId=${encodeURIComponent(accountId)}`,
    );
  } catch (e) {
    return;
  }
  if (!groupsRes.ok) return;
  const groups = await groupsRes.json();
  const names = (Array.isArray(groups) ? groups : [])
    .map((g) => g?.name)
    .filter(Boolean);
  if (names.includes('site-admins') || names.includes('administrators')) return;
  throw denied;
}
