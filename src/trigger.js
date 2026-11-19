// Scheduled trigger — weekly readiness digest. Runs ONLY in the Forge runtime
// on a real site (declared as a `scheduledTrigger` module in manifest.yml).
//
// Delivery: Forge has no outbound email, so the digest is published as a
// Confluence page in the configured docs space (same ADF path as the
// one-click release notes) and a copy is kept in Forge Storage so the admin
// page can show when the last digest went out.
//
// Schedule: the manifest sets `interval: day`, so Forge fires this handler
// once a day (starting ~5 minutes after deployment). The handler itself
// only sends on the weekday chosen in ShipCheck Settings (default Friday,
// see shouldSendDigest) and at most once per week — a `week` interval would
// anchor to the deploy day and could never match the setting.
//
// 0.7.0 (P1-8): the digest runs PER RELEASE CONFIG (one per project+
// version). Last-sent, last-digest and run status are stored per config
// (digestSentKeyFor / lastDigestKeyFor / LAST_DIGEST_STATUS_KEY); the old
// single keys (DIGEST_STORAGE_KEY / LAST_DIGEST_KEY) are kept only as a
// read fallback for the dashboard's first run after upgrade. The digest
// also records the score snapshot into the per-version history (P0-4),
// diffs blockers against the last digest (P1-8), and — when the push
// switch is on — posts a Jira comment on each newly blocking issue
// (P1-11, Jira comments first) and a Slack alert for all new blockers
// (0.9.0, P2-3) — same trigger condition, each channel deduped per
// release per day under its own storage key.
//
// This trigger has NOT been tested live: it cannot run locally (no Forge
// runtime, no site) and the sandbox cannot install the Forge CLI. First
// live run must be watched on T's developer site.
//
// Costs $0: pure rule-based digest, no Forge LLM, no Rovo, no paid API.
import api, { route, storage } from '@forge/api';
import { scoreRelease } from './scoring.js';
import { buildDigest, digestToAdf, shouldSendDigest, diffBlockers, decidePush } from './digest.js';
import {
  computeTrend, trendLabel, HISTORY_INDEX_KEY, HISTORY_STORAGE_KEY,
  appendSnapshot, updateVersionIndex, snapshotFromContext,
  migrateLegacyHistory, historyKeyFor,
} from './history.js';
import {
  normalizeSettings, SETTINGS_STORAGE_KEY, DIGEST_STORAGE_KEY, LAST_DIGEST_KEY,
  LAST_DIGEST_STATUS_KEY, SECRET_BITBUCKET_KEY, SECRET_SLACK_KEY,
  digestSentKeyFor, lastDigestKeyFor, pushedKeyFor, slackPushedKeyFor,
} from './settings.js';
import { createForgeAdapter } from './adapters.js';
import { publishPage, forgeRequest } from './confluence.js';
import { formatSlackAlert, postSlackAlert } from './slack.js';
import { buildAuditEvent, recordAuditEvent } from './audit.js';

export { LAST_DIGEST_KEY };

/** Read the settings plus the Bitbucket token and Slack webhook from their secret keys. */
async function loadSettingsAndToken() {
  const settings = normalizeSettings(await storage.get(SETTINGS_STORAGE_KEY));
  const bitbucketApiToken = (await storage.get(SECRET_BITBUCKET_KEY)) ?? null;
  const slackWebhookUrl = (await storage.get(SECRET_SLACK_KEY)) ?? null;
  return { settings, bitbucketApiToken, slackWebhookUrl };
}

/** Record one snapshot into the per-version history (P0-4 + P1-5). */
async function recordHistorySnapshot(snapshot) {
  // One-time migration of the 0.6.0 flat history, if it still exists.
  const legacy = (await storage.get(HISTORY_STORAGE_KEY)) ?? [];
  let index = (await storage.get(HISTORY_INDEX_KEY)) ?? [];
  if (legacy.length > 0) {
    const migrated = migrateLegacyHistory(legacy);
    index = migrated.index;
    for (const [version, entries] of Object.entries(migrated.perVersion)) {
      await storage.set(historyKeyFor(version), entries);
    }
    await storage.delete(HISTORY_STORAGE_KEY);
  }
  const key = historyKeyFor(snapshot.version);
  const entries = appendSnapshot((await storage.get(key)) ?? [], snapshot);
  await storage.set(key, entries);
  index = updateVersionIndex(index, snapshot);
  await storage.set(HISTORY_INDEX_KEY, index);
  return index;
}

/** Update one config's entry in the digest run-status map (P1-8). */
async function setDigestStatus(configKey, entry) {
  const map = (await storage.get(LAST_DIGEST_STATUS_KEY)) ?? {};
  map[configKey] = { ...entry, at: new Date().toISOString() };
  await storage.set(LAST_DIGEST_STATUS_KEY, map);
}

function commentAdf(text) {
  return JSON.stringify({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

/**
 * Post one Jira comment per newly blocking BUG issue (P1-11). PR and
 * deployment blockers have no Jira issue to comment on — they are
 * reported in the digest only. Deduped per release per day (a second
 * digest run the same day does not re-comment). Returns the issue keys
 * commented on.
 */
async function pushBlockerComments({ projectKey, version, score, added }) {
  const commented = [];
  const bugBlockers = (added ?? []).filter((b) => b.kind === 'bug' && b.key);
  if (bugBlockers.length === 0) return commented;
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = pushedKeyFor(version, today);
  const already = (await storage.get(dedupKey)) ?? [];
  for (const blk of bugBlockers) {
    if (already.includes(blk.key)) continue;
    const text = `ShipCheck: this issue now blocks release ${projectKey} ${version} (score ${score}/100 — BLOCKED). ${blk.summary} See the weekly readiness digest for details.`;
    try {
      const res = await api.asApp().requestJira(
        route`/rest/api/3/issue/${blk.key}/comment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: commentAdf(text),
        },
      );
      if (res.ok) commented.push(blk.key);
    } catch (e) {
      // One failed comment never fails the digest — it is reported in
      // the run status instead.
    }
  }
  if (commented.length > 0) {
    await storage.set(dedupKey, [...already, ...commented]);
  }
  return commented;
}

/**
 * Post the Slack alert for newly appearing blockers (0.9.0, P2-3).
 * Same trigger condition as the Jira comments, but it reports ALL new
 * blockers (bugs, failed deployments, unapproved PRs), not just bugs —
 * Slack has no per-issue constraint. Deduped per release per day under
 * its own key; a failed post never fails the digest. Returns true only
 * when Slack accepted the message.
 */
async function pushSlackAlert({ projectKey, version, score, verdict, added, webhookUrl }) {
  if (!webhookUrl) return false;
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = slackPushedKeyFor(version, today);
  if (await storage.get(dedupKey)) return false;
  const text = formatSlackAlert({ projectKey, version, score, verdict, added });
  const res = await postSlackAlert({
    fetchFn: (url, opts) => api.fetch(url, opts),
    webhookUrl,
    text,
  });
  if (res.ok) {
    await storage.set(dedupKey, true);
    return true;
  }
  return false;
}

/**
 * Run the digest for ONE release config.
 * @param {object} settings normalized settings (globals: digestDay, weights, pushEnabled)
 * @param {object} config one release config (projectKey, version, spaceKey, digestEnabled, bitbucket*)
 * @param {object} opts { now, manual, bitbucketApiToken, slackWebhookUrl, accountId }
 *   manual=true (the admin "Run now" button) bypasses the weekday and
 *   weekly gates but does NOT update lastSent — the scheduled run still
 *   fires on its day. accountId is the caller for a manual run and null
 *   for the scheduled run (no caller); it is recorded in the audit log.
 * @returns {{sent:boolean, reason?:string, pageId?:string, url?:string, pushed?:string[], pushedSlack?:boolean, config:string}}
 */
export async function runDigestForConfig(settings, config, { now = new Date(), manual = false, bitbucketApiToken = null, slackWebhookUrl = null, accountId = null } = {}) {
  const configKey = `${config.projectKey}:${config.version}`;
  const lastSent = (await storage.get(digestSentKeyFor(config.projectKey, config.version))) ?? null;
  if (!manual && !shouldSendDigest({ ...config, digestDay: settings.digestDay }, now, lastSent)) {
    return { sent: false, reason: 'Digest not due (disabled, wrong weekday, already sent this week, or no release configured).', config: configKey };
  }
  const ctx = await createForgeAdapter(api, route, storage).fetchReleaseContext({
    version: config.version,
    projectKey: config.projectKey,
    settings,
    bitbucketApiToken,
    refresh: true, // a scheduled report scores fresh data, not the 5-min cache
  });
  const result = scoreRelease(ctx, settings.weights);
  // Record the snapshot first so the digest's trend compares this version
  // against the previous one (P0-4 + P1-5).
  let index = [];
  const snapshot = snapshotFromContext({ ...ctx, version: config.version }, settings.weights);
  if (snapshot) index = await recordHistorySnapshot(snapshot);
  const trend = computeTrend(index);
  // Previous digest for the diff + the push decision (P1-8 / P1-11).
  const prevDigest = (await storage.get(lastDigestKeyFor(config.projectKey, config.version)))
    ?? (await storage.get(LAST_DIGEST_KEY));
  const previousBlockers = prevDigest?.blocks?.blockers ?? null;
  const previousVerdict = prevDigest?.blocks?.verdict ?? null;
  const diff = previousBlockers ? diffBlockers(previousBlockers, result.blockers) : { added: result.blockers, resolved: [], unchanged: [] };
  const digest = buildDigest({
    projectKey: config.projectKey,
    version: config.version,
    result,
    blockers: result.blockers,
    trend,
    previousBlockers,
  });
  const stored = { ...digest, sentAt: now.toISOString() };
  await storage.set(lastDigestKeyFor(config.projectKey, config.version), stored);
  if (!config.spaceKey) {
    await setDigestStatus(configKey, { status: 'stored-no-space', reason: 'Digest built and stored, but no Confluence space key is configured — nothing published.' });
    await recordAuditEvent(storage, buildAuditEvent({
      action: 'digest.run', accountId, ok: true, detail: { config: configKey, sent: false, reason: 'stored-no-space' },
    }));
    return { sent: false, reason: 'Digest built and stored, but no Confluence space key is configured (ShipCheck Settings) — nothing published.', config: configKey };
  }
  const published = await publishPage(
    forgeRequest(api, route),
    { spaceKey: config.spaceKey, title: digest.subject, adf: digestToAdf(digest) },
  );
  if (!published.ok) {
    await setDigestStatus(configKey, { status: 'publish-failed', error: published.error.message });
    await recordAuditEvent(storage, buildAuditEvent({
      action: 'digest.run', accountId, ok: false, detail: { config: configKey, sent: false, reason: published.error.message },
    }));
    throw new Error(`Digest publish failed: ${published.error.message}`);
  }
  // Push (P1-11 Jira comments + 0.9.0 P2-3 Slack): only when the switch
  // is on and the verdict dropped to BLOCKED or new blockers appeared.
  // Both channels share the decision; each has its own dedup key.
  let pushed = [];
  let pushedSlack = false;
  const shouldPush = settings.pushEnabled
    && decidePush({ previousVerdict, currentVerdict: result.verdict, added: diff.added });
  if (shouldPush) {
    pushed = await pushBlockerComments({
      projectKey: config.projectKey,
      version: config.version,
      score: result.score,
      added: diff.added,
    });
    pushedSlack = await pushSlackAlert({
      projectKey: config.projectKey,
      version: config.version,
      score: result.score,
      verdict: result.verdict,
      added: diff.added,
      webhookUrl: slackWebhookUrl,
    });
  }
  if (!manual) {
    await storage.set(digestSentKeyFor(config.projectKey, config.version), now.toISOString());
  }
  await setDigestStatus(configKey, { status: 'sent', pageId: published.pageId, pushed, pushedSlack });
  await recordAuditEvent(storage, buildAuditEvent({
    action: 'digest.run', accountId, ok: true, detail: { config: configKey, sent: true, pageId: published.pageId },
  }));
  return { sent: true, pageId: published.pageId, url: published.url, pushed, pushedSlack, config: configKey };
}

/**
 * Manual run for one release (admin "Run now" button, wired by the
 * runDigestNow resolver in index.js). Bypasses the time gates, does not
 * update lastSent. accountId is the admin who clicked it (null when
 * called without a caller); it is recorded in the audit log.
 */
export async function runDigestNow(configKey, accountId = null) {
  const { settings, bitbucketApiToken, slackWebhookUrl } = await loadSettingsAndToken();
  const [projectKey, version] = String(configKey ?? '').split(':');
  const config = (settings.configs ?? []).find((c) => c.projectKey === projectKey && c.version === version)
    ?? (settings.configs ?? []).find((c) => c.version === version)
    ?? null;
  if (!config) throw new Error(`runDigestNow: no release config found for "${configKey}"`);
  return runDigestForConfig(settings, config, { now: new Date(), manual: true, bitbucketApiToken, slackWebhookUrl, accountId });
}

export async function handler() {
  const { settings, bitbucketApiToken, slackWebhookUrl } = await loadSettingsAndToken();
  const configs = (settings.configs ?? []).filter((c) => c.digestEnabled);
  if (configs.length === 0) {
    return { sent: false, reason: 'No release has the weekly digest enabled (ShipCheck Settings).' };
  }
  const results = [];
  for (const config of configs) {
    try {
      results.push(await runDigestForConfig(settings, config, { now: new Date(), manual: false, bitbucketApiToken, slackWebhookUrl }));
    } catch (e) {
      results.push({ sent: false, reason: String(e?.message ?? e), config: `${config.projectKey}:${config.version}` });
    }
  }
  return { sent: results.some((r) => r.sent), results };
}
