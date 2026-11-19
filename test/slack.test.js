// Tests for Slack/Webhook push alerts (0.9.0, P2-3 — the last un-done
// feature of the 0.7.0 doc's 功能 3; Jira comments came first in 0.7.0,
// Slack is the second channel, same trigger condition).
// src/slack.js is pure + injected fetchFn: no Forge runtime needed.
// Run: node --test test/slack.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSlackWebhookUrl, formatSlackAlert, postSlackAlert,
  SLACK_WEBHOOK_PREFIX,
} from '../src/slack.js';

const GOOD_URL = SLACK_WEBHOOK_PREFIX + 'T00000000/B00000000/' + 'X'.repeat(24);

test('isValidSlackWebhookUrl accepts a real Slack incoming-webhook URL', () => {
  assert.equal(isValidSlackWebhookUrl(GOOD_URL), true);
});

test('isValidSlackWebhookUrl rejects anything that is not a Slack webhook', () => {
  assert.equal(isValidSlackWebhookUrl(''), false);
  assert.equal(isValidSlackWebhookUrl(null), false);
  assert.equal(isValidSlackWebhookUrl('http://hooks.slack.com/services/T/B/X'), false);
  assert.equal(isValidSlackWebhookUrl('https://hooks.slack.com/services/'), false);
  assert.equal(isValidSlackWebhookUrl('https://hooks.slack.com/services'), false);
  assert.equal(isValidSlackWebhookUrl('https://evil.example.com/services/T/B/X'), false);
  assert.equal(isValidSlackWebhookUrl('https://hooks.slack.com/services/T B/X'), false);
  assert.equal(isValidSlackWebhookUrl(`${GOOD_URL} `), false);
  assert.equal(isValidSlackWebhookUrl(SLACK_WEBHOOK_PREFIX), false);
});

test('formatSlackAlert carries project, version, score, verdict and blockers', () => {
  const text = formatSlackAlert({
    projectKey: 'SHIP',
    version: '1.4.0',
    score: 67,
    verdict: 'BLOCKED',
    added: [
      { kind: 'bug', key: 'SHIP-4', summary: 'Data loss when saving offline draft', deduction: 15 },
      { kind: 'unapproved-pr', key: null, summary: 'PR #12 not approved', deduction: 5 },
    ],
  });
  assert.match(text, /SHIP 1\.4\.0/);
  assert.match(text, /67\/100/);
  assert.match(text, /BLOCKED/);
  assert.match(text, /SHIP-4/);
  assert.match(text, /Data loss when saving offline draft/);
  assert.match(text, /−15/);
  assert.match(text, /PR #12/);
});

test('formatSlackAlert with no new blockers has no blocker list', () => {
  const text = formatSlackAlert({
    projectKey: 'SHIP', version: '1.4.0', score: 100, verdict: 'READY', added: [],
  });
  assert.match(text, /SHIP 1\.4\.0/);
  assert.match(text, /100\/100/);
  assert.doesNotMatch(text, /New blockers/);
});

test('postSlackAlert posts JSON {text} to the webhook and reports success', async () => {
  let seenUrl = null;
  let seenOpts = null;
  const fetchFn = async (url, opts) => {
    seenUrl = url;
    seenOpts = opts;
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  const res = await postSlackAlert({ fetchFn, webhookUrl: GOOD_URL, text: 'hello' });
  assert.equal(res.ok, true);
  assert.equal(seenUrl, GOOD_URL);
  assert.equal(seenOpts.method, 'POST');
  assert.match(seenOpts.headers['Content-Type'], /application\/json/);
  assert.equal(JSON.parse(seenOpts.body).text, 'hello');
});

test('postSlackAlert never throws: HTTP error and network error become {ok:false}', async () => {
  const bad = await postSlackAlert({
    fetchFn: async () => ({ ok: false, status: 403 }),
    webhookUrl: GOOD_URL,
    text: 'hello',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
  const down = await postSlackAlert({
    fetchFn: async () => { throw new Error('DNS down'); },
    webhookUrl: GOOD_URL,
    text: 'hello',
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /DNS down/);
});

test('postSlackAlert never calls fetch with an invalid URL', async () => {
  let called = false;
  const res = await postSlackAlert({
    fetchFn: async () => { called = true; return { ok: true }; },
    webhookUrl: 'https://evil.example.com/hook',
    text: 'hello',
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});
