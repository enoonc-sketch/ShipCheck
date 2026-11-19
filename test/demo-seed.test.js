// Tests for the ShipCheck demo-data seed (pure logic, no Forge calls).
// Written FIRST, before src/demo-seed.js existed (TDD, per T's Claude-method standard).
// The seed is what judges see on a fresh site with zero configuration.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDemoContext, selectContext, isEmptyContext, assertRealContext } from '../src/demo-seed.js';
import { scoreRelease } from '../src/scoring.js';

test('blocked scenario scores low and is BLOCKED (the shipped sample)', () => {
  const ctx = getDemoContext('blocked');
  assert.equal(ctx.demo, true);
  assert.equal(ctx.projectKey, 'SHIP');
  assert.equal(ctx.version, '1.4.0');
  const r = scoreRelease(ctx);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.score < 60);
  assert.ok(r.blockers.length > 0);
});

test('ready scenario scores 100 and is READY (the happy-path demo)', () => {
  const ctx = getDemoContext('ready');
  assert.equal(ctx.demo, true);
  const r = scoreRelease(ctx);
  assert.equal(r.score, 100);
  assert.equal(r.verdict, 'READY');
  assert.equal(r.blockers.length, 0);
});

test('empty scenario scores 0 and is BLOCKED (a fresh project with nothing in it)', () => {
  const ctx = getDemoContext('empty');
  assert.equal(ctx.demo, true);
  const r = scoreRelease(ctx);
  assert.equal(r.score, 0);
  assert.equal(r.verdict, 'BLOCKED');
  assert.deepEqual(ctx.issues, []);
  assert.deepEqual(ctx.pullRequests, []);
  assert.deepEqual(ctx.deployments, []);
});

test('getDemoContext defaults to blocked and rejects unknown scenarios', () => {
  assert.equal(getDemoContext().version, '1.4.0');
  assert.throws(() => getDemoContext('nope'), /scenario/);
});

test('getDemoContext returns a fresh copy every time (no shared mutation)', () => {
  const a = getDemoContext('blocked');
  const b = getDemoContext('blocked');
  a.issues.push({ key: 'SHIP-99', type: 'Bug', status: 'To Do', priority: 'Blocker' });
  assert.equal(b.issues.length, 4);
});

test('isEmptyContext detects a release with nothing in it', () => {
  assert.equal(isEmptyContext({ issues: [], pullRequests: [], deployments: [] }), true);
  assert.equal(isEmptyContext({ issues: [{ key: 'X-1' }], pullRequests: [], deployments: [] }), false);
  assert.equal(isEmptyContext({}), true);
  assert.equal(isEmptyContext(null), true);
});

test('selectContext returns real data when demo mode is off and data exists', () => {
  const real = { projectKey: 'SHIP', version: '1.4.0', issues: [{ key: 'SHIP-1' }], pullRequests: [], deployments: [], docsReady: true };
  const out = selectContext({ real, settings: { demoMode: false }, scenario: 'blocked' });
  assert.equal(out.demo, false);
  assert.equal(out.issues.length, 1);
});

test('selectContext falls back to the demo seed when the real release is empty', () => {
  const real = { projectKey: 'SHIP', version: '1.4.0', issues: [], pullRequests: [], deployments: [], docsReady: false };
  const out = selectContext({ real, settings: { demoMode: false }, scenario: 'blocked' });
  assert.equal(out.demo, true);
  assert.equal(out.demoReason, 'empty');
  assert.ok(out.issues.length > 0);
});

test('selectContext honours explicit demo mode even when real data exists', () => {
  const real = { projectKey: 'SHIP', version: '1.4.0', issues: [{ key: 'SHIP-1' }], pullRequests: [], deployments: [], docsReady: true };
  const out = selectContext({ real, settings: { demoMode: true }, scenario: 'ready' });
  assert.equal(out.demo, true);
  assert.equal(out.demoReason, 'manual');
  assert.equal(out.version, '2.0.0');
});

test('assertRealContext throws for demo data, passes real data', () => {
  assert.throws(() => assertRealContext({ demo: true }), /Demo data cannot be published/);
  assert.doesNotThrow(() => assertRealContext({ demo: false }));
  assert.doesNotThrow(() => assertRealContext({}));
  assert.doesNotThrow(() => assertRealContext(null));
});
