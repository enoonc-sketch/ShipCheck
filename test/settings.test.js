import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, normalizeSettings, validateSettings, publicSettings,
  extractLegacySecrets, resolveReleaseConfig, normalizeReleaseConfig, resolvePublishSpace,
  digestSentKeyFor, lastDigestKeyFor, pushedKeyFor,
  SECRET_COARENA_KEY, SECRET_BITBUCKET_KEY, DEFAULT_WEIGHTS,
} from '../src/settings.js';

test('defaults are zero-config: demo mode on, Friday digest, AI on, default weights, no configs', () => {
  assert.equal(DEFAULT_SETTINGS.demoMode, true);
  assert.equal(DEFAULT_SETTINGS.digestDay, 5);
  assert.equal(DEFAULT_SETTINGS.aiSummaryEnabled, true);
  assert.equal(DEFAULT_SETTINGS.pushEnabled, false);
  assert.deepEqual(DEFAULT_SETTINGS.weights, DEFAULT_WEIGHTS);
  assert.deepEqual(DEFAULT_SETTINGS.configs, []);
});

test('normalizeSettings merges stored values over defaults', () => {
  const s = normalizeSettings({
    demoMode: false, digestDay: 1, aiSummaryEnabled: false, pushEnabled: true,
    weights: { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 10 },
  });
  assert.equal(s.demoMode, false);
  assert.equal(s.digestDay, 1);
  assert.equal(s.aiSummaryEnabled, false);
  assert.equal(s.pushEnabled, true);
  assert.deepEqual(s.weights, { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 10 });
});

test('0.7.0 P1-10: legacy flat settings migrate into one release config', () => {
  const s = normalizeSettings({
    demoMode: false, digestDay: 1, aiSummaryEnabled: false,
    projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', digestEnabled: true,
    bitbucketWorkspace: 'enoonc', bitbucketRepoSlug: 'shipcheck', bitbucketDeployBranch: 'develop',
    coarenaApiKey: 'key-1', bitbucketApiToken: 'tok-1',
  });
  assert.equal(s.configs.length, 1);
  assert.deepEqual(s.configs[0], {
    projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', digestEnabled: true,
    bitbucketWorkspace: 'enoonc', bitbucketRepoSlug: 'shipcheck', bitbucketDeployBranch: 'develop',
  });
  // Secrets are NOT carried into the normalized settings (P1-5).
  assert.equal(s.coarenaApiKey, undefined);
  assert.equal(s.bitbucketApiToken, undefined);
});

test('0.7.0 P1-5: extractLegacySecrets pulls the old-location secrets out', () => {
  const secrets = extractLegacySecrets({ coarenaApiKey: 'key-1', bitbucketApiToken: 'tok-1' });
  assert.deepEqual(secrets, { coarenaApiKey: 'key-1', bitbucketApiToken: 'tok-1' });
  assert.deepEqual(extractLegacySecrets({}), { coarenaApiKey: '', bitbucketApiToken: '' });
  assert.deepEqual(extractLegacySecrets(null), { coarenaApiKey: '', bitbucketApiToken: '' });
  assert.equal(SECRET_COARENA_KEY, 'shipcheck:secrets:coarena');
  assert.equal(SECRET_BITBUCKET_KEY, 'shipcheck:secrets:bitbucket');
});

test('normalizeSettings never throws on junk input', () => {
  const s = normalizeSettings(null);
  assert.equal(s.demoMode, true);
  assert.deepEqual(s, DEFAULT_SETTINGS);
  const weird = normalizeSettings({ demoMode: 'yes', digestDay: 9, aiSummaryEnabled: 0 });
  assert.equal(weird.demoMode, true);
  assert.equal(weird.digestDay, 5); // out of range -> default
  assert.equal(weird.aiSummaryEnabled, false);
});

test('normalizeSettings coerces booleans and clamps digestDay', () => {
  assert.equal(normalizeSettings({ demoMode: 0 }).demoMode, false);
  assert.equal(normalizeSettings({ demoMode: 'yes' }).demoMode, true);
  assert.equal(normalizeSettings({ digestDay: 9 }).digestDay, 5);
  assert.equal(normalizeSettings({ digestDay: -2 }).digestDay, 5);
  assert.equal(normalizeSettings({ digestDay: 0 }).digestDay, 0);
});

test('normalizeSettings trims whitespace in configs', () => {
  const s = normalizeSettings({ configs: [{ projectKey: '  SHIP  ', version: '1.4.0' }] });
  assert.equal(s.configs[0].projectKey, 'SHIP');
});

test('validateSettings flags bad project/space/bitbucket keys in a config', () => {
  assert.ok(validateSettings(normalizeSettings({ projectKey: 'ship' })).some((e) => e.includes('projectKey')));
  // 0.9.4: a row without projectKey + version is dropped by
  // normalizeSettings before format checks run, so these inputs carry a
  // complete row — the format of the bad field is what is being tested.
  assert.ok(validateSettings(normalizeSettings({ projectKey: 'SHIP', version: '1.4.0', spaceKey: 'team space' })).some((e) => e.includes('spaceKey')));
  assert.ok(validateSettings(normalizeSettings({ projectKey: 'SHIP', version: '1.4.0', bitbucketWorkspace: 'Bad WS' })).some((e) => e.includes('bitbucketWorkspace')));
  assert.ok(validateSettings(normalizeSettings({ projectKey: 'SHIP', version: '1.4.0', bitbucketRepoSlug: 'Bad Repo' })).some((e) => e.includes('bitbucketRepoSlug')));
  assert.ok(validateSettings(normalizeSettings({ version: '1.4.0 beta!' })).some((e) => e.includes('version')));
  assert.ok(validateSettings({ digestDay: 9 }).some((e) => e.includes('digestDay')));
});

test('validateSettings accepts a fully configured setup', () => {
  const errors = validateSettings(normalizeSettings({
    demoMode: false, digestDay: 5,
    configs: [{ projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', digestEnabled: true }],
  }));
  assert.deepEqual(errors, []);
});

test('validateSettings accepts an unconfigured setup (demo mode covers it)', () => {
  assert.deepEqual(validateSettings(normalizeSettings({})), []);
});

test('0.7.0 P1-3: validateSettings flags weights that do not add up to 100', () => {
  const bad = normalizeSettings({ weights: { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 5 } });
  assert.ok(validateSettings(bad).some((e) => e.includes('add up to 100')));
  const good = normalizeSettings({ weights: { blockers: 50, pullRequests: 20, issuesDone: 20, docs: 10 } });
  assert.deepEqual(validateSettings(good), []);
  const outOfRange = normalizeSettings({ weights: { blockers: 120, pullRequests: 25, issuesDone: 20, docs: 15 } });
  assert.ok(validateSettings(outOfRange).some((e) => e.includes('weights.blockers')));
});

test('0.7.0 P1-10: validateSettings flags two configs for the same release', () => {
  const s = normalizeSettings({
    configs: [
      { projectKey: 'SHIP', version: '1.4.0' },
      { projectKey: 'SHIP', version: '1.4.0' },
    ],
  });
  assert.ok(validateSettings(s).some((e) => e.includes('same project and version')));
  const ok = normalizeSettings({
    configs: [
      { projectKey: 'SHIP', version: '1.4.0' },
      { projectKey: 'SHIP', version: '1.5.0' },
    ],
  });
  assert.deepEqual(validateSettings(ok), []);
});

test('publicSettings never includes secret values, only booleans', () => {
  const s = normalizeSettings({
    coarenaApiKey: 'secret-1', bitbucketApiToken: 'tok-1',
    projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM',
  });
  const p = publicSettings(s, { hasCoarenaKey: true, hasBitbucketToken: true, hasSlackWebhook: true });
  assert.equal(p.hasCoarenaKey, true);
  assert.equal(p.hasBitbucketToken, true);
  assert.equal(p.hasSlackWebhook, true);
  assert.equal(p.coarenaApiKey, undefined);
  assert.equal(p.bitbucketApiToken, undefined);
  assert.equal(p.slackWebhookUrl, undefined);
  assert.equal(p.configs[0].projectKey, 'SHIP');
  assert.equal(JSON.stringify(p).includes('secret-1'), false);
  assert.equal(JSON.stringify(p).includes('tok-1'), false);
  // No secrets saved at all -> all flags false.
  const empty = publicSettings(normalizeSettings({}));
  assert.equal(empty.hasCoarenaKey, false);
  assert.equal(empty.hasBitbucketToken, false);
  assert.equal(empty.hasSlackWebhook, false);
});

test('0.7.0 P1-5: publicSettings flags secrets still in the legacy location', () => {
  const p = publicSettings(normalizeSettings({}), { secretsLegacy: true });
  assert.equal(p.secretsLegacy, true);
  assert.equal(publicSettings(normalizeSettings({})).secretsLegacy, false);
});

test('0.7.0 P1-10: resolveReleaseConfig picks the right config', () => {
  const s = normalizeSettings({
    configs: [
      { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM' },
      { projectKey: 'SHIP', version: '1.5.0', spaceKey: 'TEAM' },
      { projectKey: 'CORE', version: '2.0.0', spaceKey: 'CORE' },
    ],
  });
  assert.equal(resolveReleaseConfig(s, 'SHIP', '1.5.0').spaceKey, 'TEAM');
  assert.equal(resolveReleaseConfig(s, 'SHIP', '1.5.0').version, '1.5.0');
  assert.equal(resolveReleaseConfig(s, 'CORE', '2.0.0').projectKey, 'CORE');
  assert.equal(resolveReleaseConfig(s, 'SHIP', '9.9.9'), null); // no such version
  assert.equal(resolveReleaseConfig(s, 'SHIP').version, '1.4.0'); // first of the project
  assert.equal(resolveReleaseConfig(s).version, '1.4.0'); // first config overall
  assert.equal(resolveReleaseConfig(normalizeSettings({})), null); // nothing configured
});

test('0.7.0 P1-10: resolveReleaseConfig falls back to legacy flat settings', () => {
  const legacy = { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM' };
  assert.equal(resolveReleaseConfig(legacy, 'SHIP', '1.4.0').spaceKey, 'TEAM');
  assert.equal(resolveReleaseConfig(legacy, 'SHIP', '1.5.0'), null);
  assert.equal(resolveReleaseConfig({}, 'SHIP', '1.4.0'), null);
});

test('0.7.0 P1-8/P1-11: per-config digest and push keys are distinct per release', () => {
  assert.equal(digestSentKeyFor('SHIP', '1.4.0'), 'shipcheck:last-digest-sent:SHIP:1.4.0');
  assert.notEqual(digestSentKeyFor('SHIP', '1.4.0'), digestSentKeyFor('SHIP', '1.5.0'));
  assert.equal(lastDigestKeyFor('SHIP', '1.4.0'), 'shipcheck:last-digest:SHIP:1.4.0');
  assert.equal(pushedKeyFor('1.4.0', '2026-11-16'), 'shipcheck:pushed:1.4.0:2026-11-16');
  assert.notEqual(pushedKeyFor('1.4.0', '2026-11-16'), pushedKeyFor('1.4.0', '2026-11-17'));
});

test('settings round-trip through storage keeps globals and configs', () => {
  const input = {
    demoMode: true, digestDay: 5, aiSummaryEnabled: true, pushEnabled: false,
    weights: { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 },
    configs: [{ projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', digestEnabled: true, bitbucketWorkspace: 'enoonc', bitbucketRepoSlug: 'shipcheck', bitbucketDeployBranch: 'main' }],
  };
  const s = normalizeSettings(input);
  assert.deepEqual(validateSettings(s), []);
  const p = publicSettings(s);
  assert.equal(p.demoMode, true);
  assert.equal(p.configs[0].bitbucketRepoSlug, 'shipcheck');
  assert.equal(p.configs[0].digestEnabled, true);
});

test('normalizeReleaseConfig defaults the deploy branch to main', () => {
  assert.equal(normalizeReleaseConfig({}).bitbucketDeployBranch, 'main');
  assert.equal(normalizeReleaseConfig({ bitbucketDeployBranch: 'develop' }).bitbucketDeployBranch, 'develop');
});

// ---- 0.9.1: the publish space is resolved ONCE, on the backend --------------
// Live failure (0.9.0): the panel fell back to configs[0].spaceKey when no row
// matched the typed project/version, while the backend matched strictly and saw
// no space -> "spaceKey does not match the configured docs space".

const PUBLISH_SETTINGS = normalizeSettings({
  configs: [
    { projectKey: 'PROJ', version: '1.0', spaceKey: 'TEAM' },
    { projectKey: 'SHIP', version: '1.4.0', spaceKey: 'DOCS' },
    { projectKey: 'NOSP', version: '2.0' },
  ],
});

test('resolvePublishSpace: the exact project+version row decides the space (not the first row)', () => {
  const r = resolvePublishSpace(PUBLISH_SETTINGS, { projectKey: 'SHIP', version: '1.4.0' }, {});
  assert.equal(r.spaceKey, 'DOCS');
});

test('resolvePublishSpace: typed values that match nothing fall back to the context the adapter resolved', () => {
  const r = resolvePublishSpace(PUBLISH_SETTINGS, { projectKey: 'ship ', version: ' 1.4.0' }, { projectKey: 'SHIP', version: '1.4.0' });
  assert.equal(r.spaceKey, 'DOCS');
});

test('resolvePublishSpace: never silently uses another release\'s space', () => {
  assert.throws(
    () => resolvePublishSpace(PUBLISH_SETTINGS, { projectKey: 'SHIP', version: '9.9' }, { projectKey: 'SHIP', version: '9.9' }),
    /no release config/i,
  );
});

test('resolvePublishSpace: a matching row without a space key says so (not "does not match")', () => {
  assert.throws(
    () => resolvePublishSpace(PUBLISH_SETTINGS, { projectKey: 'NOSP', version: '2.0' }, {}),
    (e) => /no Confluence space key/i.test(e.message) && !/does not match/i.test(e.message),
  );
});

test('resolvePublishSpace: no settings rows at all -> clear "no release config" error', () => {
  assert.throws(() => resolvePublishSpace(normalizeSettings({}), { projectKey: 'SHIP', version: '1.4.0' }, {}), /no release config/i);
});

test('resolvePublishSpace: empty payload uses the default (first) release, like the dashboard', () => {
  const r = resolvePublishSpace(PUBLISH_SETTINGS, { projectKey: '', version: '' }, {});
  assert.equal(r.spaceKey, 'TEAM');
});

test('resolvePublishSpace: legacy flat settings still resolve to their one space', () => {
  const r = resolvePublishSpace({ projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM' }, { projectKey: 'SHIP', version: '1.4.0' }, {});
  assert.equal(r.spaceKey, 'TEAM');
});

// ---- 0.9.2: the "no release config" error shows what the backend actually saw ----
// Live case: the admin page showed SHIP / 1.4.0 / TEAM yet the publish said no
// config matched. The message must expose invisible characters and the saved
// rows so the mismatch is visible instead of guessed.

function publishError(settings, entered) {
  try { resolvePublishSpace(settings, entered, {}); } catch (e) { return e.message; }
  assert.fail('expected resolvePublishSpace to throw');
}

test('no-config error keeps its leading text and lists the saved rows', () => {
  const msg = publishError(PUBLISH_SETTINGS, { projectKey: 'SHIP', version: '9.9' });
  assert.match(msg, /^No release config for SHIP 9\.9/);
  assert.match(msg, /"PROJ"/);
  assert.match(msg, /"1\.4\.0"/);
  assert.match(msg, /"DOCS"/);
});

test('no-config error escapes look-alike letters in a saved row', () => {
  // A Cyrillic look-alike (DZE, U+0405) is NOT stripped by the key
  // cleaner — it is a real letter — so a row saved with it still does
  // not match, and the error must show it escaped, not as a "SHIP"
  // the admin cannot tell apart on the settings page.
  const s = normalizeSettings({ configs: [{ projectKey: '\u0405HIP', version: '1.4.0', spaceKey: 'TEAM' }] });
  const msg = publishError(s, { projectKey: 'SHIP', version: '1.4.0' });
  assert.match(msg, /\\u0405/, 'look-alike letter must be shown as \\u0405');
  assert.ok(!msg.includes('\u0405'), 'raw look-alike character must not appear in the message');
});

test('no-config error stays short enough for the panel to show it whole', () => {
  // Live 2026-11-17 06:36: the 0.9.2 diagnostic was cut off by the
  // panel display, so the saved rows never reached the admin. The
  // message now leads with the rows and fits one line.
  const s = normalizeSettings({ configs: [{ projectKey: 'SHIP', version: '9.9.9', spaceKey: 'TEAM' }] });
  const msg = publishError(s, { projectKey: 'SHIP', version: '1.4.0' });
  assert.match(msg, /^No release config for SHIP 1\.4\.0/);
  assert.match(msg, /Saved: \["SHIP", "9\.9\.9", "TEAM"\]/);
  assert.ok(msg.length < 140, `message must fit the panel display, got ${msg.length} chars: ${msg}`);
});

test('no-config error with nothing saved says so', () => {
  const msg = publishError(normalizeSettings({}), { projectKey: 'SHIP', version: '1.4.0' });
  assert.match(msg, /Saved: \(none\)/);
});

// ---- 0.9.3: invisible characters in a saved key must not break the match ----
// Live suspect (2026-11-17 06:05): the settings page shows SHIP / 1.4.0 /
// TEAM yet the backend finds no row. A zero-width space pasted into a key
// renders as the plain key on the page but never equals the clean value
// the panel sends. Keys are now cleaned on read AND on save, so a dirty
// stored value still matches — and a re-save stores the clean value.

test('normalizeReleaseConfig strips zero-width characters from keys', () => {
  const c = normalizeReleaseConfig({ projectKey: 'SH\u200bIP', version: '1.4.0\u200b', spaceKey: 'TE\u200bAM' });
  assert.equal(c.projectKey, 'SHIP');
  assert.equal(c.version, '1.4.0');
  assert.equal(c.spaceKey, 'TEAM');
});

test('resolveReleaseConfig matches a stored row that carries zero-width characters', () => {
  const c = resolveReleaseConfig({ configs: [{ projectKey: 'SH\u200bIP', version: '1.4.0', spaceKey: 'TEAM' }] }, 'SHIP', '1.4.0');
  assert.ok(c, 'row with a zero-width space must still match');
  assert.equal(c.spaceKey, 'TEAM');
});

test('resolvePublishSpace matches despite a zero-width space in the stored row', () => {
  const s = normalizeSettings({ configs: [{ projectKey: 'SHIP', version: '1.4.0\u200b', spaceKey: 'TEAM' }] });
  const r = resolvePublishSpace(s, { projectKey: 'SHIP', version: '1.4.0' }, {});
  assert.equal(r.spaceKey, 'TEAM');
});

// ---- 0.9.4: a release config row must name its release --------------------
// Live root cause of the 0.9.1/0.9.2 publish failures (found by the 1.0
// Stage 0 review): a row with only a space key — ["", "", "TEAM"] — was
// stored as if it were valid, because isEmptyConfig only filtered FULLY
// empty rows and validateSettings only checked the format of non-empty
// fields. The zero-width-character theory was never reproduced; the hole
// was the missing completeness check. A row is now either complete
// (project key + version; the space key is checked at publish time) or it
// does not exist: normalizeSettings drops rows with neither key,
// validateSettings rejects rows with exactly one of the two.

test('0.9.4: normalizeSettings drops the live ["", "", "TEAM"] row', () => {
  const s = normalizeSettings({ configs: [{ projectKey: '', version: '', spaceKey: 'TEAM' }] });
  assert.deepEqual(s.configs, []);
  // A row with only a Bitbucket field is equally unaddressable.
  const b = normalizeSettings({ configs: [{ bitbucketWorkspace: 'acme', bitbucketRepoSlug: 'shipcheck' }] });
  assert.deepEqual(b.configs, []);
  // A legacy flat shape with only a space key drops the same way.
  assert.deepEqual(normalizeSettings({ spaceKey: 'TEAM' }).configs, []);
});

test('0.9.4: validateSettings rejects a row with exactly one of projectKey/version', () => {
  const noVersion = validateSettings({ configs: [{ projectKey: 'SHIP', version: '', spaceKey: 'TEAM' }] });
  assert.ok(noVersion.some((e) => e.includes('project key') && e.includes('version')));
  const noProject = validateSettings({ configs: [{ projectKey: '', version: '1.4.0', spaceKey: 'TEAM' }] });
  assert.ok(noProject.some((e) => e.includes('project key') && e.includes('version')));
  // The space-key-only row is rejected too when it reaches validation
  // directly (normalizeSettings drops it first on the save path).
  const spaceOnly = validateSettings({ configs: [{ projectKey: '', version: '', spaceKey: 'TEAM' }] });
  assert.ok(spaceOnly.some((e) => e.includes('project key') && e.includes('version')));
});

test('0.9.4: the live SHIP/1.4.0/TEAM row and an empty setup still pass', () => {
  const ok = validateSettings(normalizeSettings({
    configs: [{ projectKey: 'SHIP', version: '1.4.0', spaceKey: 'TEAM', digestEnabled: true }],
  }));
  assert.deepEqual(ok, []);
  assert.deepEqual(validateSettings(normalizeSettings({})), []);
  assert.deepEqual(validateSettings(normalizeSettings({ configs: [] })), []);
  // A fully empty row is dropped, not an error.
  assert.deepEqual(normalizeSettings({ configs: [{ projectKey: '', version: '', spaceKey: '' }] }).configs, []);
});
