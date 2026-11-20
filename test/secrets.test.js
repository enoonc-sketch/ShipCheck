// Tests for src/secrets.js — Marketplace security fix (2026-11-21).
// Secrets must be written with storage.setSecret (Forge's encrypted
// secret store), legacy plain values must migrate on first read, and
// deletes must clear both namespaces.
// Run: node --test test/secrets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSecret, setSecret, deleteSecret } from '../src/secrets.js';

/** Fake Forge storage: plain values and secret values in separate maps. */
function fakeStorage() {
  const plain = new Map();
  const secret = new Map();
  return {
    plain,
    secret,
    async get(key) { return plain.get(key); },
    async set(key, value) { plain.set(key, value); },
    async delete(key) { plain.delete(key); },
    async getSecret(key) { return secret.get(key); },
    async setSecret(key, value) { secret.set(key, value); },
    async deleteSecret(key) { secret.delete(key); },
  };
}

test('setSecret writes to the secret store, not the plain store', async () => {
  const storage = fakeStorage();
  await setSecret(storage, 'k', 'v');
  assert.equal(storage.secret.get('k'), 'v');
  assert.equal(storage.plain.has('k'), false);
});

test('getSecret reads back a secret-store value', async () => {
  const storage = fakeStorage();
  await setSecret(storage, 'k', 'v');
  assert.equal(await getSecret(storage, 'k'), 'v');
});

test('getSecret migrates a legacy plain value into the secret store', async () => {
  const storage = fakeStorage();
  storage.plain.set('k', 'legacy');
  assert.equal(await getSecret(storage, 'k'), 'legacy');
  assert.equal(storage.secret.get('k'), 'legacy');
  assert.equal(storage.plain.has('k'), false);
});

test('getSecret prefers the secret-store value over a stale plain copy', async () => {
  const storage = fakeStorage();
  storage.plain.set('k', 'old');
  storage.secret.set('k', 'new');
  assert.equal(await getSecret(storage, 'k'), 'new');
});

test('getSecret returns undefined when nothing is stored', async () => {
  const storage = fakeStorage();
  assert.equal(await getSecret(storage, 'missing'), undefined);
});

test('setSecret clears a legacy plain copy of the same key', async () => {
  const storage = fakeStorage();
  storage.plain.set('k', 'old');
  await setSecret(storage, 'k', 'new');
  assert.equal(storage.secret.get('k'), 'new');
  assert.equal(storage.plain.has('k'), false);
});

test('deleteSecret clears both namespaces', async () => {
  const storage = fakeStorage();
  storage.plain.set('k', 'old');
  storage.secret.set('k', 'new');
  await deleteSecret(storage, 'k');
  assert.equal(storage.secret.has('k'), false);
  assert.equal(storage.plain.has('k'), false);
});

test('helpers degrade to plain storage when the secret API is absent', async () => {
  const plain = new Map();
  const storage = {
    async get(key) { return plain.get(key); },
    async set(key, value) { plain.set(key, value); },
    async delete(key) { plain.delete(key); },
  };
  await setSecret(storage, 'k', 'v');
  assert.equal(plain.get('k'), 'v');
  assert.equal(await getSecret(storage, 'k'), 'v');
  await deleteSecret(storage, 'k');
  assert.equal(plain.has('k'), false);
});
