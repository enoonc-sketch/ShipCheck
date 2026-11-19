// ShipCheck Custom UI — Vite entry (static/ui/src/app.js). Built by Vite
// (`npm run build:ui`) into static/ui/build, which manifest.yml serves.
// '@forge/bridge' is resolved by Vite from static/ui/node_modules.
// One static app serves three modules; view.getContext() picks the view:
//   jira.projectPage -> dashboard, jira.issuePanel -> issue view,
//   jira.adminPage   -> admin view. Without a bridge context (local preview)
//   it falls back to the dashboard.
//
// Every async flow has three states: loading (skeleton), error (inline card
// with retry), empty (guidance, no dead end). Errors always render inline
// on the page so the user never loses their place.
// In local mode (no Forge) this file is not executed; run-local.js is the demo.
//
// 0.8.0 (P2-1): every user-facing string goes through the i18n dictionary
// (./i18n.js, English + Simplified Chinese). Static text in index.html is
// marked data-i18n; dynamic text here uses t(). The language switcher in
// the header persists per browser and re-renders the current view.
// 0.8.0 (P2-2): repeated markup is built by named component functions
// (barRow, pill, explainRow) instead of inline template soup, and the
// score card has a "why this score" expander fed by the backend's
// structured explanation (src/scoring.js explainScore) — no framework
// swap: the UI keeps the Apple-light tokens T fixed, so Atlassian's own
// components (different blues, different radius) were not adopted.
import { invoke, view } from '@forge/bridge';
import { t, getLang, setLang, applyI18n } from './i18n.js';

const $ = (id) => document.getElementById(id);
const COLORS = { READY: '#34C759', CAUTION: '#FF9F0A', BLOCKED: '#FF3B30' };

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ------------------------------------------------------------ components
// 0.8.0 (P2-2): one function per repeated pattern, so a visual change is
// made in one place. All three return HTML strings; callers escape the
// variable parts (or the function does it) — never interpolate raw data.

function pill(text) {
  return `<span class="pill">${escapeHtml(text)}</span>`;
}

function listItems(items, emptyText) {
  if (!items || items.length === 0) return `<li>${escapeHtml(emptyText)}</li>`;
  return items.map((i) => `<li>${i}</li>`).join('');
}

// One slice of the score breakdown: label, value / max, a proportional bar.
// A null slice is unwired, not a measured 0 — show '—' and a grey bar.
function barRow(label, value, weight) {
  if (value === null || value === undefined) {
    return `<div class="barRow"><span>${escapeHtml(label)}</span>` +
      `<div class="bar"><div style="width:0%"></div></div>` +
      `<span>— / ${weight}</span></div>`;
  }
  const pct = weight === 0 ? 0 : Math.round((value / weight) * 100);
  return `<div class="barRow${value === 0 ? ' zero' : ''}"><span>${escapeHtml(label)}</span>` +
    `<div class="bar"><div style="width:${pct}%"></div></div>` +
    `<span>${value} / ${weight}</span></div>`;
}

// One slice of the "why this score" explanation: the value and the facts
// behind it (which blockers deducted what, how many issues are Done).
function explainRow(slice) {
  const label = t(`slice.${slice.key}`);
  const value = slice.value === null || slice.value === undefined ? '—' : slice.value;
  let detail = '';
  if (slice.state === 'excluded') {
    detail = t('explain.excluded');
  } else if (slice.key === 'blockers') {
    const lines = [];
    if (slice.facts.bugs.length > 0) lines.push(t('explain.deductBug', { keys: slice.facts.bugs.join(', ') }));
    if (slice.facts.failedDeployments.length > 0) lines.push(t('explain.deductDeploy', { keys: slice.facts.failedDeployments.join(', ') }));
    if (slice.facts.unapprovedPrs.length > 0) lines.push(t('explain.deductPr', { keys: slice.facts.unapprovedPrs.join(', ') }));
    detail = lines.length > 0 ? lines.join(' ') : t('explain.blockersNone', { max: slice.max });
  } else if (slice.key === 'pullRequests') {
    detail = slice.facts.total === 0
      ? t('explain.prsNone')
      : t('explain.prs', { good: slice.facts.good, total: slice.facts.total });
  } else if (slice.key === 'issuesDone') {
    detail = t('explain.issues', { done: slice.facts.done, total: slice.facts.total });
  } else if (slice.key === 'docs') {
    detail = slice.facts.ready ? t('explain.docsReady') : t('explain.docsNotReady');
  }
  return `<div class="explainRow"><span><b>${escapeHtml(label)}</b> ${value} / ${slice.max}</span>` +
    `<span>${escapeHtml(detail)}</span></div>`;
}

// ---------------------------------------------------------------- dashboard

function showLoading() {
  hide($('error')); hide($('empty'));
  hide($('scoreCard')); hide($('todosCard')); hide($('blockersCard')); hide($('notesCard')); hide($('aiSummaryCard'));
  show($('loading'));
  $('refresh').disabled = true;
}

function showError(message) {
  hide($('loading')); hide($('empty'));
  hide($('scoreCard')); hide($('todosCard')); hide($('blockersCard')); hide($('notesCard')); hide($('aiSummaryCard'));
  $('errorMessage').textContent = message;
  show($('error'));
  $('refresh').disabled = false;
}

function showEmpty() {
  hide($('loading')); hide($('error'));
  hide($('scoreCard')); hide($('todosCard')); hide($('blockersCard')); hide($('notesCard')); hide($('aiSummaryCard'));
  show($('empty'));
  $('refresh').disabled = false;
}

function renderBars(breakdown, weights) {
  const w = weights ?? { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 };
  const slices = [
    [t('slice.blockers'), breakdown.blockers, w.blockers],
    [t('slice.pullRequests'), breakdown.pullRequests, w.pullRequests],
    [t('slice.issuesDone'), breakdown.issuesDone, w.issuesDone],
    [t('slice.docs'), breakdown.docs, w.docs],
  ];
  $('bars').innerHTML = slices.map(([label, value, weight]) => barRow(label, value, weight)).join('');
}

// 0.7.0 (P1-2): when some sources are unwired, the score is rescaled over
// the connected ones — say so, or the number reads as if it were out of 100
// measured sources.
function renderCoverage(readiness) {
  const el = $('coverage');
  if (!readiness.coverage) { el.textContent = ''; return; }
  el.textContent = t('coverage.basedOn', { connected: readiness.coverage.connected, total: readiness.coverage.total }) +
    (readiness.rescaled ? t('coverage.rescaled') : '');
}

function renderUpdatedAt(readiness) {
  const el = $('updatedAt');
  if (!readiness.dataUpdatedAt) { el.textContent = ''; return; }
  const when = new Date(readiness.dataUpdatedAt).toLocaleString();
  el.textContent = t('updated.data', { when }) + (readiness.fromCache ? t('updated.cached') : '');
}

// 0.8.0 (P2-2): the expander under the score. The backend sends structured
// facts; this only formats them. An empty release flags itself so the
// slices (which sum to 40 on an empty release) cannot be misread.
function renderExplanation(readiness) {
  const el = $('explanation');
  const ex = readiness.explanation;
  if (!ex || !ex.slices) { el.innerHTML = ''; return; }
  const notes = ex.isEmpty
    ? `<p class="hint">${escapeHtml(t('explain.empty'))}</p>`
    : '';
  el.innerHTML = notes + ex.slices.map(explainRow).join('');
}

// The todo text comes from the backend as English prose; render it from the
// kind + key instead so the list follows the UI language. The backend text
// stays as the fallback for a kind this UI does not know.
function todoText(todo) {
  if (todo.kind === 'bug') return t('todo.fixBug', { key: todo.key });
  if (todo.kind === 'issue') return t('todo.finish', { key: todo.key });
  if (todo.kind === 'pullRequest') return t('todo.approvePr', { id: todo.key.replace(/^PR-/, '') });
  if (todo.kind === 'deployment') return t('todo.rerunDeploy', { key: todo.key });
  if (todo.kind === 'docs') return t('todo.publishDocs');
  return todo.text;
}

// 0.7.0 (P1-7): "what's missing" — the highest-gain fix first.
function renderTodos(readiness) {
  show($('todosCard'));
  $('todos').innerHTML = listItems(
    (readiness.todos ?? []).map((td) =>
      `<b>${escapeHtml(td.key)}</b> — ${escapeHtml(todoText(td))} ${pill(t('todos.gain', { gain: td.gain }))}`),
    t('todos.empty'),
  );
}

// P1-3: one line under the breakdown saying where each slice came from —
// a 0 from an unwired source must never look like a measured 0.
function renderDataSources(dataSources, dataGaps) {
  const el = $('dataSources');
  if (!dataSources) { el.textContent = ''; return; }
  const label = (v) => v === 'live' ? t('sources.connected') : v === 'demo' ? t('sources.demo') : v === 'error' ? t('sources.error') : t('sources.notConnected');
  const parts = [
    `${t('sources.issues')}: ${label(dataSources.jira)}`,
    `${t('sources.prs')}: ${label(dataSources.pullRequests)}`,
    `${t('sources.deployments')}: ${label(dataSources.deployments)}`,
    `${t('sources.docs')}: ${label(dataSources.docs)}`,
  ];
  el.textContent = t('sources.label') + ' — ' + parts.join(' · ') +
    ((dataGaps && dataGaps.length) ? ` (${dataGaps.join('; ')})` : '');
}

async function loadReadiness(opts = {}) {
  const payload = {
    projectKey: $('projectKey').value.trim(),
    version: $('version').value.trim(),
    refresh: opts.refresh === true,
  };
  showLoading();
  try {
    const [readiness, notes, trend] = await Promise.all([
      invoke('getReadiness', payload),
      invoke('getReleaseNotes', payload),
      invoke('getScoreTrend', {}),
    ]);
    hide($('loading'));
    if (readiness.demo) show($('demoBanner')); else hide($('demoBanner'));
    if (readiness.isEmpty && !readiness.demo) { showEmpty(); return; }
    // Reveal the result cards with show() (classList) — NOT the DOM hidden
    // property: the cards start with class="card hidden" in index.html and
    // `.hidden` is a CSS class (display:none), so setting the DOM `hidden`
    // property leaves the class in place and the cards NEVER appear (seen
    // live 2026-11-16: invokes succeeded, no error, but no score rendered).
    show($('scoreCard'));
    $('ring').textContent = readiness.score;
    $('ring').style.background = COLORS[readiness.verdict];
    $('verdict').textContent = t('verdict.' + readiness.verdict);
    $('verdict').className = 'verdict ' + readiness.verdict;
    const fmt = (v) => (v === null || v === undefined ? '—' : v);
    $('breakdown').textContent = t('dash.breakdown', {
      b: fmt(readiness.breakdown.blockers),
      pr: fmt(readiness.breakdown.pullRequests),
      i: fmt(readiness.breakdown.issuesDone),
      d: fmt(readiness.breakdown.docs),
    });
    $('trend').textContent = trend && trend.label ? trend.label : '';
    renderBars(readiness.breakdown, readiness.weights);
    renderCoverage(readiness);
    renderDataSources(readiness.dataSources, readiness.dataGaps);
    renderUpdatedAt(readiness);
    renderExplanation(readiness);
    renderTodos(readiness);
    show($('blockersCard'));
    $('blockers').innerHTML = listItems(
      readiness.blockers.map((b) => `<b>${escapeHtml(b.key)}</b> — ${escapeHtml(b.summary)}`),
      t('blockers.empty'),
    );
    $('warnings').innerHTML = listItems(
      readiness.warnings.map((w) => escapeHtml(w)),
      t('warnings.empty'),
    );
    show($('notesCard'));
    $('notes').textContent = notes.markdown;
    show($('aiSummaryCard'));
    // Record this version's score for the trend card (best effort: a storage
    // failure must not break the dashboard render). Only the version is
    // sent — the backend recomputes the score from the real release
    // context (0.6.0, P0-4), so a forged score can never enter history.
    invoke('recordScore', { version: readiness.version }).catch(() => {});
  } catch (e) {
    showError(t('error.loadFailed', { msg: e.message }));
  } finally {
    $('refresh').disabled = false;
  }
}

// 0.9.2: the panel sends only projectKey + version. The publish space is
// resolved ONCE, on the backend (resolvePublishSpace) — its error names
// what was searched for and which rows are saved, so a mismatch is
// diagnosable from the UI text alone. The panel must not resolve anything
// locally and must not hide the backend's answer behind a local message:
// 0.9.1 refused to invoke when nothing matched locally, which is why the
// 06:05 live click never reached the backend's diagnosis.
async function publishNotes() {
  $('publishStatus').textContent = t('notes.publishing');
  try {
    const projectKey = $('projectKey').value.trim();
    const version = $('version').value.trim();
    const res = await invoke('publishReleaseNotes', {
      projectKey,
      version,
    });
    $('publishStatus').textContent = t('notes.published', { pageId: res.pageId });
  } catch (e) {
    $('publishStatus').textContent = t('notes.publishFailed', { msg: e.message });
  }
}

// ------------------------------------------------------------ AI summary card
// On-demand only: nothing calls the AI service until the user presses the
// button. The summary is text only — the score was already computed by the
// rule-based engine. A failed call only affects this card: the error text
// renders here with the button relabelled to retry, and the readiness
// score, blockers, notes and digest are untouched. The summary is set with
// textContent (never innerHTML) so model output can never inject markup.
let aiSummaryGenerated = false;

async function loadAiSummaryAvailability() {
  const btn = $('generateAiSummary');
  try {
    const s = await invoke('getSettings', {});
    if (s && s.aiSummaryEnabled === false) {
      // P1-4: the admin switch disables the feature entirely — no request
      // leaves the backend when it is off.
      $('aiSummaryBody').textContent = t('ai.bodyDisabled');
      btn.disabled = true;
    } else if (s && s.hasCoarenaKey) {
      $('aiSummaryBody').textContent = t('ai.bodyDefault');
      btn.disabled = false;
      btn.textContent = aiSummaryGenerated ? t('ai.regenerate') : t('ai.generate');
    } else {
      $('aiSummaryBody').textContent = t('ai.bodyNoKey');
      btn.disabled = true;
    }
  } catch (e) {
    // Best effort: leave the button enabled; the backend reports
    // not-configured if no key is saved.
  }
}

async function generateAiSummary() {
  const btn = $('generateAiSummary');
  btn.disabled = true;
  $('aiSummaryStatus').textContent = t('ai.generating');
  $('aiSummaryBody').textContent = t('ai.generatingBody');
  try {
    const res = await invoke('getAiSummary', {
      projectKey: $('projectKey').value.trim(),
      version: $('version').value.trim(),
    });
    if (res && res.ok) {
      $('aiSummaryBody').textContent = res.summary;
      $('aiSummaryStatus').textContent = '';
      btn.textContent = t('ai.regenerate');
      aiSummaryGenerated = true;
    } else {
      $('aiSummaryBody').textContent = (res && res.message)
        ? t('ai.failedWith', { msg: res.message })
        : t('ai.failed');
      $('aiSummaryStatus').textContent = '';
      btn.textContent = t('ai.tryAgain');
    }
  } catch (e) {
    $('aiSummaryBody').textContent = t('ai.failedWith', { msg: e.message });
    $('aiSummaryStatus').textContent = '';
    btn.textContent = t('ai.tryAgain');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- digest card
// Shows the latest weekly digest built by the scheduled trigger, read back
// via the getLatestDigest resolver (merged in 0.3.0). The stored digest has
// `subject` + `sentAt` (see src/digest.js / src/trigger.js) — NOT the
// `headline` / `generatedAt` names Claude's UI used, which would render
// "undefined" against this backend. Best effort: a missing digest or a
// storage failure must not break the dashboard render.
async function loadDigest() {
  try {
    const d = await invoke('getLatestDigest', {
      projectKey: $('projectKey').value.trim(),
      version: $('version').value.trim(),
    });
    // A stored value without a subject must show the empty state, never the
    // literal text "undefined" (seen live 2026-11-16).
    if (!d || !d.subject) {
      $('digestBody').textContent = t('digest.empty');
    } else {
      $('digestBody').textContent = d.subject + (d.sentAt ? t('digest.sentAt', { at: d.sentAt }) : '');
    }
    show($('digestCard'));
  } catch (e) {
    $('digestBody').textContent = t('digest.loadFailed', { msg: e.message });
    show($('digestCard'));
  }
}

// -------------------------------------------------------------- issue panel

async function loadIssue() {
  const issueKey = $('issueKey').value.trim();
  if (!issueKey) {
    $('issueEmptyMessage').textContent = t('issue.typeKey');
    hide($('issueLoading')); hide($('issueError')); hide($('issueCard'));
    show($('issueEmpty'));
    return;
  }
  hide($('issueError')); hide($('issueEmpty')); hide($('issueCard'));
  show($('issueLoading'));
  try {
    const out = await invoke('getIssueContext', {
      projectKey: $('projectKey')?.value?.trim() || undefined,
      version: $('version')?.value?.trim() || undefined,
      issueKey,
    });
    hide($('issueLoading'));
    if (!out.found) {
      $('issueEmptyMessage').textContent = t('issue.notFound', { key: issueKey });
      show($('issueEmpty'));
      return;
    }
    $('issueTitle').textContent = `${out.issue.key}: ${out.issue.summary ?? ''}`;
    $('issueBadge').textContent = out.isBlocker ? t('issue.blockerBadge') : out.issue.status;
    $('issueBadge').className = 'badge ' + (out.isBlocker ? 'BLOCKED' : 'CAUTION');
    $('issueMeta').textContent = t('issue.meta', { type: out.issue.type, priority: out.issue.priority, status: out.issue.status }) +
      (out.issue.assignee ? t('issue.assignee', { name: out.issue.assignee }) : t('issue.unassigned'));
    $('issueRelease').textContent =
      t('issue.releaseLine', {
        project: out.release.projectKey,
        version: out.release.version,
        score: out.release.score,
        verdict: t('verdict.' + out.release.verdict),
      }) + (out.isBlocker ? t('issue.blocksRelease') : '');
    // 0.7.0 (P1-9): how much the score would move if this issue were Done,
    // and the PRs linked to it (dev-status or title match).
    if (out.scoreDrag) {
      $('issueScoreDrag').textContent = out.scoreDrag.delta === 0
        ? t('issue.scoreDragZero')
        : t('issue.scoreDragGain', { from: out.release.score, to: out.scoreDrag.ifFixed, gain: out.scoreDrag.delta });
    }
    $('issuePrs').innerHTML = listItems(
      (out.linkedPullRequests ?? []).map((pr) =>
        `<b>PR #${escapeHtml(String(pr.id))}</b> — ${escapeHtml(pr.title)} (${escapeHtml(pr.state)}, via ${escapeHtml(pr.matchedVia)})`),
      t('issue.noPrs'),
    );
    $('issueBlockers').innerHTML = listItems(
      out.releaseBlockers.map((b) => `<b>${escapeHtml(b.key)}</b> — ${escapeHtml(b.summary)}`),
      t('issue.noBlockers'),
    );
    show($('issueCard'));
  } catch (e) {
    hide($('issueLoading'));
    $('issueErrorMessage').textContent = t('error.loadFailed', { msg: e.message });
    show($('issueError'));
  }
}

// ---------------------------------------------------------------- admin page
// 0.7.0 (P1-10): releases are a LIST of configs (one per project+version),
// rendered from the <template> in index.html. Fields are read by
// data-field, never by id — cloned rows must not duplicate ids.
let lastSettings = null;

function configRowValues(row) {
  const val = (field) => {
    const el = row.querySelector(`[data-field="${field}"]`);
    if (!el) return '';
    return el.type === 'checkbox' ? el.checked : el.value.trim();
  };
  return {
    projectKey: val('projectKey'),
    version: val('version'),
    spaceKey: val('spaceKey'),
    digestEnabled: val('digestEnabled'),
    bitbucketWorkspace: val('bitbucketWorkspace'),
    bitbucketRepoSlug: val('bitbucketRepoSlug'),
    bitbucketDeployBranch: val('bitbucketDeployBranch') || 'main',
  };
}

function addConfigRow(config) {
  const tpl = $('configRowTemplate');
  const row = tpl.content.firstElementChild.cloneNode(true);
  const c = config ?? {};
  const set = (field, value) => {
    const el = row.querySelector(`[data-field="${field}"]`);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = value === true;
    else el.value = value ?? '';
  };
  set('projectKey', c.projectKey);
  set('version', c.version);
  set('spaceKey', c.spaceKey);
  set('digestEnabled', c.digestEnabled);
  set('bitbucketWorkspace', c.bitbucketWorkspace);
  set('bitbucketRepoSlug', c.bitbucketRepoSlug);
  set('bitbucketDeployBranch', c.bitbucketDeployBranch || 'main');
  row.querySelector('.configRemove').addEventListener('click', () => {
    row.remove();
    updateWeightsSum();
  });
  $('configList').appendChild(row);
}

function collectConfigs() {
  return [...document.querySelectorAll('.configRow')]
    .map(configRowValues)
    .filter((c) => c.projectKey || c.version || c.spaceKey || c.bitbucketWorkspace || c.bitbucketRepoSlug);
}

function updateWeightsSum() {
  const sum = ['setWeightBlockers', 'setWeightPullRequests', 'setWeightIssuesDone', 'setWeightDocs']
    .reduce((a, id) => a + (Number($(id).value) || 0), 0);
  $('weightsSum').textContent = t('admin.weightsTotal', { sum });
}

// The key itself is never returned by getSettings (see settings.js) —
// only hasCoarenaKey. The password boxes stay empty; their placeholders
// tell the admin whether a key is already saved.
function applySettingsPlaceholders(s) {
  $('setCoarenaApiKey').placeholder = s.hasCoarenaKey ? t('admin.keySaved') : t('admin.keyPlaceholder');
  $('setBitbucketApiToken').placeholder = s.hasBitbucketToken ? t('admin.tokenSaved') : t('admin.tokenPlaceholder');
  $('setSlackWebhookUrl').placeholder = s.hasSlackWebhook ? t('admin.webhookSaved') : t('admin.webhookPlaceholder');
  if (s.secretsLegacy) {
    $('settingsStatus').textContent = t('admin.legacyKey');
  }
}

async function loadSettings() {
  try {
    const s = await invoke('getSettings', {});
    lastSettings = s;
    // Release configs (0.7.0, P1-10): at least one empty row so the admin
    // can start configuring without clicking "Add release" first.
    $('configList').innerHTML = '';
    const configs = (s.configs && s.configs.length > 0) ? s.configs : [{}];
    configs.forEach(addConfigRow);
    const w = s.weights ?? { blockers: 40, pullRequests: 25, issuesDone: 20, docs: 15 };
    $('setWeightBlockers').value = w.blockers;
    $('setWeightPullRequests').value = w.pullRequests;
    $('setWeightIssuesDone').value = w.issuesDone;
    $('setWeightDocs').value = w.docs;
    updateWeightsSum();
    $('demoMode').checked = s.demoMode !== false;
    $('pushEnabled').checked = s.pushEnabled === true;
    $('digestDay').value = String(s.digestDay ?? 5);
    $('setCoarenaApiKey').value = '';
    $('setBitbucketApiToken').value = '';
    $('setSlackWebhookUrl').value = '';
    applySettingsPlaceholders(s);
    // Rows cloned from the template carry data-i18n too — translate them
    // now that they exist in the document.
    applyI18n();
    await loadDigestStatus();
  } catch (e) {
    $('settingsStatus').textContent = t('admin.loadFailed', { msg: e.message });
  }
}

// The API key is only sent when the password box is non-empty; a blank box
// means "keep the saved key" (the backend merges it back in).
function settingsPayload() {
  const p = {
    demoMode: $('demoMode').checked,
    pushEnabled: $('pushEnabled').checked,
    digestDay: Number($('digestDay').value),
    aiSummaryEnabled: $('aiSummaryEnabled').checked,
    weights: {
      blockers: Number($('setWeightBlockers').value),
      pullRequests: Number($('setWeightPullRequests').value),
      issuesDone: Number($('setWeightIssuesDone').value),
      docs: Number($('setWeightDocs').value),
    },
    configs: collectConfigs(),
  };
  const key = $('setCoarenaApiKey').value.trim();
  if (key) p.coarenaApiKey = key;
  const bbToken = $('setBitbucketApiToken').value.trim();
  if (bbToken) p.bitbucketApiToken = bbToken;
  const slackUrl = $('setSlackWebhookUrl').value.trim();
  if (slackUrl) p.slackWebhookUrl = slackUrl;
  return p;
}

// 0.7.0 (P1-8): per-config digest run status, read back from the backend.
async function loadDigestStatus() {
  try {
    const status = await invoke('getDigestStatus', {});
    const configs = collectConfigs().filter((c) => c.projectKey && c.version);
    const sel = $('runDigestConfig');
    sel.innerHTML = configs.map((c) =>
      `<option value="${escapeHtml(c.projectKey)}:${escapeHtml(c.version)}">${escapeHtml(c.projectKey)} ${escapeHtml(c.version)}</option>`).join('');
    const lines = Object.entries(status ?? {}).map(([key, entry]) => {
      if (entry.status === 'sent') return `<li><b>${escapeHtml(key)}</b> — ${escapeHtml(t('admin.digestSent'))}${entry.at ? escapeHtml(t('admin.digestSentAt', { at: entry.at })) : ''}${entry.pushed?.length ? escapeHtml(t('admin.digestCommented', { n: entry.pushed.length })) : ''}${entry.pushedSlack ? escapeHtml(t('admin.digestSlackSent')) : ''}.</li>`;
      if (entry.status === 'stored-no-space') return `<li><b>${escapeHtml(key)}</b> — ${escapeHtml(t('admin.digestStoredNoSpace'))}</li>`;
      if (entry.status === 'publish-failed') return `<li><b>${escapeHtml(key)}</b> — ${escapeHtml(t('admin.digestPublishFailed', { error: entry.error ?? '' }))}</li>`;
      return `<li><b>${escapeHtml(key)}</b> — ${escapeHtml(entry.status)}.</li>`;
    });
    $('digestStatus').innerHTML = lines.length > 0
      ? `<ul>${lines.join('')}</ul>`
      : `<p class="hint">${escapeHtml(t('admin.noDigestYet'))}</p>`;
  } catch (e) {
    $('digestStatus').innerHTML = `<p class="hint">${escapeHtml(t('admin.digestStatusLoadFailed', { msg: e.message }))}</p>`;
  }
}

async function runDigestNow() {
  const configKey = $('runDigestConfig').value;
  if (!configKey) {
    $('runDigestStatus').textContent = t('admin.runFirst');
    return;
  }
  $('runDigestStatus').textContent = t('admin.running');
  try {
    const res = await invoke('runDigestNow', { configKey });
    $('runDigestStatus').textContent = res.sent
      ? t('admin.sent', { pageId: res.pageId })
      : t('admin.notSent', { reason: res.reason ?? '' });
    await loadDigestStatus();
  } catch (e) {
    $('runDigestStatus').textContent = t('admin.runFailed', { msg: e.message });
  }
}

async function saveSettings(extra) {
  $('settingsStatus').textContent = t('admin.saving');
  try {
    const res = await invoke('saveSettings', { ...settingsPayload(), ...(extra || {}) });
    if (res.ok) {
      $('setCoarenaApiKey').value = '';
      $('setBitbucketApiToken').value = '';
      $('setSlackWebhookUrl').value = '';
      if (res.settings) {
        lastSettings = res.settings;
        applySettingsPlaceholders(res.settings);
      }
    }
    $('settingsStatus').textContent = res.ok
      ? t('admin.saved')
      : t('admin.saveErrors', { errors: res.errors.join(' ') });
  } catch (e) {
    $('settingsStatus').textContent = t('admin.saveFailed', { msg: e.message });
  }
}

// ------------------------------------------------------- language switcher
// 0.8.0 (P2-1): static text is re-applied in place; dynamic content is
// re-loaded so it renders in the new language. The admin form is never
// reloaded (unsaved edits survive a switch) — only its labels change.

async function onLanguageChange() {
  const lang = setLang($('langSelect').value);
  applyI18n(lang);
  const dashboardVisible = !$('dashboardView').classList.contains('hidden');
  const issueVisible = !$('issueView').classList.contains('hidden');
  const adminVisible = !$('adminView').classList.contains('hidden');
  if (dashboardVisible) {
    loadReadiness();
    loadDigest();
    loadAiSummaryAvailability();
  }
  if (issueVisible && $('issueKey').value.trim()) loadIssue();
  if (adminVisible) {
    updateWeightsSum();
    if (lastSettings) applySettingsPlaceholders(lastSettings);
    loadDigestStatus();
  }
}

// ------------------------------------------------------------------- routing

async function getModuleKey() {
  try {
    const ctx = await view.getContext();
    const key = ctx.moduleKey || ctx.extension?.moduleKey || '';
    const type = ctx.extension?.type || '';
    if (key === 'shipcheck-issue-panel' || type === 'jira:issuePanel') return 'issue';
    if (key === 'shipcheck-admin-page' || type === 'jira:adminPage') return 'admin';
    if (ctx.extension?.issue?.key) {
      $('issueKey').value = ctx.extension.issue.key;
      return 'issue';
    }
    return 'dashboard';
  } catch (e) {
    return 'dashboard'; // no bridge context (local preview) -> dashboard
  }
}

async function init() {
  $('langSelect').value = getLang();
  applyI18n();
  $('langSelect').addEventListener('change', onLanguageChange);
  const moduleKey = await getModuleKey();
  hide($('dashboardView')); hide($('issueView')); hide($('adminView'));
  if (moduleKey === 'issue') {
    show($('issueView'));
    $('checkIssue').addEventListener('click', loadIssue);
    $('issueRetry').addEventListener('click', loadIssue);
    if ($('issueKey').value.trim()) loadIssue();
  } else if (moduleKey === 'admin') {
    show($('adminView'));
    $('saveSettings').addEventListener('click', () => saveSettings());
    $('removeCoarenaKey').addEventListener('click', () => saveSettings({ removeCoarenaKey: true }));
    $('removeBitbucketToken').addEventListener('click', () => saveSettings({ removeBitbucketToken: true }));
    $('removeSlackWebhook').addEventListener('click', () => saveSettings({ removeSlackWebhook: true }));
    $('addConfig').addEventListener('click', () => addConfigRow({}));
    $('runDigestNow').addEventListener('click', runDigestNow);
    for (const id of ['setWeightBlockers', 'setWeightPullRequests', 'setWeightIssuesDone', 'setWeightDocs']) {
      $(id).addEventListener('input', updateWeightsSum);
    }
    loadSettings();
  } else {
    show($('dashboardView'));
    $('refresh').addEventListener('click', () => loadReadiness({ refresh: true }));
    $('retry').addEventListener('click', () => loadReadiness({ refresh: true }));
    $('publish').addEventListener('click', publishNotes);
    $('generateAiSummary').addEventListener('click', generateAiSummary);
    loadReadiness();
    loadDigest();
    loadAiSummaryAvailability();
  }
}

init();
