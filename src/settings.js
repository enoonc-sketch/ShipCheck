// Admin settings — PURE logic, no Forge calls.
// Settings live in Forge Storage (key SETTINGS_STORAGE_KEY); the admin page
// reads/writes them through the getSettings/saveSettings resolvers.
// demoMode defaults ON so a fresh install works with zero configuration.
//
// 0.7.0 shape (P1-10): settings are a GLOBAL block plus a RELEASE CONFIG
// LIST — one config per release (project + version + docs space +
// Bitbucket repo + digest switch), so several teams/releases can share
// one install. Old single-value settings are migrated on first read
// (see normalizeSettings): the flat fields become one config, values
// unchanged.
//
// Secrets (P1-5) are NOT part of the settings object any more: the
// CoArena key lives under SECRET_COARENA_KEY and the Bitbucket token
// under SECRET_BITBUCKET_KEY (one token for all configs — it must have
// read access to every configured repository). Legacy keys stored in
// the settings object are moved on first read (see extractLegacySecrets
// + the migration in src/index.js loadSettings); a failed move keeps
// the old location as a fallback and flags it via publicSettings.
export const SETTINGS_STORAGE_KEY = 'shipcheck:settings';
export const DIGEST_STORAGE_KEY = 'shipcheck:last-digest-sent';
export const LAST_DIGEST_KEY = 'shipcheck:last-digest';
// Per-config digest state (0.7.0, P1-8): the last digest page and the
// last run status, keyed by "<projectKey>:<version>".
export const LAST_DIGEST_STATUS_KEY = 'shipcheck:last-digest-status';
// Per-config last-sent timestamp for the weekly digest (0.7.0, P1-8).
export function digestSentKeyFor(projectKey, version) {
  return `shipcheck:last-digest-sent:${projectKey}:${version}`;
}
// Per-config last digest page (0.7.0, P1-8).
export function lastDigestKeyFor(projectKey, version) {
  return `shipcheck:last-digest:${projectKey}:${version}`;
}
// Push-comment dedup (0.7.0, P1-11): one key per release per day.
export function pushedKeyFor(version, date) {
  return `shipcheck:pushed:${version}:${date}`;
}
// Separate secret keys (0.7.0, P1-5).
export const SECRET_COARENA_KEY = 'shipcheck:secrets:coarena';
export const SECRET_BITBUCKET_KEY = 'shipcheck:secrets:bitbucket';
// Slack incoming-webhook URL (0.9.0, P2-3) — same treatment as the other
// secrets: its own storage key, never inside the settings object, never
// returned to the UI (only hasSlackWebhook).
export const SECRET_SLACK_KEY = 'shipcheck:secrets:slack';
// Push-alert dedup (0.9.0, P2-3): one key per release per day, separate
// from the Jira-comment key so a Slack failure never blocks a comment
// (and vice versa).
export function slackPushedKeyFor(version, date) {
  return `shipcheck:slack-pushed:${version}:${date}`;
}

export const DEFAULT_WEIGHTS = { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 };

export const DEFAULT_SETTINGS = {
  demoMode: true,
  digestDay: 5, // Friday — just before the weekly release
  // AI summary on/off switch (0.6.0, P1-4): off means the dashboard never
  // calls the AI service at all. Defaults ON to keep current behaviour.
  aiSummaryEnabled: true,
  // Scoring weights (0.7.0, P1-3): admin-configurable, sum must be 100.
  weights: { ...DEFAULT_WEIGHTS },
  // Push comments (0.7.0, P1-11): post a Jira comment when the verdict
  // drops to BLOCKED or a new blocker appears. Defaults OFF.
  pushEnabled: false,
  // Release configs (0.7.0, P1-10): one per release.
  configs: [],
};

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const SPACE_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_]*$/;
// Bitbucket workspace / repo slugs: lowercase letters, digits, '-' and '_'.
const BITBUCKET_SLUG_RE = /^[a-z0-9][a-z0-9\-_]*$/;

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function toDigestDay(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : fallback;
}

// Invisible characters String.trim() does NOT remove: zero-width space /
// non-joiner / joiner and the byte-order mark. A key pasted from a web
// page can carry one — the settings page renders it as the plain key,
// so the row looks right while no strict comparison ever matches it.
// Live suspect for the 0.9.1 publish failure (2026-11-17 06:05: the page
// showed SHIP / 1.4.0 / TEAM yet the backend found no row). Strip them
// wherever a key is read, so a dirty stored value still matches — and a
// re-save stores the clean value.
const INVISIBLE_RE = /[\u200b\u200c\u200d\ufeff]/g;
function cleanStr(value) {
  return typeof value === 'string' ? value.replace(INVISIBLE_RE, '').trim() : '';
}

function toStr(value, fallback = '') {
  return typeof value === 'string' ? cleanStr(value) : fallback;
}

/** Normalize one release config; never throws on junk input. */
export function normalizeReleaseConfig(raw) {
  const r = raw ?? {};
  return {
    projectKey: toStr(r.projectKey),
    version: toStr(r.version),
    spaceKey: toStr(r.spaceKey),
    digestEnabled: toBool(r.digestEnabled, false),
    bitbucketWorkspace: toStr(r.bitbucketWorkspace),
    bitbucketRepoSlug: toStr(r.bitbucketRepoSlug),
    bitbucketDeployBranch: toStr(r.bitbucketDeployBranch) || 'main',
  };
}

/** True when a normalized config cannot name a release: no project key
 * AND no version. Publish, digest and push all look a config up by
 * project:version, so such a row is unaddressable — it is invalid, not
 * just empty. normalizeSettings drops it (0.9.4): the ["", "", "TEAM"]
 * row that broke publish in 0.9.1/0.9.2 carried only a space key and
 * was stored as if it were valid. A row with exactly one of the two
 * keys is kept here and rejected by validateSettings instead. */
function isEmptyConfig(c) {
  return !c.projectKey && !c.version;
}

/** Coerce a weights object: integers where given, defaults for the rest. */
function normalizeWeightsInput(raw) {
  const r = raw ?? {};
  const out = {};
  for (const k of ['blockers', 'pullRequests', 'issuesDone', 'docs']) {
    const n = Number(r[k]);
    out[k] = Number.isInteger(n) ? n : DEFAULT_WEIGHTS[k];
  }
  return out;
}

/**
 * Merge stored settings over the defaults; never throws on junk input.
 * Legacy flat settings (0.6.0 shape: projectKey/version/spaceKey/
 * digestEnabled/bitbucket* at the top level) are migrated into a single
 * release config, values unchanged. Secret fields are NOT carried over —
 * see extractLegacySecrets; they live under the separate secret keys.
 */
export function normalizeSettings(raw) {
  const r = raw ?? {};
  let configs;
  if (Array.isArray(r.configs)) {
    configs = r.configs.map(normalizeReleaseConfig).filter((c) => !isEmptyConfig(c));
  } else {
    // Legacy flat shape -> one config, if it says anything at all.
    const legacy = normalizeReleaseConfig({
      projectKey: r.projectKey,
      version: r.version,
      spaceKey: r.spaceKey,
      digestEnabled: r.digestEnabled,
      bitbucketWorkspace: r.bitbucketWorkspace,
      bitbucketRepoSlug: r.bitbucketRepoSlug,
      bitbucketDeployBranch: r.bitbucketDeployBranch,
    });
    configs = isEmptyConfig(legacy) ? [] : [legacy];
  }
  return {
    demoMode: toBool(r.demoMode, DEFAULT_SETTINGS.demoMode),
    digestDay: toDigestDay(r.digestDay, DEFAULT_SETTINGS.digestDay),
    aiSummaryEnabled: toBool(r.aiSummaryEnabled, DEFAULT_SETTINGS.aiSummaryEnabled),
    weights: normalizeWeightsInput(r.weights),
    pushEnabled: toBool(r.pushEnabled, DEFAULT_SETTINGS.pushEnabled),
    configs,
  };
}

/**
 * Find the release config for a project/version (0.7.0, P1-10).
 * With no project/version given, returns the first config (the default
 * release). Legacy flat settings (no configs array) are treated as a
 * single config, so callers that pass raw stored settings keep working.
 * @returns {object|null} the normalized config, or null when none matches
 */
export function resolveReleaseConfig(settings, projectKey, version) {
  const s = settings ?? {};
  let configs = Array.isArray(s.configs) ? s.configs : null;
  if (!configs) {
    const legacy = normalizeReleaseConfig({
      projectKey: s.projectKey,
      version: s.version,
      spaceKey: s.spaceKey,
      digestEnabled: s.digestEnabled,
      bitbucketWorkspace: s.bitbucketWorkspace,
      bitbucketRepoSlug: s.bitbucketRepoSlug,
      bitbucketDeployBranch: s.bitbucketDeployBranch,
    });
    configs = isEmptyConfig(legacy) ? [] : [legacy];
  }
  if (configs.length === 0) return null;
  // Compare cleaned values (0.9.3): a stored row may carry a zero-width
  // character the settings page renders invisibly, and the search values
  // may too — clean both sides so the match does not depend on it.
  const pk = cleanStr(projectKey);
  const ver = cleanStr(version);
  if (pk && ver) return configs.find((c) => cleanStr(c.projectKey) === pk && cleanStr(c.version) === ver) ?? null;
  if (pk) return configs.find((c) => cleanStr(c.projectKey) === pk) ?? null;
  if (ver) return configs.find((c) => cleanStr(c.version) === ver) ?? null;
  return configs[0];
}

/**
 * Quote a value for an error message and escape everything outside printable
 * ASCII as \\uXXXX, so a zero-width space or a look-alike letter that the
 * settings page renders as "SHIP" is visible in the message.
 */
function showValue(v) {
  const str = typeof v === 'string' ? v : '';
  const quoted = JSON.stringify(str);
  return quoted.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Which Confluence space does a publish go to? (0.9.1)
 * Resolved ONLY here, on the backend, from the release config for the
 * project+version being published — the panel no longer guesses. 0.9.0's
 * panel fell back to the first config's space when nothing matched while
 * the backend matched strictly, so the two disagreed and the publish died
 * with "spaceKey does not match" before reaching Confluence.
 * Lookup order: what the user entered, then what the adapter resolved for
 * the context (config project/version win over typed ones there). Never
 * falls back to another release's space.
 * @returns {{spaceKey:string, config:object}}
 * @throws {Error} no release config / no space key set on the config
 */
export function resolvePublishSpace(settings, entered, ctx) {
  const e = entered ?? {};
  const c = ctx ?? {};
  const config = resolveReleaseConfig(settings, e.projectKey, e.version)
    ?? ((c.projectKey && c.version) ? resolveReleaseConfig(settings, c.projectKey, c.version) : null);
  const label = [e.projectKey || c.projectKey, e.version || c.version].filter(Boolean).join(' ') || 'this release';
  if (!config) {
    // 0.9.3: short on purpose. The 0.9.2 wording ("searched for …; saved
    // configs: …") was cut off by the panel display live (2026-11-17
    // 06:36), so the saved rows never reached the admin. The release
    // being searched for is already the label; the saved rows come first
    // and the whole message fits one panel line for a single config.
    const saved = Array.isArray(settings?.configs) ? settings.configs : null;
    const rows = saved
      ? (saved.length === 0
        ? '(none)'
        : saved.map((r) => `[${showValue(r.projectKey)}, ${showValue(r.version)}, ${showValue(r.spaceKey)}]`).join(' '))
      : '(legacy flat settings)';
    throw new Error(`No release config for ${label} — add it in ShipCheck Settings. Saved: ${rows}.`);
  }
  if (!config.spaceKey) {
    throw new Error(`No Confluence space key is set for ${label} — fill it in ShipCheck Settings.`);
  }
  return { spaceKey: config.spaceKey, config };
}

/**
 * Secrets stored in the OLD location (inside the settings object, 0.6.0).
 * Returns them so the caller can move them to the separate secret keys;
 * the normalized settings object never carries them.
 */
export function extractLegacySecrets(raw) {
  const r = raw ?? {};
  return {
    coarenaApiKey: typeof r.coarenaApiKey === 'string' ? r.coarenaApiKey.trim() : '',
    bitbucketApiToken: typeof r.bitbucketApiToken === 'string' ? r.bitbucketApiToken.trim() : '',
  };
}

/**
 * The settings shape the frontend may see: everything except the secrets,
 * plus booleans saying whether each secret is saved. Secrets themselves
 * must never leave the backend — getSettings/saveSettings return this,
 * never the raw stored object. Callers must not JSON-serialize the stored
 * settings object to the client for any other reason either.
 * @param {object} s normalized settings
 * @param {object} secrets optional { hasCoarenaKey, hasBitbucketToken, hasSlackWebhook, secretsLegacy }
 */
export function publicSettings(s, secrets = {}) {
  const hasCoarenaKey = secrets.hasCoarenaKey !== undefined
    ? secrets.hasCoarenaKey
    : Boolean(s.coarenaApiKey);
  const hasBitbucketToken = secrets.hasBitbucketToken !== undefined
    ? secrets.hasBitbucketToken
    : Boolean(s.bitbucketApiToken);
  const hasSlackWebhook = secrets.hasSlackWebhook !== undefined
    ? secrets.hasSlackWebhook
    : Boolean(s.slackWebhookUrl);
  return {
    demoMode: s.demoMode,
    digestDay: s.digestDay,
    aiSummaryEnabled: s.aiSummaryEnabled,
    weights: { ...(s.weights ?? DEFAULT_WEIGHTS) },
    pushEnabled: s.pushEnabled,
    configs: (s.configs ?? []).map((c) => ({ ...normalizeReleaseConfig(c) })),
    hasCoarenaKey,
    hasBitbucketToken,
    hasSlackWebhook,
    // True when secrets are still sitting in the old location (migration
    // failed) — the admin page shows "re-enter the key" for those.
    secretsLegacy: secrets.secretsLegacy === true,
  };
}

/**
 * Validate a (normalized) settings object.
 * Empty configs are fine — they mean "not configured yet", and demo mode
 * covers it. But a config row with anything in it must name its release
 * (0.9.4): rows with neither a project key nor a version are dropped by
 * normalizeSettings, and rows with exactly one of the two are rejected
 * here. Returns an array of error strings (empty = valid).
 */
export function validateSettings(s) {
  const errors = [];
  if (!Number.isInteger(s.digestDay) || s.digestDay < 0 || s.digestDay > 6) {
    errors.push('digestDay must be an integer from 0 (Sunday) to 6 (Saturday)');
  }
  const w = s.weights ?? {};
  for (const k of ['blockers', 'pullRequests', 'issuesDone', 'docs']) {
    if (!Number.isInteger(w[k]) || w[k] < 0 || w[k] > 100) {
      errors.push(`weights.${k} must be an integer between 0 and 100`);
    }
  }
  if (Object.values(w).every((n) => Number.isInteger(n)) && Object.values(w).reduce((a, b) => a + b, 0) !== 100) {
    errors.push('weights must add up to 100');
  }
  const seen = new Set();
  for (const c of s.configs ?? []) {
    // 0.9.4: a row with anything in it must name its release. Rows with
    // neither key are dropped by normalizeSettings before they get here;
    // a row with exactly one of the two is rejected here instead of
    // silently stored (the ["", "", "TEAM"] row that broke publish in
    // 0.9.1/0.9.2). A row with neither key passed directly (not through
    // normalizeSettings) is rejected here too.
    const hasAnything = c.projectKey || c.version || c.spaceKey
      || c.bitbucketWorkspace || c.bitbucketRepoSlug || c.digestEnabled;
    if (hasAnything && (!c.projectKey || !c.version)) {
      errors.push('release config needs both a project key and a version (e.g. SHIP 1.4.0)');
    }
    if (c.projectKey && !PROJECT_KEY_RE.test(c.projectKey)) {
      errors.push('projectKey must look like a Jira project key (e.g. SHIP)');
    }
    if (c.version && !VERSION_RE.test(c.version)) {
      errors.push('version must be a plain version string (e.g. 1.4.0)');
    }
    if (c.spaceKey && !SPACE_KEY_RE.test(c.spaceKey)) {
      errors.push('spaceKey must look like a Confluence space key (e.g. TEAM)');
    }
    if (c.bitbucketWorkspace && !BITBUCKET_SLUG_RE.test(c.bitbucketWorkspace)) {
      errors.push('bitbucketWorkspace must be a lowercase slug (letters, digits, - and _)');
    }
    if (c.bitbucketRepoSlug && !BITBUCKET_SLUG_RE.test(c.bitbucketRepoSlug)) {
      errors.push('bitbucketRepoSlug must be a lowercase slug (letters, digits, - and _)');
    }
    if (c.projectKey && c.version) {
      const key = `${c.projectKey}:${c.version}`;
      if (seen.has(key)) errors.push(`two release configs share the same project and version (${key})`);
      seen.add(key);
    }
  }
  return errors;
}
