// Slack / generic incoming-webhook push alerts — 0.9.0 (P2-3).
// The second push channel of the 0.7.0 doc's 功能 3: Jira comments came
// first (0.7.0, P1-11); Slack posts the same alert to a channel, under
// the same trigger condition (verdict drops to BLOCKED or a new blocker
// appears) and the same admin switch (pushEnabled). The webhook URL is a
// secret: it lives under SECRET_SLACK_KEY in Forge Storage, is never
// returned to the UI, and is only ever POSTed to hooks.slack.com — the
// URL is validated here AND the host is allowlisted in manifest.yml
// egress, so a pasted non-Slack URL can never turn the app into an
// open POST proxy.
//
// Failure policy (same as bitbucket.js): these functions NEVER throw.
// A missing/invalid webhook, a network error or an HTTP error returns
// { ok: false, ... } so the digest keeps working and reports the miss
// in its run status instead of failing the whole report.
//
// Costs $0: Slack incoming webhooks are free; no Forge LLM, no Rovo,
// no paid API. A Slack workspace + webhook URL is created by the admin
// in Slack (Settings → Integrations) — the app only needs the URL.
export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';

// Slack webhook path segments are alphanumerics plus '-' and '_',
// separated by '/'. No spaces, no query string.
const WEBHOOK_PATH_RE = /^[A-Za-z0-9\-_]+(\/[A-Za-z0-9\-_]+)+$/;

/** True only for a genuine Slack incoming-webhook URL. */
export function isValidSlackWebhookUrl(url) {
  if (typeof url !== 'string') return false;
  if (!url.startsWith(SLACK_WEBHOOK_PREFIX)) return false;
  return WEBHOOK_PATH_RE.test(url.slice(SLACK_WEBHOOK_PREFIX.length));
}

/** One blocker as a single line: "SHIP-4 — summary (−15)". */
function blockerLine(b) {
  const label = b?.summary ?? b?.key ?? b?.kind ?? 'blocker';
  const key = b?.key && b?.summary ? `${b.key} — ` : '';
  const deduction = Number.isInteger(b?.deduction) && b.deduction > 0 ? ` (−${b.deduction})` : '';
  return `• ${key}${label}${deduction}`;
}

/**
 * The alert text. Backend-generated, English by design (same rule as
 * the digest subject and release notes — see TEST-REPORT.md 0.8.0).
 * @param {object} opts { projectKey, version, score, verdict, added[] }
 */
export function formatSlackAlert({ projectKey, version, score, verdict, added }) {
  const lines = [`ShipCheck: ${projectKey} ${version} is ${verdict} (score ${score}/100).`];
  const list = (added ?? []).filter(Boolean);
  if (list.length > 0) {
    lines.push('New blockers:');
    for (const b of list) lines.push(blockerLine(b));
  }
  lines.push('See the ShipCheck dashboard / weekly digest for details.');
  return lines.join('\n');
}

/**
 * POST { text } to a Slack incoming webhook.
 * @param {object} opts { fetchFn, webhookUrl, text }
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>} — never throws
 */
export async function postSlackAlert({ fetchFn, webhookUrl, text }) {
  if (!isValidSlackWebhookUrl(webhookUrl)) {
    return { ok: false, error: 'invalid Slack webhook URL' };
  }
  try {
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `Slack webhook returned HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Slack webhook request failed: ${e?.message ?? e}` };
  }
}
