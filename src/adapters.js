// Data adapters: how ShipCheck gets release context.
// - "mock": reads the shipped sample JSON — works locally, zero network, zero account.
//   Accepts a `scenario` ('blocked' | 'ready' | 'empty') to demo each seed.
// - "forge": REAL Atlassian calls via @forge/api (Jira/Confluence/Bitbucket REST).
//   Only used when running inside Forge after T registers a developer site.
//   In local mode it throws a clear error instead of silently returning fake data.
import { readFile } from 'node:fs/promises';
import { getDemoContext, selectContext, isEmptyContext } from './demo-seed.js';
import { fetchPullRequests, fetchDeployments, enrichPrFromBitbucket } from './bitbucket.js';
import { pageExists, forgeRequest } from './confluence.js';
import { resolveReleaseConfig } from './settings.js';

// Jira pagination cap (P1-1): one JQL page holds 100 issues; keep reading
// until nextPageToken runs out, but never score more than 1000 issues in
// one release — beyond that the context is marked truncated.
export const MAX_JIRA_ISSUES = 1000;
// Dev-status (P1-4, layer 2): at most 50 issues get a dev-status call each
// (two calls per issue — pullrequest + repository — is the worst case).
export const DEV_STATUS_MAX_ISSUES = 50;
// Cache TTLs (P1-6): Jira context 5 min, Bitbucket PRs/deployments 10 min.
// Storage writes are best-effort (a failed write never breaks the panel);
// a 5-min stale read is the documented trade-off of the cache.
export const JIRA_CACHE_TTL_MS = 5 * 60 * 1000;
export const BB_CACHE_TTL_MS = 10 * 60 * 1000;

export function jiraCacheKey(projectKey, version) {
  return `shipcheck:cache:jira:${projectKey}:${version}`;
}

export function bbCacheKey(workspace, repo) {
  return `shipcheck:cache:bb:${workspace}:${repo}`;
}

/** True when a cached entry is still within its TTL. Pure, unit-tested. */
export function isCacheFresh(entry, ttlMs, now = Date.now()) {
  return Boolean(entry && typeof entry.cachedAt === 'number' && now - entry.cachedAt < ttlMs);
}

/** The data-sources label for a context that is pure sample data. */
export function demoDataSources() {
  return { jira: 'demo', pullRequests: 'demo', deployments: 'demo', docs: 'demo' };
}

export async function fetchReleaseContext({ adapter = 'mock', version, scenario = 'blocked' }) {
  if (adapter === 'mock') {
    if (scenario !== 'blocked') {
      const demo = getDemoContext(scenario);
      return { ...demo, version: version ?? demo.version, dataSources: demoDataSources(), dataGaps: [] };
    }
    const url = new URL('../mock-data/release-sample.json', import.meta.url);
    const data = JSON.parse(await readFile(url, 'utf8'));
    return { ...data, version: version ?? data.version, demo: false, dataSources: demoDataSources(), dataGaps: [] };
  }
  if (adapter === 'forge') {
    throw new Error(
      'fetchReleaseContext: "forge" adapter requires a real Atlassian site — ' +
      'not available in local mode. Register a free Atlassian Cloud Developer ' +
      'License, deploy with `forge deploy`, then install the app on that site.',
    );
  }
  throw new Error(`fetchReleaseContext: unknown adapter "${adapter}" (use "mock" or "forge")`);
}

// --- Forge-side implementation (imported only by src/index.js under Forge) ---
// Kept as a separate export so local tests never load @forge/api.
/** Quote one JQL string literal, escaping backslashes and quotes. */
export function jqlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// --- PR association, layer 2/3 (0.7.0, P1-4) ---
// Layer 1 (title/description/branch mentions an issue key) lives in
// bitbucket.js fetchPullRequests. Layer 2 reads Jira's dev-status API
// (`GET /rest/dev-status/1.0/issue/detail`, scope `read:dev-info:jira` —
// NOT inside `read:jira-work`, see TEST-REPORT.md 0.7.0); layer 3 matches
// a PR's source commit hash against the issue's commit list (dev-status
// dataType=repository). Any layer associating a PR is enough; matchedVia
// records the strongest evidence (commit > devStatus > title).

const MATCH_RANK = { commit: 3, devStatus: 2, title: 1 };

/** Normalize one dev-status pull-request entry to ShipCheck's PR shape. */
export function normalizeDevStatusPr(raw, issueKey) {
  if (!raw || raw.id === undefined || raw.id === null) return null;
  const state = String(raw.status ?? raw.state ?? 'OPEN').toUpperCase();
  return {
    id: raw.id,
    title: raw.name ?? raw.title ?? '',
    state: state === 'MERGED' ? 'MERGED' : state === 'DECLINED' ? 'DECLINED' : 'OPEN',
    // Dev-status carries no approvals/checks — enriched via Bitbucket when
    // a token is configured (P1-4 layer 3); until then null/pending, which
    // scoring treats conservatively (unapproved, checks not passed).
    approvals: null,
    checks: 'pending',
    commitHash: null,
    matchedVia: 'devStatus',
    issueKey,
  };
}

/** Collect commit hashes from one dev-status repository detail entry. */
export function extractDevStatusCommits(detailEntry) {
  const out = new Set();
  for (const repo of detailEntry?.repositories ?? []) {
    for (const c of repo?.commits ?? []) {
      if (typeof c?.id === 'string' && c.id) out.add(c.id.toLowerCase());
      if (typeof c?.hash === 'string' && c.hash) out.add(c.hash.toLowerCase());
    }
  }
  return [...out];
}

/**
 * Merge PR lists from the association layers, deduplicated by PR id.
 * The record with the most information wins (an enriched record never
 * loses its approvals/checks/commitHash to a dev-status stub), and
 * matchedVia keeps the strongest evidence (commit > devStatus > title).
 * Pure, unit-tested.
 */
export function mergePullRequests(lists) {
  const byId = new Map();
  for (const list of lists ?? []) {
    for (const pr of list ?? []) {
      if (pr?.id === undefined || pr?.id === null) continue;
      const key = String(pr.id);
      const prev = byId.get(key);
      if (!prev) {
        byId.set(key, { ...pr });
        continue;
      }
      const merged = { ...prev, ...pr };
      if ((prev.approvals !== null && prev.approvals !== undefined)
        && (pr.approvals === null || pr.approvals === undefined)) merged.approvals = prev.approvals;
      if (prev.checks && prev.checks !== 'pending' && (!pr.checks || pr.checks === 'pending')) merged.checks = prev.checks;
      if (prev.commitHash && !pr.commitHash) merged.commitHash = prev.commitHash;
      if (prev.title && !pr.title) merged.title = prev.title;
      if (prev.issueKey && !pr.issueKey) merged.issueKey = prev.issueKey;
      merged.matchedVia = (MATCH_RANK[pr.matchedVia] ?? 0) >= (MATCH_RANK[prev.matchedVia] ?? 0)
        ? (pr.matchedVia ?? prev.matchedVia) : prev.matchedVia;
      byId.set(key, merged);
    }
  }
  return [...byId.values()];
}

/**
 * One dev-status call. `applicationType` is tried as 'bitbucket' first,
 * then 'stash' (the legacy Bitbucket Server type — some sites report
 * under it). Returns the raw `detail` array, or null on any failure.
 * The endpoint is undocumented/non-public: it only returns data once
 * Jira is linked to a development tool; an unlinked site returns an
 * empty `detail` array (NOT an error) — the caller treats that as
 * "not connected", not as a failure.
 */
async function fetchDevStatusDetail(api, route, issueId, applicationType, dataType) {
  try {
    const res = await api.asApp().requestJira(
      route`/rest/dev-status/1.0/issue/detail?issueId=${issueId}&applicationType=${applicationType}&dataType=${dataType}`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.detail) ? json.detail : null;
  } catch (e) {
    return null;
  }
}

/**
 * Dev-status for one issue: its linked PRs and its commit hashes.
 * @returns {{pullRequests: object[], commits: string[], linked: boolean}}
 *   linked=false means Jira has no development tool linked for this issue
 *   (empty detail under both application types) — not an error.
 */
async function fetchDevStatusForIssue(api, route, issue) {
  const result = { pullRequests: [], commits: [], linked: false };
  for (const appType of ['bitbucket', 'stash']) {
    const detail = await fetchDevStatusDetail(api, route, issue.id, appType, 'pullrequest');
    if (!detail || detail.length === 0) continue;
    result.linked = true;
    for (const entry of detail) {
      for (const raw of entry?.pullRequests ?? []) {
        const pr = normalizeDevStatusPr(raw, issue.key);
        if (pr) result.pullRequests.push(pr);
      }
    }
    // Commits come from the same application type that answered.
    const repoDetail = await fetchDevStatusDetail(api, route, issue.id, appType, 'repository');
    if (repoDetail) {
      for (const entry of repoDetail) result.commits.push(...extractDevStatusCommits(entry));
    }
    break; // first application type that answers wins
  }
  return result;
}

/** Build the real adapter once @forge/api is available (Forge runtime only). */
// `route` is passed in (from '@forge/api' in index.js/trigger.js) so this
// file stays import-free of @forge/api for local tests. @forge/api v5
// REQUIRES request URLs to be built with the `route` tag — a plain string
// throws "You must create your route using the 'route' export..." at runtime
// (seen live 2026-11-16). `route` URL-encodes interpolated values that
// appear after '?' itself, so pass the RAW jql here (no encodeURIComponent
// — that would double-encode). `storage` is the Forge Storage API (passed
// in so P0-2a can read the published-<version> marker); tests may pass a
// stub `{ get }` or omit it (docs then read as unwired).
export function createForgeAdapter(api, route, storage) {
  return {
    async fetchReleaseContext({ version, projectKey, settings, scenario = 'blocked', refresh = false, bitbucketApiToken }) {
      // P1-10: the release config (one per project+version) decides the
      // project, version, docs space and Bitbucket repo. A payload
      // projectKey/version with no matching config falls back to the
      // payload values (the dashboard passes the current release), and
      // legacy flat settings still resolve to one config.
      const config = resolveReleaseConfig(settings, projectKey, version) ?? {};
      const pk = config.projectKey || projectKey;
      const ver = config.version || version;
      // No project/version configured yet: do not fire a bogus JQL call.
      // Show the demo seed (labelled as such in the UI) until configured.
      if (!pk || !ver) {
        return { ...getDemoContext(scenario), demoReason: 'unconfigured', dataSources: demoDataSources(), dataGaps: [] };
      }
      // Demo mode on: the admin explicitly wants the sample — no network,
      // no storage reads at all (the demo-mode test asserts zero reads).
      if (settings?.demoMode === true) {
        return { ...getDemoContext(scenario), demoReason: 'manual', dataSources: demoDataSources(), dataGaps: [] };
      }
      // P1-6: Jira context cache (5 min). A refresh forces a fresh fetch.
      const cacheKey = jiraCacheKey(pk, ver);
      if (!refresh && storage && typeof storage.get === 'function') {
        try {
          const cached = await storage.get(cacheKey);
          if (isCacheFresh(cached, JIRA_CACHE_TTL_MS)) {
            return { ...cached.ctx, fromCache: true };
          }
        } catch (e) {
          // A failed cache read never breaks the panel — fetch live.
        }
      }
      const fetchedAt = new Date().toISOString();
      // JQL string values must be quoted AND backslash/quote-escaped — the
      // old code interpolated them raw (breaks on spaces, injectable).
      // Endpoint: GET /rest/api/3/search/jql. The legacy /rest/api/3/search
      // was removed from Jira Cloud (410 Gone, CHANGE-2046, Oct 2025);
      // /search/jql accepts GET or POST, JQL must be URL-encoded, and
      // `fields` must be passed explicitly (it defaults to id only).
      const jql = `project = ${jqlQuote(pk)} AND fixVersion = ${jqlQuote(ver)}`;
      // P1-1: walk nextPageToken until exhausted (cap MAX_JIRA_ISSUES).
      // The token is interpolated on its own so `route` encodes just the
      // token value — never interpolate a raw "&nextPageToken=..." string
      // (route would encode the '&' and break the query).
      const issues = [];
      let nextPageToken = null;
      let truncated = false;
      do {
        const issuesRes = nextPageToken
          ? await api.asApp().requestJira(
            route`/rest/api/3/search/jql?jql=${jql}&fields=key,summary,status,priority,issuetype,assignee&maxResults=100&nextPageToken=${nextPageToken}`,
          )
          : await api.asApp().requestJira(
            route`/rest/api/3/search/jql?jql=${jql}&fields=key,summary,status,priority,issuetype,assignee&maxResults=100`,
          );
        if (!issuesRes.ok) throw new Error(`Jira search failed: ${issuesRes.status}`);
        const issuesJson = await issuesRes.json();
        for (const i of issuesJson.issues ?? []) {
          if (issues.length >= MAX_JIRA_ISSUES) { truncated = true; break; }
          issues.push({
            key: i.key,
            id: i.id ?? null,
            type: i.fields.issuetype?.name,
            status: i.fields.status?.name,
            priority: i.fields.priority?.name,
            summary: i.fields.summary,
            assignee: i.fields.assignee?.displayName ?? null,
          });
        }
        // A page that fills the cap ends the walk here — do not fetch
        // one more page just to discover there is nothing left to keep.
        if (truncated || issues.length >= MAX_JIRA_ISSUES) { truncated = true; break; }
        nextPageToken = issuesJson.nextPageToken ?? null;
      } while (nextPageToken);

      // Bitbucket settings: the resolved config first, then legacy flat
      // settings. The API token NEVER lives in settings any more (P1-5) —
      // it arrives as the bitbucketApiToken option from the secret key,
      // with the legacy flat settings field as a fallback.
      const bbWorkspace = config.bitbucketWorkspace || settings?.bitbucketWorkspace || '';
      const bbRepo = config.bitbucketRepoSlug || settings?.bitbucketRepoSlug || '';
      const bbBranch = config.bitbucketDeployBranch || settings?.bitbucketDeployBranch || 'main';
      const bbToken = bitbucketApiToken || settings?.bitbucketApiToken || '';
      const bbConfigured = Boolean(bbWorkspace && bbRepo && bbToken);
      const bbBase = {
        fetchFn: (url, init) => api.fetch(url, init),
        workspace: bbWorkspace,
        repo: bbRepo,
        token: bbToken,
      };

      const dataSources = { jira: 'live', pullRequests: 'unwired', deployments: 'unwired', docs: storage ? 'live' : 'unwired' };
      const dataGaps = [];
      let pullRequests = [];
      let deployments = [];

      // P1-6: Bitbucket cache (10 min) — keyed by workspace/repo, and only
      // reused when the release's issue keys and branch match the entry
      // (the PR list is filtered by issue key, so another release's entry
      // must never be reused).
      const issueKeys = issues.map((i) => i.key);
      const bbCacheEntry = async () => {
        if (!bbConfigured || !storage || typeof storage.get !== 'function') return null;
        try {
          const entry = await storage.get(bbCacheKey(bbWorkspace, bbRepo));
          if (!isCacheFresh(entry, BB_CACHE_TTL_MS)) return null;
          if (entry.branch !== bbBranch) return null;
          if (JSON.stringify([...(entry.issueKeys ?? [])].sort()) !== JSON.stringify([...issueKeys].sort())) return null;
          return entry;
        } catch (e) {
          return null;
        }
      };
      const storeBbCache = async (entry) => {
        if (!bbConfigured || !storage || typeof storage.set !== 'function') return;
        try {
          const payload = { ...entry, cachedAt: Date.now() };
          if (JSON.stringify(payload).length > 200 * 1024) return; // stay under the 240 KiB value cap
          await storage.set(bbCacheKey(bbWorkspace, bbRepo), payload);
        } catch (e) {
          // Best-effort: a failed cache write never breaks the panel.
        }
      };

      // Layer 1 + deployments via the Bitbucket REST API (P0-2b/2c).
      // Unconfigured or failed calls do NOT throw — the gap is recorded
      // and the slice is labelled so the dashboard shows "not connected"
      // instead of a fake 0 (P1-3).
      let layer1Prs = [];
      const bbCache = await bbCacheEntry();
      if (bbCache) {
        layer1Prs = bbCache.pullRequests ?? [];
        deployments = bbCache.deployments ?? [];
        if (bbCache.gaps?.length) {
          dataSources.pullRequests = 'error';
          dataSources.deployments = 'error';
          dataGaps.push(...bbCache.gaps);
        } else {
          // A cached empty list is a real answer (layer 1 succeeded with
          // no PRs), not an unwired source.
          dataSources.pullRequests = 'live';
          dataSources.deployments = 'live';
        }
      } else if (bbConfigured) {
        const prs = await fetchPullRequests({ ...bbBase, issueKeys });
        layer1Prs = prs.pullRequests;
        if (prs.gap) { dataSources.pullRequests = 'error'; dataGaps.push(prs.gap); }
        else dataSources.pullRequests = 'live';
        const deps = await fetchDeployments({ ...bbBase, branch: bbBranch });
        deployments = deps.deployments;
        if (deps.gap) { dataSources.deployments = 'error'; dataGaps.push(deps.gap); }
        else dataSources.deployments = 'live';
        await storeBbCache({
          issueKeys, branch: bbBranch,
          pullRequests: layer1Prs, deployments,
          gaps: dataGaps.filter((g) => g.includes('Bitbucket')),
        });
      }

      // Layer 2 + 3: Jira dev-status (P1-4). Runs whether or not Bitbucket
      // is configured — it only needs the Jira dev-info scope. An unlinked
      // site returns empty detail (not an error): PRs stay 'unwired' with
      // a gap explaining the link is missing. A failed call is 'error'.
      let devStatusRan = false;
      let devStatusLinked = false;
      const layer2Prs = [];
      const commitsByIssue = new Map();
      const devIssues = issues.filter((i) => i.id).slice(0, DEV_STATUS_MAX_ISSUES);
      for (const issue of devIssues) {
        const dev = await fetchDevStatusForIssue(api, route, issue);
        devStatusRan = true;
        if (dev.linked) {
          devStatusLinked = true;
          layer2Prs.push(...dev.pullRequests);
          if (dev.commits.length > 0) commitsByIssue.set(issue.key, new Set(dev.commits));
        }
      }
      if (devStatusLinked) {
        // Enrich dev-status PRs with Bitbucket approvals/checks when a
        // token is configured (layer 3 data for them as well).
        if (bbConfigured) {
          for (const pr of layer2Prs) {
            const enriched = await enrichPrFromBitbucket({ ...bbBase, prId: pr.id });
            if (enriched) {
              pr.approvals = enriched.approvals;
              pr.checks = enriched.checks;
              pr.commitHash = enriched.commitHash;
              if (enriched.title) pr.title = enriched.title;
              if (enriched.state) pr.state = enriched.state;
            }
          }
        }
        // Layer 3: a PR whose source commit appears in an issue's commit
        // list is associated with that issue, whatever the title says.
        const allHashes = new Set();
        for (const set of commitsByIssue.values()) for (const h of set) allHashes.add(h);
        for (const pr of [...layer1Prs, ...layer2Prs]) {
          if (pr.commitHash && allHashes.has(String(pr.commitHash).toLowerCase())) {
            pr.matchedVia = 'commit';
          }
        }
        dataSources.pullRequests = 'live';
      } else if (devStatusRan) {
        // Dev-status answered but nothing is linked: PRs stay unwired
        // (unless layer 1 already connected them).
        if (dataSources.pullRequests !== 'live') {
          dataSources.pullRequests = 'unwired';
          dataGaps.push('No development tool is linked to this Jira project (dev-status returned no data) — link Bitbucket in Jira settings to associate pull requests.');
        }
      }
      pullRequests = mergePullRequests([layer1Prs, layer2Prs]);
      // A PR that came only from dev-status with no approvals known yet
      // keeps approvals:null — scoring treats it as unapproved (safe).

      // P0-2a: docs are ready once the release notes have been published —
      // the publish flow stores the page id under `published-<version>`.
      // Only read storage when the real context will actually be used
      // (demo mode, or an empty real release that falls back to the demo
      // seed, must not touch storage).
      const willUseReal = settings?.demoMode !== true
        && !isEmptyContext({ issues, pullRequests, deployments });
      let docsReady = false;
      if (willUseReal && storage) {
        const pageId = await storage.get(`published-${ver}`);
        docsReady = Boolean(pageId);
        // P1-6: the marker says "published" — verify the page still
        // exists in Confluence. A deleted page scores Docs 0/15 with a
        // clear gap (the source stays 'live': Confluence answered, the
        // page is simply gone) and the stale marker is cleared so the
        // next publish creates a fresh page. Any other error keeps the
        // old marker behaviour and only adds a gap.
        if (docsReady && pageId) {
          const check = await pageExists(forgeRequest(api, route), pageId);
          if (check.exists === false) {
            docsReady = false;
            dataGaps.push('The release notes page was deleted in Confluence — publish again to restore it.');
            if (typeof storage.delete === 'function') {
              try { await storage.delete(`published-${ver}`); } catch (e) { /* best-effort */ }
            }
          } else if (check.exists === null) {
            dataGaps.push(`Could not verify the release notes page (${check.error}) — showing the last known state.`);
          }
        }
      }

      const real = {
        version: ver, projectKey: pk, issues, pullRequests, deployments, docsReady,
        truncated, dataSources, dataGaps,
        dataUpdatedAt: fetchedAt, fromCache: false,
      };
      // Empty real release (or demo mode on) -> labelled demo seed, never fake
      // data presented as real.
      const ctx = selectContext({ real, settings, scenario });
      if (ctx.demo) {
        // The demo seed carries no real provenance: label every source demo
        // and drop the real gaps/truncation flags with it.
        ctx.dataSources = demoDataSources();
        ctx.dataGaps = [];
        ctx.truncated = false;
      } else if (storage && typeof storage.set === 'function') {
        // P1-6: cache the real context (5 min). Best-effort, and never
        // above 200 KiB (Forge KVS value cap is 240 KiB).
        try {
          const payload = { cachedAt: Date.now(), ctx };
          if (JSON.stringify(payload).length <= 200 * 1024) {
            await storage.set(cacheKey, payload);
          }
        } catch (e) {
          // A failed cache write never breaks the panel.
        }
      }
      return ctx;
    },
  };
}
