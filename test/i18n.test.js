// Tests for the i18n dictionary (0.8.0, P2-1) — written FIRST.
// The dictionary is the single source of UI copy: every data-i18n key in
// index.html and every t('...') call in app.js must resolve in both
// languages, so a missing translation fails the suite instead of shipping
// a blank label. Backend-generated content (Jira summaries, warnings,
// release notes, AI summary) stays English — see TEST-REPORT.md 0.8.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STRINGS, t, SUPPORTED_LANGS } from '../static/ui/src/i18n.js';

test('exactly two languages: en and zh-CN', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), ['en', 'zh-CN']);
  assert.deepEqual([...SUPPORTED_LANGS].sort(), ['en', 'zh-CN']);
});

test('zh-CN has every en key (no missing translation)', () => {
  const enKeys = Object.keys(STRINGS.en).sort();
  const zhKeys = Object.keys(STRINGS['zh-CN']).sort();
  assert.deepEqual(zhKeys, enKeys);
});

test('no key maps to an empty string in either language', () => {
  for (const [lang, dict] of Object.entries(STRINGS)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(value.trim().length > 0, `${lang}:${key} is empty`);
    }
  }
});

test('t() substitutes {vars} and falls back to en, then to the key itself', () => {
  assert.equal(t('admin.weightsTotal', { sum: 100 }, 'en'), STRINGS.en['admin.weightsTotal'].replace('{sum}', '100'));
  assert.equal(t('app.title', {}, 'zh-CN'), STRINGS['zh-CN']['app.title']);
  // A key missing from zh-CN falls back to the English text.
  const saved = STRINGS['zh-CN']['app.title'];
  delete STRINGS['zh-CN']['app.title'];
  try {
    assert.equal(t('app.title', {}, 'zh-CN'), STRINGS.en['app.title']);
  } finally {
    STRINGS['zh-CN']['app.title'] = saved;
  }
  assert.equal(t('no.such.key', {}, 'en'), 'no.such.key');
  assert.equal(t('app.title', {}, 'fr'), STRINGS.en['app.title']);
});

test('every data-i18n key in index.html exists in the en dictionary', async () => {
  const html = await readFile(new URL('../static/ui/index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20, `expected many data-i18n keys, found ${keys.length}`);
  const missing = [...new Set(keys)].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});

test('every data-i18n-placeholder key in index.html exists in the en dictionary', async () => {
  const html = await readFile(new URL('../static/ui/index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(keys)].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});

test('every t() key used in app.js exists in the en dictionary', async () => {
  const js = await readFile(new URL('../static/ui/src/app.js', import.meta.url), 'utf8');
  // Only complete calls count: t('verdict.' + code) is a dynamic key and is
  // asserted by name below, not by this regex. The \b keeps set('...') /
  // get('...') helpers (addConfigRow's set('projectKey', ...)) from
  // matching as t('...') calls.
  const keys = [...js.matchAll(/\bt\('([^']+)'(?:,|\))/g)].map((m) => m[1]);
  assert.ok(keys.length > 30, `expected many t() calls, found ${keys.length}`);
  const missing = [...new Set(keys)].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
  // Dynamic verdict keys: t('verdict.' + code) — asserted by name.
  for (const v of ['READY', 'CAUTION', 'BLOCKED']) {
    assert.ok(`verdict.${v}` in STRINGS.en, `verdict.${v} missing`);
  }
});
