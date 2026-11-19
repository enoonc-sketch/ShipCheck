// Bitbucket Cloud data for ShipCheck — PURE logic + injected fetchFn.
// PRs + deployments are read through the Bitbucket Cloud REST API 2.0 with
// a read-only API token supplied by the admin (ShipCheck Settings).
//
// Why external fetch, not Forge Bitbucket scopes: Forge forbids mixing
// Bitbucket "workspace scopes" (read:pullrequest:bitbucket,
// read:repository:bitbucket) with Jira/Confluence "site scopes" in one app
// (forge lint: "Workspace scopes can not be used with site scopes",
// ECO-223). The app therefore calls https://api.bitbucket.org with
// api.fetch (allowlisted in manifest.yml) and a Bearer API token.
//
// Failure policy (0.6.0): these functions NEVER throw. A missing token, a
// network error or an HTTP error returns { pullRequests: [], gap } /
// { deployments: [], gap } so the dashboard keeps working and labels the
// slice "not connected" (P1-3) instead of failing the whole panel.
//
// API shapes (Bitbucket Cloud REST API 2.0, verified against the docs
// 2026-11-16; live field mapping still needs a real workspace to confirm):
//   PR list:  GET /2.0/repositories/{workspace}/{repo}/pullrequests
//             ?state=OPEN|MERGED&pagelen=50 — paged via `next`.
//             Each PR: id, title, description, state, source.branch.name,
//             source.commit.hash, reviewers[].approved.
//   Commit statuses: GET /2.0/repositories/{workspace}/{repo}/commit/{hash}
//             /statuses — values[].state: SUCCESSFUL / FAILED / INPROGRESS /
//             STOPPED.
//   Pipelines: GET /2.0/repositories/{workspace}/{repo}/pipelines/
//             ?sort=-created_on&pagelen=25 — each run: uuid,
//             target.ref_name (branch), state.name (PENDING / IN_PROGRESS /
//             COMPLETED ...), state.result.name (SUCCESSFUL / FAILED /
//             STOPPED / ERROR).
const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
const MAX_PR_PAGES = 20;
const MAX_PIPELINE_PAGES = 5;

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function fetchJson(fetchFn, url, token) {
  const res = await fetchFn(url, { headers: authHeaders(token) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

/** Follow a paged Bitbucket list (`values` + `next`) until exhausted. */
async function fetchAllPages(fetchFn, firstUrl, token, maxPages) {
  const values = [];
  let url = firstUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    const out = await fetchJson(fetchFn, url, token);
    if (!out.ok) return { ok: false, status: out.status, values };
    values.push(...(out.data?.values ?? []));
    url = out.data?.next ?? null;
    pages += 1;
  }
  return { ok: true, values };
}

function prText(pr) {
  return `${pr.title ?? ''} ${pr.description ?? ''} ${pr.source?.branch?.name ?? ''}`.toLowerCase();
}

/** Map commit-status values to the 'pass' | 'pending' | 'fail' checks field. */
export function mapChecksFromStatuses(statuses) {
  const values = statuses ?? [];
  if (values.length === 0) return 'pending';
  if (values.some((s) => s.state === 'FAILED' || s.state === 'STOPPED')) return 'fail';
  if (values.every((s) => s.state === 'SUCCESSFUL')) return 'pass';
  return 'pending';
}

/**
 * Fetch PRs for a release, keeping only those linked to one of its issues
 * (title, description or source branch mentions an issue key).
 * @param {object} opts { fetchFn, workspace, repo, token, issueKeys[] }
 * @returns {Promise<{pullRequests: object[], gap: string|null}>} — never throws
 */
export async function fetchPullRequests({ fetchFn, workspace, repo, token, issueKeys }) {
  if (!workspace || !repo || !token) {
    return {
      pullRequests: [],
      gap: 'Bitbucket is not configured: set the workspace, repository and API token in ShipCheck Settings.',
    };
  }
  try {
    const keys = (issueKeys ?? []).map((k) => String(k).toLowerCase()).filter(Boolean);
    const all = [];
    for (const state of ['OPEN', 'MERGED']) {
      const page = await fetchAllPages(
        fetchFn,
        `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests?state=${state}&pagelen=50`,
        token,
        MAX_PR_PAGES,
      );
      if (!page.ok) {
        return { pullRequests: [], gap: `Bitbucket pull requests request failed (HTTP ${page.status}).` };
      }
      all.push(...page.values);
    }
    const linked = all.filter((pr) => keys.length > 0 && keys.some((k) => prText(pr).includes(k)));
    const pullRequests = [];
    for (const pr of linked) {
      let checks = 'pending';
      const hash = pr.source?.commit?.hash;
      if (hash) {
        try {
          const st = await fetchJson(
            fetchFn,
            `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(hash)}/statuses?pagelen=25`,
            token,
          );
          // A failed statuses call only degrades this PR to 'pending' — it
          // must not drop the whole PR list.
          if (st.ok) checks = mapChecksFromStatuses(st.data?.values);
        } catch (e) {
          checks = 'pending';
        }
      }
      pullRequests.push({
        id: pr.id,
        title: pr.title ?? '',
        state: pr.state,
        approvals: (pr.reviewers ?? []).filter((r) => r.approved === true).length,
        checks,
        // 0.7.0 (P1-4, layer 3): the source commit hash lets the adapter
        // associate this PR with an issue via the issue's commit list
        // (dev-status dataType=repository), even when the title/branch
        // never mentions the issue key.
        commitHash: hash ?? null,
        matchedVia: 'title',
      });
    }
    return { pullRequests, gap: null };
  } catch (e) {
    return { pullRequests: [], gap: `Bitbucket request failed: ${e?.message ?? e}` };
  }
}

/**
 * Fetch one PR by id and normalize it (0.7.0, P1-4 layer 3): used to
 * enrich a dev-status PR (which carries no approvals/checks) with the
 * Bitbucket-side data — reviewers, source commit hash, checks from the
 * commit statuses. Returns null on any failure (404, no token, network);
 * the caller keeps the dev-status record instead of dropping the PR.
 * @param {object} opts { fetchFn, workspace, repo, token, prId }
 * @returns {Promise<object|null>}
 */
export async function enrichPrFromBitbucket({ fetchFn, workspace, repo, token, prId }) {
  if (!workspace || !repo || !token || prId === undefined || prId === null) return null;
  try {
    const out = await fetchJson(
      fetchFn,
      `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${encodeURIComponent(String(prId))}`,
      token,
    );
    if (!out.ok) return null;
    const pr = out.data ?? {};
    let checks = 'pending';
    const hash = pr.source?.commit?.hash;
    if (hash) {
      try {
        const st = await fetchJson(
          fetchFn,
          `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(hash)}/statuses?pagelen=25`,
          token,
        );
        if (st.ok) checks = mapChecksFromStatuses(st.data?.values);
      } catch (e) {
        checks = 'pending';
      }
    }
    return {
      id: pr.id,
      title: pr.title ?? '',
      state: pr.state,
      approvals: (pr.reviewers ?? []).filter((r) => r.approved === true).length,
      checks,
      commitHash: hash ?? null,
    };
  } catch (e) {
    return null;
  }
}

function mapPipelineState(run) {
  const state = run?.state ?? {};
  if (state.name === 'COMPLETED') {
    if (state.result?.name === 'SUCCESSFUL') return 'SUCCESSFUL';
    if (['FAILED', 'ERROR', 'STOPPED'].includes(state.result?.name)) return 'FAILED';
    return state.result?.name ?? 'COMPLETED';
  }
  return state.name ?? 'UNKNOWN';
}

/**
 * Fetch the latest pipeline run for one branch.
 * @param {object} opts { fetchFn, workspace, repo, token, branch }
 * @returns {Promise<{deployments: object[], gap: string|null}>} — never throws
 */
export async function fetchDeployments({ fetchFn, workspace, repo, token, branch = 'main' }) {
  if (!workspace || !repo || !token) {
    return {
      deployments: [],
      gap: 'Bitbucket is not configured: set the workspace, repository and API token in ShipCheck Settings.',
    };
  }
  try {
    const page = await fetchAllPages(
      fetchFn,
      `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/?sort=-created_on&pagelen=25`,
      token,
      MAX_PIPELINE_PAGES,
    );
    if (!page.ok) {
      return { deployments: [], gap: `Bitbucket pipelines request failed (HTTP ${page.status}).` };
    }
    const run = page.values.find((r) => r.target?.ref_name === branch);
    if (!run) {
      return { deployments: [], gap: `No Bitbucket pipeline runs found for branch "${branch}".` };
    }
    return {
      deployments: [{ id: run.uuid, environment: branch, state: mapPipelineState(run) }],
      gap: null,
    };
  } catch (e) {
    return { deployments: [], gap: `Bitbucket request failed: ${e?.message ?? e}` };
  }
}
