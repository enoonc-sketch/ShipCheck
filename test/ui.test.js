// Static smoke tests for the ShipCheck Custom UI (static/ui/index.html +
// static/ui/src/app.js — Vite layout since 0.4.0).
// Written FIRST, before the UI rewrite (TDD, per T's Claude-method standard).
// These assert the Apple-light standard and the required UI states exist in the
// shipped files — they do not need a browser or a Forge runtime.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../static/ui/index.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../static/ui/src/app.js', import.meta.url), 'utf8');

test('Apple-light tokens: #F5F5F7 background, white cards, #007AFF accent', () => {
  assert.match(html, /--bg:\s*#F5F5F7/);
  assert.match(html, /--card:\s*#fff/);
  assert.match(html, /--blue:\s*#007AFF/);
  assert.match(html, /--green:\s*#34C759/);
  assert.match(html, /--amber:\s*#FF9F0A/);
  assert.match(html, /--red:\s*#FF3B30/);
});

test('card corners are 14-20px and the base font is 16px', () => {
  assert.match(html, /border-radius:\s*1[4-9]px|border-radius:\s*20px/);
  assert.match(html, /font:\s*16px\/1\.5/);
});

test('no small annotation text anywhere in the UI (minimum 13px)', () => {
  const sizes = [...html.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0, 'expected at least one font-size rule');
  assert.ok(sizes.every((n) => n >= 13), `found a font-size below 13px: ${sizes.join(', ')}`);
});

test('dashboard has loading, error and empty states (no bare hidden cards)', () => {
  assert.match(html, /id="loading"/);
  assert.match(html, /id="error"/);
  assert.match(html, /id="empty"/);
  assert.match(html, /id="retry"/);
  assert.match(js, /loading/);
  assert.match(js, /showError|renderError/);
});

test('errors are rendered inline, never via alert()', () => {
  assert.doesNotMatch(js, /alert\s*\(/);
});

test('demo-mode banner exists so judges can tell demo data from real data', () => {
  assert.match(html, /id="demoBanner"/);
  assert.match(js, /demoBanner/);
});

test('version-trend card exists on the dashboard', () => {
  assert.match(html, /id="trend"/);
  assert.match(js, /getScoreTrend|recordScore/);
});

test('issue-panel and admin views exist (module-aware rendering)', () => {
  assert.match(html, /id="issueView"/);
  assert.match(html, /id="adminView"/);
  assert.match(js, /getIssueContext/);
  assert.match(js, /getSettings|saveSettings/);
  assert.match(js, /getContext/);
});

test('admin view exposes demo mode and the weekly digest toggle', () => {
  assert.match(html, /demoMode/);
  assert.match(html, /digestEnabled/);
});

test('result cards are revealed with show(), never `.hidden = false`', () => {
  // The cards start with class="card hidden" and `.hidden` is a CSS class
  // (display:none): setting the DOM `hidden` property leaves the class in
  // place, so the score never renders (seen live 2026-11-16 — invokes
  // succeeded, no error, no score). show()/hide() toggle the class.
  assert.doesNotMatch(js, /\.hidden\s*=\s*false/);
  assert.match(js, /show\(\$\('scoreCard'\)\)/);
  assert.match(js, /show\(\$\('blockersCard'\)\)/);
  assert.match(js, /show\(\$\('notesCard'\)\)/);
});

test('dashboard shows the latest weekly digest (getLatestDigest resolver)', () => {
  assert.match(html, /id="digestCard"/);
  assert.match(html, /id="digestBody"/);
  assert.match(js, /getLatestDigest/);
  // The stored digest has `subject` + `sentAt` (src/digest.js, src/trigger.js),
  // not Claude's `headline` / `generatedAt` (which would render "undefined").
  assert.match(js, /d\.subject/);
  assert.match(js, /d\.sentAt/);
  assert.doesNotMatch(js, /d\.headline/);
  assert.doesNotMatch(js, /d\.generatedAt/);
  // A stored value without a subject must show the empty state, never the
  // literal text "undefined" (seen live 2026-11-16).
  assert.match(js, /!d\.subject/);
});

test('Vite entry: app.js imports @forge/bridge directly (resolved by Vite)', () => {
  assert.match(js, /from '@forge\/bridge'/);
  assert.doesNotMatch(js, /from '\.\/bridge\.js'/);
});

test('Vite entry: index.html loads /src/app.js as the module entry', () => {
  assert.match(html, /<script type="module" src="\/src\/app\.js"><\/script>/);
});

test('dashboard shows a data-sources line under the breakdown (P1-3)', () => {
  assert.match(html, /id="dataSources"/);
  assert.match(js, /renderDataSources/);
  // The label lives in the dictionary now (0.8.0, P2-1), not as a literal.
  assert.match(js, /t\('sources\.label'\)/);
  assert.match(js, /readiness\.dataSources/);
  assert.match(js, /readiness\.dataGaps/);
  assert.match(js, /sources\.notConnected/);
});

test('recordScore sends only the version; the backend recomputes the score (P0-4)', () => {
  assert.match(js, /invoke\('recordScore', \{ version: readiness\.version \}\)/);
  assert.doesNotMatch(js, /score: readiness\.score/);
  assert.doesNotMatch(js, /verdict: readiness\.verdict/);
});

test('admin view exposes the release-config editor, weights, push switch and digest status (0.7.0)', () => {
  // P1-10: releases are a list of configs rendered from a <template>;
  // fields are data-field (cloned rows must not duplicate ids).
  assert.match(html, /id="configList"/);
  assert.match(html, /id="configRowTemplate"/);
  assert.match(html, /data-field="projectKey"/);
  assert.match(html, /data-field="version"/);
  assert.match(html, /data-field="spaceKey"/);
  assert.match(html, /data-field="digestEnabled"/);
  assert.match(html, /data-field="bitbucketWorkspace"/);
  assert.match(html, /data-field="bitbucketRepoSlug"/);
  assert.match(html, /data-field="bitbucketDeployBranch"/);
  assert.match(html, /id="addConfig"/);
  // P1-3: configurable weights (default 40/25/20/15) with a live total.
  assert.match(html, /id="setWeightBlockers"/);
  assert.match(html, /id="setWeightPullRequests"/);
  assert.match(html, /id="setWeightIssuesDone"/);
  assert.match(html, /id="setWeightDocs"/);
  assert.match(html, /id="weightsSum"/);
  // P1-11: push-comments switch. P1-8: digest status + run-now.
  assert.match(html, /id="pushEnabled"/);
  assert.match(html, /id="digestStatus"/);
  assert.match(html, /id="runDigestNow"/);
  assert.match(html, /id="runDigestConfig"/);
  // Bitbucket token + AI summary switch stay as global fields.
  assert.match(html, /id="setBitbucketApiToken"/);
  assert.match(html, /id="removeBitbucketToken"/);
  assert.match(html, /id="aiSummaryEnabled"/);
  assert.match(js, /configRowValues|collectConfigs/);
  assert.match(js, /setWeightBlockers/);
  assert.match(js, /pushEnabled/);
  assert.match(js, /getDigestStatus/);
  assert.match(js, /runDigestNow/);
  // The disabled-state copy lives in the dictionary now (0.8.0, P2-1).
  assert.match(js, /t\('ai\.bodyDisabled'\)/);
});

test('dashboard shows todos, rescale coverage and data freshness (0.7.0)', () => {
  assert.match(html, /id="todosCard"/);
  assert.match(html, /id="todos"/);
  assert.match(html, /id="coverage"/);
  assert.match(html, /id="updatedAt"/);
  assert.match(js, /renderTodos/);
  assert.match(js, /readiness\.todos/);
  assert.match(js, /readiness\.coverage/);
  assert.match(js, /readiness\.dataUpdatedAt/);
  assert.match(js, /readiness\.fromCache/);
  assert.match(js, /readiness\.weights/);
});

test('issue panel shows score drag and linked PRs (0.7.0, P1-9)', () => {
  assert.match(html, /id="issueScoreDrag"/);
  assert.match(html, /id="issuePrs"/);
  assert.match(js, /scoreDrag/);
  assert.match(js, /linkedPullRequests/);
  assert.match(js, /matchedVia/);
  // The assignee line lives in the dictionary now (0.8.0, P2-1).
  assert.match(js, /issue\.assignee/);
});

// ------------------------------------------------------------- 0.8.0 (P2-1)

test('language switcher exists (English / 简体中文）, default English', async () => {
  assert.match(html, /id="langSelect"/);
  assert.match(html, /value="en"/);
  assert.match(html, /value="zh-CN"/);
  assert.match(js, /langSelect/);
  assert.match(js, /setLang|getLang/);
  // Persistence lives in the i18n module (localStorage 'shipcheck-lang').
  const i18n = await readFile(new URL('../static/ui/src/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /shipcheck-lang/);
});

test('all UI copy goes through the i18n dictionary, not hardcoded literals', () => {
  assert.match(js, /from '\.\/i18n\.js'/);
  assert.match(js, /t\('/);
  // Strings that moved into the dictionary must not remain as literals.
  for (const s of [
    'Nothing missing', 'ShipCheck failed', 'Generate AI summary',
    'Set a Confluence space key', 'AI summary is disabled',
    'Type an issue key', 'No pull requests linked to this issue',
    'Settings saved', 'Key saved — leave blank',
  ]) {
    assert.ok(!js.includes(s), `app.js still contains hardcoded copy: ${s}`);
  }
});

test('dashboard renders the verdict through i18n (code stays the CSS class)', () => {
  assert.match(js, /t\('verdict\.' \+ readiness\.verdict\)/);
});

// ------------------------------------------------------------- 0.8.0 (P2-2)

test('"why this score" expander exists on the score card', () => {
  assert.match(html, /id="explainDetails"/);
  assert.match(html, /id="explanation"/);
  assert.match(js, /renderExplanation|explanation/);
  assert.match(js, /getReadiness/);
});

test('repeated UI patterns are named component functions, not inline HTML soup', () => {
  assert.match(js, /function barRow\(/);
  assert.match(js, /function pill\(/);
  assert.match(js, /function explainRow\(/);
});

// ------------------------------------------------------------- 0.9.2
// Live failure 2026-11-17 06:05: the 0.9.1 panel said "No release config
// found for SHIP 1.4.0" while the Settings page STILL showed the row —
// and the 0.9.1 panel refused to invoke at all, so the backend never got
// a chance to say what it saw. 0.9.2 moves the decision to the backend
// (resolvePublishSpace): the panel sends only projectKey + version, and
// the backend's error names what was searched for and which rows are
// saved. The panel must not resolve anything locally and must not hide
// the backend's answer behind a local message.

test('publishNotes sends only projectKey + version — the backend resolves the space (0.9.2)', () => {
  const start = js.indexOf('async function publishNotes');
  assert.ok(start >= 0, 'publishNotes missing');
  const end = js.indexOf('\nasync function ', start + 1);
  const body = js.slice(start, end >= 0 ? end : undefined);
  assert.ok(!body.includes('configs[0]'), 'publishNotes still falls back to configs[0]');
  assert.ok(!body.includes('spaceKey'), 'publishNotes still sends a spaceKey');
  assert.ok(!body.includes('notes.noConfig'), 'publishNotes still hides the backend diagnostic behind a local message');
  assert.match(body, /invoke\('publishReleaseNotes'/);
  assert.ok(body.includes('projectKey') && body.includes('version'), 'publishNotes must send projectKey + version');
});
