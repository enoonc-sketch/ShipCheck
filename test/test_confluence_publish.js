import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lookupSpaceId, publishPage, updatePage, publishOrUpdatePage, assertPublishSpaceKey } from '../src/confluence.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeRequest(routes) {
  const calls = [];
  const fn = async (p, init = {}) => {
    calls.push({ path: p, method: init.method ?? 'GET', body: init.body });
    for (const [k, v] of Object.entries(routes)) if (p.startsWith(k)) return v;
    return json(404, {});
  };
  fn.calls = calls;
  return fn;
}

test('space key lookup uses v2 spaces endpoint and parses id', async () => {
  const r = fakeRequest({ '/wiki/api/v2/spaces': json(200, { results: [{ id: '12345', key: 'TEAM' }] }) });
  const out = await lookupSpaceId(r, 'TEAM');
  assert.deepEqual(out, { ok: true, spaceId: '12345' });
  assert.equal(r.calls[0].path, '/wiki/api/v2/spaces?keys=TEAM');
});

test('create page posts v2 body with string ADF value', async () => {
  const r = fakeRequest({
    '/wiki/api/v2/spaces': json(200, { results: [{ id: '777' }] }),
    '/wiki/api/v2/pages': json(200, { id: '99', _links: { webui: '/spaces/TEAM/pages/99' } }),
  });
  const adf = { version: 1, type: 'doc', content: [] };
  const out = await publishPage(r, { spaceKey: 'TEAM', title: 'Release Notes — 1.0', adf });
  assert.equal(out.ok, true);
  assert.equal(out.pageId, '99');
  assert.equal(out.url, '/spaces/TEAM/pages/99');
  const post = r.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/wiki/api/v2/pages');
  const body = JSON.parse(post.body);
  assert.equal(body.spaceId, '777');
  assert.equal(body.status, 'current');
  assert.equal(body.title, 'Release Notes — 1.0');
  assert.equal(body.body.representation, 'atlas_doc_format');
  assert.equal(typeof body.body.value, 'string');
  assert.deepEqual(JSON.parse(body.body.value), adf);
});

test('string ADF value is passed through, not double-stringified', async () => {
  // Production path: index.js passes generateReleaseNotes(...,'adf') and
  // trigger.js passes digestToAdf(digest) — both are JSON strings already.
  const r = fakeRequest({
    '/wiki/api/v2/spaces': json(200, { results: [{ id: '777' }] }),
    '/wiki/api/v2/pages': json(200, { id: '99' }),
  });
  const adfString = JSON.stringify({ version: 1, type: 'doc', content: [] });
  const out = await publishPage(r, { spaceKey: 'TEAM', title: 'Release Notes — 1.0', adf: adfString });
  assert.equal(out.ok, true);
  const post = r.calls.find((c) => c.method === 'POST');
  const body = JSON.parse(post.body);
  assert.equal(body.body.value, adfString);
});

test('url falls back to /wiki/spaces/<key>/pages/<id>', async () => {
  const r = fakeRequest({
    '/wiki/api/v2/spaces': json(200, { results: [{ id: '1' }] }),
    '/wiki/api/v2/pages': json(200, { id: '42' }),
  });
  const out = await publishPage(r, { spaceKey: 'TEAM', title: 't', adf: {} });
  assert.equal(out.url, '/wiki/spaces/TEAM/pages/42');
});

test('space not found gives a clear error and no page POST', async () => {
  const r = fakeRequest({ '/wiki/api/v2/spaces': json(200, { results: [] }) });
  const out = await publishPage(r, { spaceKey: 'TEAM', title: 't', adf: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error.message, 'space not found: TEAM');
  assert.equal(r.calls.some((c) => c.method === 'POST'), false);
});

test('410 on create returns an error object, does not throw', async () => {
  const r = fakeRequest({
    '/wiki/api/v2/spaces': json(200, { results: [{ id: '1' }] }),
    '/wiki/api/v2/pages': json(410, {}),
  });
  const out = await publishPage(r, { spaceKey: 'TEAM', title: 't', adf: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error.status, 410);
});

test('thrown request errors are caught into an error object', async () => {
  const out = await publishPage(async () => { throw new Error('boom'); }, { spaceKey: 'TEAM', title: 't', adf: {} });
  assert.equal(out.ok, false);
  assert.match(out.error.message, /boom/);
});

test('src has no v1 /rest/api/content calls', () => {
  const dir = new URL('../src/', import.meta.url).pathname;
  for (const f of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.equal(/rest\/api\/content/.test(code), false, `${f} still uses v1 content API`);
  }
});

// --- 0.6.0 P0-3: publish-space guard ---
test('assertPublishSpaceKey passes only for the configured space', () => {
  assert.doesNotThrow(() => assertPublishSpaceKey('TEAM', 'TEAM'));
  assert.throws(() => assertPublishSpaceKey('OTHER', 'TEAM'), /does not match the configured docs space/);
  assert.throws(() => assertPublishSpaceKey('', 'TEAM'), /no Confluence space key configured/);
  assert.throws(() => assertPublishSpaceKey('TEAM', ''), /does not match the configured docs space/);
});

// --- 0.9.1: the mismatch error must be diagnosable from the UI text ---
// Live 2026-11-17 05:15 the UI showed only the generic sentence, which
// hid which side was wrong (the Settings page showed the TEAM row).
// The error now names both values and the release it looked up.
test('assertPublishSpaceKey names both spaces and the release in the mismatch error', () => {
  assert.throws(
    () => assertPublishSpaceKey('TEAM', '', 'SHIP 1.4.0'),
    /spaceKey "TEAM" does not match the configured docs space "" for SHIP 1\.4\.0/,
  );
  assert.throws(
    () => assertPublishSpaceKey('OTHER', 'TEAM', 'SHIP 1.4.0'),
    /spaceKey "OTHER" does not match the configured docs space "TEAM" for SHIP 1\.4\.0/,
  );
  // Without a label the message stays short but still names both values.
  assert.throws(
    () => assertPublishSpaceKey('OTHER', 'TEAM'),
    /spaceKey "OTHER" does not match the configured docs space "TEAM"/,
  );
  assert.doesNotThrow(() => assertPublishSpaceKey('TEAM', 'TEAM', 'SHIP 1.4.0'));
});

// --- 0.6.0 P1-2: update-in-place ---
// Method-aware stub: the same /pages/{id} path serves a GET (current
// version) and a PUT (update), so routes are keyed by "METHOD prefix".
function fakeRequestByMethod(routes) {
  const calls = [];
  const fn = async (p, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path: p, method, body: init.body });
    for (const [k, v] of Object.entries(routes)) {
      const [m, prefix] = k.split(' ');
      if (m === method && p.startsWith(prefix)) return v;
    }
    return json(404, {});
  };
  fn.calls = calls;
  return fn;
}

test('updatePage GETs the current version, then PUTs version + 1', async () => {
  const r = fakeRequestByMethod({
    'GET /wiki/api/v2/pages/99': json(200, { id: '99', version: { number: 3 } }),
    'PUT /wiki/api/v2/pages/99': json(200, { id: '99', _links: { webui: '/spaces/TEAM/pages/99' } }),
  });
  const adf = { version: 1, type: 'doc', content: [] };
  const out = await updatePage(r, { pageId: '99', title: 'Release Notes — 1.4.0', adf, spaceKey: 'TEAM' });
  assert.equal(out.ok, true);
  assert.equal(out.pageId, '99');
  assert.equal(out.url, '/spaces/TEAM/pages/99');
  assert.deepEqual(r.calls.map((c) => c.method), ['GET', 'PUT']);
  const put = r.calls.find((c) => c.method === 'PUT');
  const body = JSON.parse(put.body);
  assert.equal(body.version.number, 4);
  assert.equal(body.title, 'Release Notes — 1.4.0');
  assert.equal(body.body.representation, 'atlas_doc_format');
  assert.deepEqual(JSON.parse(body.body.value), adf);
});

test('updatePage returns ok:false when the PUT fails', async () => {
  const r = fakeRequestByMethod({
    'GET /wiki/api/v2/pages/99': json(200, { id: '99', version: { number: 1 } }),
    'PUT /wiki/api/v2/pages/99': json(500, {}),
  });
  const out = await updatePage(r, { pageId: '99', title: 't', adf: {}, spaceKey: 'TEAM' });
  assert.equal(out.ok, false);
  assert.equal(out.error.step, 'update-page');
});

test('publishOrUpdatePage updates when a page id exists, creates otherwise', async () => {
  const r = fakeRequestByMethod({
    'GET /wiki/api/v2/pages/99': json(200, { id: '99', version: { number: 7 } }),
    'PUT /wiki/api/v2/pages/99': json(200, { id: '99' }),
    'GET /wiki/api/v2/spaces': json(200, { results: [{ id: '777' }] }),
    'POST /wiki/api/v2/pages': json(200, { id: '100' }),
  });
  const updated = await publishOrUpdatePage(r, { spaceKey: 'TEAM', title: 't', adf: {}, existingPageId: '99' });
  assert.equal(updated.ok, true);
  assert.equal(updated.pageId, '99');
  assert.equal(r.calls.some((c) => c.method === 'POST'), false, 'update must not POST a new page');
  const created = await publishOrUpdatePage(r, { spaceKey: 'TEAM', title: 't', adf: {}, existingPageId: null });
  assert.equal(created.ok, true);
  assert.equal(created.pageId, '100');
  assert.equal(r.calls.some((c) => c.method === 'POST'), true, 'first publish still creates');
});

// --- 0.7.0 P1-6: pageExists (docs-exists check) ---

test('0.7.0 P1-6: pageExists returns true on 200, false on 404, null on other errors', async () => {
  const { pageExists } = await import('../src/confluence.js');
  const okReq = async () => ({ ok: true, status: 200, json: async () => ({ id: '688131' }) });
  assert.deepEqual(await pageExists(okReq, '688131'), { exists: true });
  const goneReq = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.deepEqual(await pageExists(goneReq, '688131'), { exists: false });
  const errReq = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const other = await pageExists(errReq, '688131');
  assert.equal(other.exists, null);
  assert.match(other.error, /500/);
  assert.deepEqual(await pageExists(okReq, ''), { exists: false });
  const throwing = async () => { throw new Error('network down'); };
  assert.equal((await pageExists(throwing, '688131')).exists, null);
});
