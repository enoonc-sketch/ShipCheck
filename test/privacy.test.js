// Tests for PRIVACY.md — 0.9.5, Stage 0 review Q2 / §11.3.
// The review found PRIVACY.md:60-62 claims "the settings resolvers
// check the caller's admin status on the backend on every call", which
// was false in 0.9.3 (publish and AI summary had no check at all) and
// is still false as written (the check is fail-open, and reads are not
// checked). The doc must say what the code actually does. These tests
// pin the corrected wording so the claim cannot silently drift back.
// Run: node --test test/privacy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8')
  // Line wraps must not break phrase matching — collapse whitespace.
  .replace(/\s+/g, ' ');

test('PRIVACY.md no longer claims an admin check on every call', () => {
  assert.ok(
    !doc.includes('check the caller\'s admin status on the backend on every call'),
    'the false "every call" claim must be gone',
  );
  assert.ok(
    !doc.includes('on the backend on every call'),
    'no reworded version of the false claim may remain',
  );
});

test('PRIVACY.md names the five admin-only operations', () => {
  // Exactly the resolvers the code guards in 0.9.5 (see admin-wiring).
  for (const phrase of [
    'changing settings',
    'publishing release notes',
    'generating an AI summary',
    'running a digest now',
    'reading the audit log',
  ]) {
    assert.ok(doc.includes(phrase), `PRIVACY.md must name the admin-only operation: ${phrase}`);
  }
});

test('PRIVACY.md states the fail-open rule and that denials are audited', () => {
  assert.ok(doc.includes('fail-open'), 'the doc must name the fail-open rule');
  assert.ok(doc.includes('cannot verify'), 'the doc must say when fail-open applies');
  assert.ok(doc.includes('audit log'), 'the doc must say fail-open decisions are written to the audit log');
});

test('PRIVACY.md states plainly that reads are not admin-checked', () => {
  assert.ok(
    doc.includes('needs no admin rights'),
    'reads (dashboard, blockers, notes preview, settings, digest status) must be stated as not admin-checked',
  );
});

test('PRIVACY.md documents the audit log in what is stored', () => {
  assert.ok(doc.includes('Audit events'), 'the stored-data list must mention audit events');
  assert.ok(doc.includes('shipcheck:audit:events') || doc.includes('audit log'), 'the audit storage must be named');
});
