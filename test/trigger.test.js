// Regression test: trigger.js must PARSE and export a handler.
// 0.5.1 shipped with `const result` declared twice inside handler()
// (the score result, then the publish result) — the suite stayed green
// because no test ever imported trigger.js (adapters.test.js only reads
// it as text). Importing it here makes a syntax error fail the suite.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler, LAST_DIGEST_KEY } from '../src/trigger.js';
import { handler as indexHandler } from '../src/index.js';

test('trigger.js parses and exports an async handler', () => {
  assert.equal(typeof handler, 'function');
  assert.equal(typeof LAST_DIGEST_KEY, 'string');
});

test('index.js parses and exports a handler', () => {
  assert.equal(typeof indexHandler, 'function');
});
