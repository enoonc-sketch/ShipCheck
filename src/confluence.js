// Confluence publish helper (v2 API). The v1 `POST /wiki/rest/api/content`
// was removed by Atlassian (HTTP 410 Gone), so pages are created through
// `POST /wiki/api/v2/pages`, which needs the NUMERIC space id — looked up
// first via `GET /wiki/api/v2/spaces?keys=<key>`.
//
// `request(path, init)` is injected (in Forge: api.asApp().requestConfluence
// wrapped with route``), so this module is unit-tested without Forge.
// It never throws: failures come back as { ok: false, error: {...} }.

function fail(step, message, status) {
  return { ok: false, error: { step, status: status ?? null, message } };
}

export async function lookupSpaceId(request, spaceKey) {
  const res = await request(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return fail('space-lookup', `space lookup failed: ${res.status}`, res.status);
  const data = await res.json();
  const id = data?.results?.[0]?.id;
  if (!id) return fail('space-lookup', `space not found: ${spaceKey}`, 404);
  return { ok: true, spaceId: String(id) };
}

export async function publishPage(request, { spaceKey, title, adf }) {
  try {
    if (!spaceKey) return fail('input', 'no Confluence space key configured');
    const space = await lookupSpaceId(request, spaceKey);
    if (!space.ok) return space;
    const value = typeof adf === 'string' ? adf : JSON.stringify(adf);
    const res = await request('/wiki/api/v2/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        spaceId: space.spaceId,
        status: 'current',
        title,
        body: { representation: 'atlas_doc_format', value },
      }),
    });
    if (!res.ok) return fail('create-page', `Confluence returned ${res.status}`, res.status);
    const page = await res.json();
    return {
      ok: true,
      pageId: page.id,
      url: page._links?.webui ?? `/wiki/spaces/${spaceKey}/pages/${page.id}`,
    };
  } catch (e) {
    return fail('request', String(e?.message ?? e));
  }
}

/**
 * Publish-space guard (P0-3): the space a publish targets must be the one
 * the admin configured in Settings. The UI already sends settings.spaceKey,
 * but a direct resolver invoke could pass any space — this throws before
 * anything is created. Pure function, unit-tested on its own.
 *
 * 0.9.1: the mismatch error names both values and the release it looked
 * up (label, e.g. "SHIP 1.4.0"). Live on 2026-11-17 the UI showed only
 * the generic sentence, which hid which side was wrong — the Settings
 * page showed the TEAM row while the publish still refused it.
 */
export function assertPublishSpaceKey(payloadSpaceKey, settingsSpaceKey, label = '') {
  if (!payloadSpaceKey) throw new Error('no Confluence space key configured');
  if (payloadSpaceKey !== settingsSpaceKey) {
    const where = label ? ` for ${label}` : '';
    throw new Error(`spaceKey "${payloadSpaceKey}" does not match the configured docs space "${settingsSpaceKey}"${where}.`);
  }
}

/**
 * Update an existing page in place (P1-2): read its current version, then
 * PUT with version + 1. The v2 update needs the same
 * `write:page:confluence` scope the create already uses.
 */
export async function updatePage(request, { pageId, title, adf, spaceKey }) {
  try {
    if (!pageId) return fail('input', 'no page id to update');
    const current = await request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!current.ok) return fail('read-page', `Confluence returned ${current.status}`, current.status);
    const currentJson = await current.json();
    const version = (currentJson?.version?.number ?? 0) + 1;
    const value = typeof adf === 'string' ? adf : JSON.stringify(adf);
    const res = await request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title,
        body: { representation: 'atlas_doc_format', value },
        version: { number: version },
      }),
    });
    if (!res.ok) return fail('update-page', `Confluence returned ${res.status}`, res.status);
    const page = await res.json();
    return {
      ok: true,
      pageId: page.id,
      url: page._links?.webui ?? `/wiki/spaces/${spaceKey}/pages/${page.id}`,
    };
  } catch (e) {
    return fail('request', String(e?.message ?? e));
  }
}

/**
 * Does a Confluence page still exist? (0.7.0, P1-6 — docs-exists check.)
 * GET /wiki/api/v2/pages/{id} needs the granular `read:page:confluence`
 * scope (added in 0.7.0; the classic `read:confluence-content.summary`
 * does NOT authorize v2 page reads — that gap was the 0.6.0 publish 401).
 * @returns {{exists:true}|{exists:false}|{exists:null, error:string}}
 *   exists:false on 404 (page deleted); exists:null on any other error
 *   (caller keeps the old marker behaviour instead of failing the panel).
 */
export async function pageExists(request, pageId) {
  try {
    if (!pageId) return { exists: false };
    const res = await request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) return { exists: true };
    if (res.status === 404) return { exists: false };
    return { exists: null, error: `Confluence returned ${res.status}` };
  } catch (e) {
    return { exists: null, error: String(e?.message ?? e) };
  }
}

/**
 * Publish-or-update (P1-2): first publish of a version creates the page;
 * later publishes update the same page instead of creating duplicates.
 * `publishPage` keeps its original create-only behaviour.
 */
export async function publishOrUpdatePage(request, { spaceKey, title, adf, existingPageId }) {
  if (existingPageId) {
    return updatePage(request, { pageId: existingPageId, title, adf, spaceKey });
  }
  return publishPage(request, { spaceKey, title, adf });
}

// Forge glue: wraps api.asApp().requestConfluence for publishPage. `route` is a
// tagged template, so the plain path is passed as a one-part template.
export function forgeRequest(api, route) {
  return (path, init) =>
    api.asApp().requestConfluence(route(Object.assign([path], { raw: [path] })), init);
}
