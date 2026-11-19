// Forge backend entry point — runs ONLY inside the Forge runtime.
// All scoring / notes / history / digest logic lives in pure modules
// (scoring.js, release-notes.js, blockers.js, history.js, digest.js,
// demo-seed.js, settings.js, issue-context.js) so it is unit-tested locally
// without any Atlassian account. This file is the thin glue between Forge
// resolvers and that pure core.
//
// Requires (installed at deploy time, NOT needed for local tests):
//   @forge/api, @forge/resolver
//
// Resolver construction (2026-11-16, found by reproducing the deployed
// failure locally): do NOT use `import Resolver from '@forge/resolver'` +
// `new Resolver()`. In the Forge runtime the function module loads as ESM,
// and under ESM the default import of the CJS @forge/resolver package is
// the module namespace object ({ makeResolver, default }), NOT the class —
// so `new Resolver()` throws "out_namespaceObject is not a constructor"
// at load time and EVERY invoke fails with that error (verified: direct
// Node ESM import gives typeof Resolver === 'object', new Resolver()
// throws; the esbuild CJS bundle loads fine, which is why local tests
// never caught it — index.js is not covered by the local suite).
// `makeResolver` is a real named export and works in ESM and CJS alike,
// so the handlers are declared through it. `api` / `storage` from
// @forge/api are unaffected (asApp/storage are named exports and work
// in ESM — verified the same way).
import { makeResolver } from '@forge/resolver';
import api, { route, storage } from '@forge/api';
import { scoreRelease, explainScore } from './scoring.js';
import { generateReleaseNotes } from './release-notes.js';
import { createForgeAdapter } from './adapters.js';
import { getIssueContext as getIssueContextPure } from './issue-context.js';
import {
  normalizeSettings, validateSettings, publicSettings,
  extractLegacySecrets, resolveReleaseConfig, resolvePublishSpace,
  SETTINGS_STORAGE_KEY, LAST_DIGEST_KEY, LAST_DIGEST_STATUS_KEY,
  SECRET_COARENA_KEY, SECRET_BITBUCKET_KEY, SECRET_SLACK_KEY,
  lastDigestKeyFor,
} from './settings.js';
import { isValidSlackWebhookUrl } from './slack.js';
import { getAiSummaryCore } from './ai-summary.js';
import {
  snapshotFromContext, computeTrend, trendLabel,
  HISTORY_STORAGE_KEY, HISTORY_INDEX_KEY, appendSnapshot, updateVersionIndex,
  migrateLegacyHistory, historyKeyFor,
} from './history.js';
import { isEmptyContext, assertRealContext } from './demo-seed.js';
import { publishOrUpdatePage, assertPublishSpaceKey, forgeRequest } from './confluence.js';
import { assertAdmin } from './admin.js';
import { runDigestNow as runDigestNowForConfig } from './trigger.js';
import {
  buildAuditEvent, recordAuditEvent, readAuditEvents,
} from './audit.js';

/**
 * Admin gate for the admin-only resolvers (0.9.5, Stage 0 review Q2):
 * saveSettings, publishReleaseNotes, getAiSummary, runDigestNow,
 * getAuditLog. Same check as before — assertAdmin, UNCHANGED fail-open
 * behaviour (0.9.3): a clean "not an administrator" denies; a check
 * that cannot verify allows. The one addition: a DENIED attempt is
 * written to the audit log before the denial is rethrown, so every
 * refused call — and every fail-open one — is traceable. The audit
 * write never throws (recordAuditEvent swallows storage errors), so
 * the denial itself always propagates unchanged.
 */
async function requireAdmin(action, context) {
  try {
    await assertAdmin(api, route, context?.accountId);
  } catch (e) {
    await recordAuditEvent(storage, buildAuditEvent({
      action, accountId: context?.accountId ?? null, ok: false, detail: { reason: 'admin-denied' },
    }));
    throw e;
  }
}

async function loadSettings() {
  return normalizeSettings(await storage.get(SETTINGS_STORAGE_KEY));
}

/**
 * Load the secrets (0.7.0, P1-5). CoArena key and Bitbucket token live
 * under their own storage keys, never inside the settings object. Legacy
 * keys still stored inside the settings object (0.6.0) are read as a
 * fallback until the next admin save migrates them; secretsLegacy flags
 * that state for the admin page. The Slack webhook URL (0.9.0, P2-3)
 * has no legacy location — it only ever lived under SECRET_SLACK_KEY.
 * @returns {{coarenaApiKey:string, bitbucketApiToken:string, slackWebhookUrl:string, hasCoarenaKey:boolean, hasBitbucketToken:boolean, hasSlackWebhook:boolean, secretsLegacy:boolean}}
 */
async function loadSecrets() {
  const raw = (await storage.get(SETTINGS_STORAGE_KEY)) ?? {};
  const legacy = extractLegacySecrets(raw);
  const coarenaApiKey = (await storage.get(SECRET_COARENA_KEY)) || legacy.coarenaApiKey || '';
  const bitbucketApiToken = (await storage.get(SECRET_BITBUCKET_KEY)) || legacy.bitbucketApiToken || '';
  const slackWebhookUrl = (await storage.get(SECRET_SLACK_KEY)) || '';
  return {
    coarenaApiKey,
    bitbucketApiToken,
    slackWebhookUrl,
    hasCoarenaKey: Boolean(coarenaApiKey),
    hasBitbucketToken: Boolean(bitbucketApiToken),
    hasSlackWebhook: Boolean(slackWebhookUrl),
    secretsLegacy: Boolean(legacy.coarenaApiKey || legacy.bitbucketApiToken),
  };
}

async function getContextFromJira(payload) {
  // Settings decide demo mode; the adapter falls back to the labelled demo
  // seed when nothing is configured or the real release is empty. The
  // release config (one per project+version) is resolved inside the
  // adapter; the Bitbucket token comes from the secret key (P1-5).
  const settings = await loadSettings();
  const secrets = await loadSecrets();
  return createForgeAdapter(api, route, storage).fetchReleaseContext({
    version: payload.version ?? settings.configs?.[0]?.version,
    projectKey: payload.projectKey ?? settings.configs?.[0]?.projectKey,
    settings,
    scenario: payload.scenario ?? 'blocked',
    refresh: payload.refresh === true,
    bitbucketApiToken: secrets.bitbucketApiToken || null,
  });
}

/** Migrate the 0.6.0 flat history into the per-version layout, once. */
async function migrateHistoryIfNeeded() {
  const legacy = (await storage.get(HISTORY_STORAGE_KEY)) ?? [];
  if (legacy.length === 0) return (await storage.get(HISTORY_INDEX_KEY)) ?? [];
  const migrated = migrateLegacyHistory(legacy);
  for (const [version, entries] of Object.entries(migrated.perVersion)) {
    await storage.set(historyKeyFor(version), entries);
  }
  await storage.set(HISTORY_INDEX_KEY, migrated.index);
  await storage.delete(HISTORY_STORAGE_KEY);
  return migrated.index;
}

export const handler = makeResolver({
  getReadiness: async ({ payload }) => {
    const settings = await loadSettings();
    const ctx = await getContextFromJira(payload);
    const result = scoreRelease(ctx, settings.weights);
    return {
      ...result,
      // 0.8.0 (P2-2): structured facts behind the score, so the dashboard
      // can show "why this score" without re-deriving the deductions.
      explanation: explainScore(ctx, settings.weights, result),
      weights: settings.weights,
      version: ctx.version,
      projectKey: ctx.projectKey,
      demo: ctx.demo ?? false,
      demoReason: ctx.demoReason ?? null,
      isEmpty: isEmptyContext(ctx),
      // P1-3: which sources the numbers actually came from (live /
      // unwired / error / demo) — the dashboard renders this under the
      // breakdown so a 0 never looks like a measured 0.
      dataSources: ctx.dataSources ?? null,
      dataGaps: ctx.dataGaps ?? [],
      dataUpdatedAt: ctx.dataUpdatedAt ?? null,
      fromCache: ctx.fromCache ?? false,
      truncated: ctx.truncated ?? false,
    };
  },

  getBlockers: async ({ payload }) => {
    // Same list the verdict is built from: scoreRelease() already returns
    // collectBlockers() output, so this resolver just reuses it (0.6.0).
    const settings = await loadSettings();
    const ctx = await getContextFromJira(payload);
    return scoreRelease(ctx, settings.weights).blockers;
  },

  getReleaseNotes: async ({ payload }) => {
    const ctx = await getContextFromJira(payload);
    return {
      markdown: generateReleaseNotes({ version: ctx.version, issues: ctx.issues, format: 'markdown' }),
      adf: generateReleaseNotes({ version: ctx.version, issues: ctx.issues, format: 'adf' }),
    };
  },

  publishReleaseNotes: async ({ payload, context }) => {
    // Creates a Confluence page from the ADF notes (api.asApp, Confluence REST).
    // Deliberately NOT auto-run: the user reviews the notes in the UI first, then clicks Publish.
    // Demo data is never published: the seed is labelled sample content, and
    // publishing it would create a fake page on a real site.
    // 0.9.5 (Stage 0 review Q2): publishing is admin-only — before this
    // version any project user could invoke it directly and write to the
    // configured space. The check is the same fail-open assertAdmin as
    // saveSettings (a clean "no" denies; a check that cannot verify
    // allows and is audited).
    await requireAdmin('notes.publish', context);
    const ctx = await getContextFromJira(payload);
    assertRealContext(ctx);
    // 0.9.2: the publish space is resolved ONCE, here on the backend
    // (resolvePublishSpace: entered values first, then the adapter
    // context). Its error names what was searched for and which rows are
    // saved, with invisible characters escaped — so a mismatch is
    // diagnosable from the UI text alone.
    const settings = await loadSettings();
    const { spaceKey } = resolvePublishSpace(
      settings,
      { projectKey: payload.projectKey, version: payload.version },
      ctx,
    );
    // P0-3: the target space must be the one the admin configured — a
    // direct invoke passing a different spaceKey is refused here. The
    // panel no longer sends a spaceKey at all, so the guard only fires
    // for direct invokes that pass one.
    if (payload.spaceKey) {
      assertPublishSpaceKey(payload.spaceKey, spaceKey, `${ctx.projectKey} ${ctx.version}`);
    }
    const adf = generateReleaseNotes({ version: ctx.version, issues: ctx.issues, format: 'adf' });
    // P1-2: re-publishing a version updates its page instead of creating
    // a duplicate (the page id was stored on the first publish).
    const existingPageId = (await storage.get(`published-${ctx.version}`)) ?? null;
    const result = await publishOrUpdatePage(
      forgeRequest(api, route),
      { spaceKey, title: `Release Notes — ${ctx.version}`, adf, existingPageId },
    );
    // The UI shows "Publish failed: <message>" for a rejected resolver.
    if (!result.ok) {
      await recordAuditEvent(storage, buildAuditEvent({
        action: 'notes.publish', accountId: context?.accountId ?? null, ok: false,
        detail: { projectKey: ctx.projectKey, version: ctx.version, spaceKey, reason: result.error.message },
      }));
      throw new Error(result.error.message);
    }
    await storage.set(`published-${ctx.version}`, result.pageId);
    await recordAuditEvent(storage, buildAuditEvent({
      action: 'notes.publish', accountId: context?.accountId ?? null, ok: true,
      detail: { projectKey: ctx.projectKey, version: ctx.version, spaceKey, pageId: result.pageId },
    }));
    return { pageId: result.pageId, url: result.url };
  },

  getIssueContext: async ({ payload }) => {
    if (!payload.issueKey) throw new Error('getIssueContext: issueKey is required');
    const ctx = await getContextFromJira(payload);
    return getIssueContextPure(ctx, payload.issueKey);
  },

  getSettings: async () => {
    // The API key never leaves the backend: the frontend only learns
    // whether a key is saved (hasCoarenaKey, see settings.js).
    const secrets = await loadSecrets();
    return publicSettings(await loadSettings(), secrets);
  },

  saveSettings: async ({ payload, context }) => {
    // P0-3: only a Jira administrator may change settings. The admin page
    // being visible is not proof — resolvers can be invoked directly.
    // 0.9.2: pass the caller's accountId so assertAdmin can fall back to
    // an asApp group check when the asUser call fails (see admin.js).
    // 0.9.5: the check now also audits a denied attempt (requireAdmin).
    await requireAdmin('settings.save', context);
    const current = await loadSettings();
    const secrets = await loadSecrets();
    const settings = normalizeSettings({ ...current, ...payload });
    // Secrets live under their own keys (P1-5). The admin page only sends
    // a key when the password box is non-empty, so a missing/blank key
    // means "keep the saved key" — never wipe it by accident. An explicit
    // remove flag clears it instead. A key with spaces is rejected
    // outright (a pasted key with a stray space is never a valid key).
    const secretErrors = [];
    let nextCoarenaKey = secrets.coarenaApiKey;
    if (payload.removeCoarenaKey === true) nextCoarenaKey = '';
    else if (payload.coarenaApiKey) {
      if (/\s/.test(payload.coarenaApiKey)) secretErrors.push('coarenaApiKey must not contain spaces');
      else nextCoarenaKey = payload.coarenaApiKey.trim();
    }
    let nextBitbucketToken = secrets.bitbucketApiToken;
    if (payload.removeBitbucketToken === true) nextBitbucketToken = '';
    else if (payload.bitbucketApiToken) {
      if (/\s/.test(payload.bitbucketApiToken)) secretErrors.push('bitbucketApiToken must not contain spaces');
      else nextBitbucketToken = payload.bitbucketApiToken.trim();
    }
    // 0.9.0 (P2-3): Slack webhook URL, same keep-unless-replaced rule.
    // A pasted URL that is not a Slack incoming webhook is rejected
    // outright — the app must never POST to an arbitrary host.
    let nextSlackWebhook = secrets.slackWebhookUrl;
    if (payload.removeSlackWebhook === true) nextSlackWebhook = '';
    else if (payload.slackWebhookUrl) {
      if (!isValidSlackWebhookUrl(payload.slackWebhookUrl.trim())) {
        secretErrors.push('slackWebhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/services/…)');
      } else nextSlackWebhook = payload.slackWebhookUrl.trim();
    }
    const errors = [...validateSettings(settings), ...secretErrors];
    if (errors.length > 0) {
      await recordAuditEvent(storage, buildAuditEvent({
        action: 'settings.save', accountId: context?.accountId ?? null, ok: false,
        detail: { reason: 'validation', errors: errors.join('; ') },
      }));
      return { ok: false, errors };
    }
    // Migrate any legacy secrets still in the settings object: the new
    // keys win, and the stored settings object is saved WITHOUT the
    // legacy fields (normalizeSettings already drops them).
    if (nextCoarenaKey) await storage.set(SECRET_COARENA_KEY, nextCoarenaKey);
    else await storage.delete(SECRET_COARENA_KEY);
    if (nextBitbucketToken) await storage.set(SECRET_BITBUCKET_KEY, nextBitbucketToken);
    else await storage.delete(SECRET_BITBUCKET_KEY);
    if (nextSlackWebhook) await storage.set(SECRET_SLACK_KEY, nextSlackWebhook);
    else await storage.delete(SECRET_SLACK_KEY);
    await storage.set(SETTINGS_STORAGE_KEY, settings);
    await recordAuditEvent(storage, buildAuditEvent({
      action: 'settings.save', accountId: context?.accountId ?? null, ok: true,
      detail: { configs: settings.configs.length },
    }));
    secrets.hasCoarenaKey = Boolean(nextCoarenaKey);
    secrets.hasBitbucketToken = Boolean(nextBitbucketToken);
    secrets.hasSlackWebhook = Boolean(nextSlackWebhook);
    secrets.secretsLegacy = false;
    return { ok: true, settings: publicSettings(settings, secrets) };
  },

  // On-demand AI summary (dashboard card). Text only: readiness is scored
  // by the rule-based engine first, the model only turns the result into
  // prose. Never throws for AI-side problems — getAiSummaryCore returns an
  // error object (not-configured / fetch-failed / invalid-key / quota /
  // api-error / bad-response) so a failed call only affects the summary
  // card; scoring, blockers, notes and digest are untouched. The API key
  // is read from storage here and never appears in the returned object.
  getAiSummary: async ({ payload, context }) => {
    // 0.9.5 (Stage 0 review Q2): generating a summary is admin-only —
    // before this version any project user could invoke it directly and
    // burn the shared CoArena $5/day quota (the 2026-11-16 402s). Same
    // fail-open assertAdmin as saveSettings.
    await requireAdmin('ai.summary', context);
    const settings = await loadSettings();
    // P1-4: the admin switch gates the feature entirely — when off, no
    // prompt is built, no key is read, no request leaves the backend.
    if (!settings.aiSummaryEnabled) {
      return {
        ok: false,
        code: 'not-configured',
        message: 'AI summary is disabled in ShipCheck Settings.',
      };
    }
    const ctx = await getContextFromJira(payload);
    const result = scoreRelease(ctx, settings.weights);
    const secrets = await loadSecrets();
    const summary = await getAiSummaryCore({
      fetchFn: (url, opts) => api.fetch(url, opts),
      apiKey: secrets.coarenaApiKey,
      input: {
        version: ctx.version,
        projectKey: ctx.projectKey,
        score: result.score,
        verdict: result.verdict,
        breakdown: result.breakdown,
        blockers: result.blockers,
        warnings: result.warnings,
        issues: ctx.issues ?? [],
        demo: ctx.demo ?? false,
      },
    });
    // 0.9.5: record the call — outcome code only, never the summary
    // text (it is generated on demand and not stored, see
    // DATA-RETENTION.md).
    await recordAuditEvent(storage, buildAuditEvent({
      action: 'ai.summary', accountId: context?.accountId ?? null, ok: summary.ok,
      detail: {
        projectKey: ctx.projectKey, version: ctx.version,
        score: result.score, verdict: result.verdict,
        code: summary.ok ? 'ok' : summary.code,
      },
    }));
    return summary;
  },

  getScoreTrend: async () => {
    const index = await migrateHistoryIfNeeded();
    const trend = computeTrend(index);
    return { ...trend, label: trendLabel(trend) };
  },

  recordScore: async ({ payload }) => {
    // P0-4: the frontend's score/verdict are IGNORED even if sent — the
    // snapshot is recomputed from the real release context on the backend,
    // so a forged { score: 100, verdict: 'READY' } can never enter history.
    // Demo contexts record nothing (demo scores must not pollute history).
    // 0.7.0: snapshots go to the per-version key + the index (P1-5), and
    // carry the scoring-rules version (P0-4).
    const settings = await loadSettings();
    const ctx = await getContextFromJira({ version: payload.version, projectKey: payload.projectKey });
    const snapshot = snapshotFromContext(ctx, settings.weights);
    if (!snapshot) return { recorded: false, reason: 'demo' };
    await migrateHistoryIfNeeded();
    const key = historyKeyFor(snapshot.version);
    const entries = appendSnapshot((await storage.get(key)) ?? [], snapshot);
    await storage.set(key, entries);
    const index = updateVersionIndex((await storage.get(HISTORY_INDEX_KEY)) ?? [], snapshot);
    await storage.set(HISTORY_INDEX_KEY, index);
    return { recorded: true, entries: entries.length };
  },

  // The weekly digest built by the scheduled trigger (src/trigger.js) is
  // stored per release config (0.7.0, P1-8); the dashboard/admin page
  // reads it back here. The legacy single key is the fallback for a
  // digest written before the 0.7.0 upgrade.
  getLatestDigest: async ({ payload } = {}) => {
    const settings = await loadSettings();
    const config = resolveReleaseConfig(settings, payload?.projectKey, payload?.version)
      ?? settings.configs?.[0] ?? null;
    if (config?.projectKey && config?.version) {
      const perConfig = await storage.get(lastDigestKeyFor(config.projectKey, config.version));
      if (perConfig) return perConfig;
    }
    return (await storage.get(LAST_DIGEST_KEY)) ?? null;
  },

  // Per-config digest run status (0.7.0, P1-8): the admin page shows when
  // each release's digest last ran and whether it was sent, stored-only,
  // or failed. Returns a map "<project>:<version>" -> { status, at, ... }.
  getDigestStatus: async () => {
    return (await storage.get(LAST_DIGEST_STATUS_KEY)) ?? {};
  },

  // Manual digest run (0.7.0, P1-8): the admin "Run now" button. Admin
  // only; bypasses the weekday/weekly gates but does NOT update lastSent.
  // 0.9.5: the caller's accountId is forwarded so the digest run is
  // audited under that account (scheduled runs audit as null).
  runDigestNow: async ({ payload, context }) => {
    await requireAdmin('digest.run', context);
    const configKey = payload?.configKey ?? payload?.config ?? '';
    if (!configKey) throw new Error('runDigestNow: configKey ("<project>:<version>") is required');
    return runDigestNowForConfig(configKey, context?.accountId);
  },

  // Audit log read (0.9.5, Stage 0 review T10): admin-only. Returns the
  // newest audit events first (default 100, the whole stored log).
  // The UI does not call this yet — it is callable via
  // bridge.invoke('getAuditLog') and is the read path for the audit
  // trail. Successful reads are NOT themselves audited (that would spam
  // the log with its own reads); denied reads are recorded under
  // 'audit.read' by requireAdmin.
  getAuditLog: async ({ payload, context }) => {
    await requireAdmin('audit.read', context);
    const limit = payload?.limit;
    return { events: await readAuditEvents(storage, { limit }) };
  },
});
