// ShipCheck readiness-score engine — PURE logic, no Atlassian calls, no LLM.
// Deterministic, rule-based scoring so the Forge app costs $0 in LLM credits.
// Weights mirror the TRIDENT-style weighted score T already uses in ASTA.
// Blockers come from the single shared entry point (src/blockers.js): the
// score, the getBlockers resolver and the weekly digest all use the same
// list, so the verdict and the blockers list can never disagree (0.6.0).
//
// 0.7.0 changes (T approved):
//   - Tiered blocker deductions (was all-or-nothing): each open blocker
//     bug deducts 15, each failed deployment 20, each unapproved PR 5
//     from the 40-pt blockers slice, floored at 0. The hard rule is
//     unchanged: any blocker still forces verdict BLOCKED.
//   - Rescaling: a slice whose data source is unwired/error is EXCLUDED
//     from the total instead of scoring 0 — the remaining slices are
//     scaled up to 100. A connected slice that scores 0 is NOT excluded.
//   - Weights are configurable (admin setting, default 40/25/20/15,
//     sum must be 100); scoreRelease takes them as an optional argument.
//   - scoreRelease also returns the "what's missing" todo list (P1-7):
//     one entry per fixable item with its expected score gain, computed
//     by re-scoring the hypothetical fixed context.
import { collectBlockers } from './blockers.js';

export const READINESS_WEIGHTS = {
  blockers: 40, // open Blocker/Highest bugs + failed deployments
  pullRequests: 25, // PRs merged / approved / checks green
  issuesDone: 20, // share of scoped issues Done
  docs: 15, // release notes / docs ready
};

// Scoring-rules version stamped on history snapshots (P0-4): weights +
// deduction scheme + rescaling, so a trend across a rule change can be
// labelled "old rules" instead of silently comparing unlike scores.
export function rulesVersion(weights = READINESS_WEIGHTS) {
  const w = normalizeWeights(weights);
  return `0.7.0-tiered+rescale:${w.blockers}/${w.pullRequests}/${w.issuesDone}/${w.docs}`;
}

const BLOCKER_PRIORITIES = new Set(['Blocker', 'Highest']);
const DONE_STATUSES = new Set(['Done', 'Closed', 'Resolved']);

// Tiered deductions off the blockers slice (0.7.0, P1-1, T approved).
const DEDUCT_BUG = 15;
const DEDUCT_DEPLOYMENT = 20;
const DEDUCT_UNAPPROVED_PR = 5;

/** Validate a weights object; fall back to the defaults when unusable. */
export function normalizeWeights(weights) {
  const w = weights ?? {};
  const ints = ['blockers', 'pullRequests', 'issuesDone', 'docs'].map((k) => {
    const n = Number(w[k]);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
  });
  if (ints.some((n) => n === null)) return { ...READINESS_WEIGHTS };
  const [blockers, pullRequests, issuesDone, docs] = ints;
  if (blockers + pullRequests + issuesDone + docs !== 100) return { ...READINESS_WEIGHTS };
  return { blockers, pullRequests, issuesDone, docs };
}

/** Verdict from score + hard blockers. Any hard blocker overrides the score. */
export function verdictFor(score, blockers) {
  if (blockers && blockers.length > 0) return 'BLOCKED';
  if (score >= 90) return 'READY';
  if (score >= 60) return 'CAUTION';
  return 'BLOCKED';
}

/**
 * Score one release.
 * @param {object} input { issues[], pullRequests[], deployments[], docsReady, dataSources?, truncated? }
 *   dataSources (optional): { jira, pullRequests, deployments, docs } each
 *   'live' | 'demo' | 'unwired' | 'error'. Unwired/error slices are
 *   EXCLUDED from the total (rescaled); without dataSources every slice
 *   counts (old behaviour, kept for pure-logic callers and tests).
 * @param {object} weights optional weights (default READINESS_WEIGHTS)
 * @returns {{score:number, verdict:string, blockers:object[], warnings:string[],
 *   breakdown:object, coverage:object, rescaled:boolean, todos:object[]}}
 *   breakdown holds a number for connected slices and null for excluded ones.
 */
export function scoreRelease(input, weights = READINESS_WEIGHTS) {
  const result = scoreReleaseCore(input, weights);
  return {
    ...result,
    todos: buildTodos(input, normalizeWeights(weights), result.score),
  };
}

/**
 * The score without the todo list (the todos are computed from this core
 * by re-scoring hypothetical contexts — calling scoreRelease there would
 * recurse, so buildTodos uses this core directly).
 */
export function scoreReleaseCore(input, weights = READINESS_WEIGHTS) {
  const w = normalizeWeights(weights);
  const issues = input.issues ?? [];
  const pullRequests = input.pullRequests ?? [];
  const deployments = input.deployments ?? [];
  const ds = input.dataSources ?? null;
  // A source counts as connected when it delivered data ('live') or is
  // labelled sample data ('demo'). 'unwired' / 'error' mean "no data" —
  // those slices are excluded, not scored 0 (0.7.0, P1-2).
  const connected = (key) => !ds || (ds[key] !== 'unwired' && ds[key] !== 'error');
  const prsConnected = connected('pullRequests');
  const jiraConnected = connected('jira');
  const docsConnected = connected('docs');
  const breakdown = { blockers: null, pullRequests: null, issuesDone: null, docs: null };
  const warnings = [];

  // --- Blockers slice: tiered deductions (0.7.0, P1-1) ---
  // The blocker LIST comes from collectBlockers() (the single entry point).
  // Each open blocker bug deducts 15, each failed deployment 20, each
  // unapproved PR 5 — floored at 0. The slice is tied to the Jira source:
  // without Jira data there is nothing to deduct from, so it is excluded.
  const blockers = collectBlockers({ issues, pullRequests, deployments });
  if (jiraConnected) {
    const bugs = blockers.filter((b) => b.kind === 'bug').length;
    const failedDeps = blockers.filter((b) => b.kind === 'deployment').length;
    const unapprovedPrs = blockers.filter((b) => b.kind === 'pullRequest').length;
    breakdown.blockers = Math.max(
      0,
      w.blockers - DEDUCT_BUG * bugs - DEDUCT_DEPLOYMENT * failedDeps - DEDUCT_UNAPPROVED_PR * unapprovedPrs,
    );
  } else {
    warnings.push('Issue data is not connected — blockers excluded from the score.');
  }

  // --- PR slice: fraction of PRs merged-or-approved with green checks ---
  if (!prsConnected) {
    warnings.push('Pull requests are not connected — excluded from the score.');
  } else if (pullRequests.length === 0) {
    breakdown.pullRequests = 0;
    warnings.push('No pull requests linked to this release.');
  } else {
    const good = pullRequests.filter(
      (pr) => (pr.state === 'MERGED' || (pr.state === 'OPEN' && pr.approvals > 0)) && pr.checks === 'pass',
    ).length;
    breakdown.pullRequests = Math.round((good / pullRequests.length) * w.pullRequests);
    const unreviewed = pullRequests.filter((pr) => pr.state === 'OPEN' && pr.approvals === 0);
    for (const pr of unreviewed) warnings.push(`PR #${pr.id} is open with no approvals.`);
  }

  // --- Issues slice: share of scoped issues Done ---
  if (!jiraConnected) {
    warnings.push('Issue data is not connected — issues excluded from the score.');
  } else if (issues.length === 0) {
    breakdown.issuesDone = 0;
    warnings.push('No issues scoped to this release.');
  } else {
    const done = issues.filter((i) => DONE_STATUSES.has(i.status)).length;
    breakdown.issuesDone = Math.round((done / issues.length) * w.issuesDone);
    const open = issues.filter((i) => !DONE_STATUSES.has(i.status));
    for (const i of open) {
      if (!BLOCKER_PRIORITIES.has(i.priority) || i.type !== 'Bug') {
        warnings.push(`${i.key} is still ${i.status}.`);
      }
    }
    // P1-1 (0.6.0): the Jira fetch caps at MAX_JIRA_ISSUES — say so, or the
    // score silently covers only part of a large release.
    if (input.truncated) warnings.push('Only the first 1000 issues were scored (Jira page limit).');
  }

  // --- Docs slice ---
  if (!docsConnected) {
    warnings.push('Docs are not connected — excluded from the score.');
  } else {
    breakdown.docs = input.docsReady ? w.docs : 0;
    if (!input.docsReady) warnings.push('Release notes / docs not ready.');
  }

  // --- Total: rescale over the connected slices (0.7.0, P1-2) ---
  const connectedWeights =
    (breakdown.blockers !== null ? w.blockers : 0)
    + (breakdown.pullRequests !== null ? w.pullRequests : 0)
    + (breakdown.issuesDone !== null ? w.issuesDone : 0)
    + (breakdown.docs !== null ? w.docs : 0);
  const connectedSum = Object.values(breakdown).reduce((a, b) => a + (b ?? 0), 0);
  const connectedCount = Object.values(breakdown).filter((v) => v !== null).length;
  // Empty release = nothing to ship.
  const isEmpty = issues.length === 0 && pullRequests.length === 0 && deployments.length === 0;
  const score = isEmpty || connectedWeights === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((connectedSum / connectedWeights) * 100)));
  const rescaled = connectedCount < 4;

  return {
    score,
    verdict: verdictFor(score, blockers),
    blockers,
    warnings,
    breakdown,
    coverage: { connected: connectedCount, total: 4, label: `Based on ${connectedCount}/4 data sources` },
    rescaled,
  };
}

/**
 * "What's missing" list (0.7.0, P1-7): one entry per fixable item, ordered
 * blockers first, then unapproved PRs, then unfinished issues, then docs.
 * Each gain is computed by re-scoring the hypothetical fixed context, so
 * it follows the tiered deductions and the rescaling exactly. Items from
 * unwired sources are never listed (their gain cannot be computed).
 * @returns {Array<{key:string, kind:string, text:string, gain:number}>}
 */
export function buildTodos(input, weights = READINESS_WEIGHTS, currentScore = null) {
  const w = normalizeWeights(weights);
  const issues = input.issues ?? [];
  const pullRequests = input.pullRequests ?? [];
  const deployments = input.deployments ?? [];
  const ds = input.dataSources ?? null;
  const connected = (key) => !ds || (ds[key] !== 'unwired' && ds[key] !== 'error');
  const base = currentScore ?? scoreRelease(input, w).score;
  const todos = [];
  const gainOf = (mutate) => {
    const next = {
      issues: issues.map((i) => ({ ...i })),
      pullRequests: pullRequests.map((p) => ({ ...p })),
      deployments: deployments.map((d) => ({ ...d })),
      docsReady: input.docsReady,
      dataSources: ds,
      truncated: input.truncated,
    };
    mutate(next);
    return scoreReleaseCore(next, w).score - base;
  };

  if (connected('jira')) {
    for (const i of issues) {
      if (i.type === 'Bug' && BLOCKER_PRIORITIES.has(i.priority) && !DONE_STATUSES.has(i.status)) {
        const gain = gainOf((n) => {
          n.issues.find((x) => x.key === i.key).status = 'Done';
        });
        if (gain > 0) todos.push({ key: i.key, kind: 'bug', text: `Fix ${i.key}`, gain });
      }
    }
    for (const d of deployments) {
      if (d.state === 'FAILED') {
        const gain = gainOf((n) => {
          n.deployments.find((x) => x.id === d.id).state = 'SUCCESSFUL';
        });
        if (gain > 0) todos.push({ key: d.id, kind: 'deployment', text: `Re-run the failed ${d.environment} deployment`, gain });
      }
    }
  }
  if (connected('pullRequests')) {
    for (const pr of pullRequests) {
      if (pr.state === 'OPEN' && pr.approvals === 0) {
        const gain = gainOf((n) => {
          n.pullRequests.find((x) => x.id === pr.id).approvals = 1;
        });
        if (gain > 0) todos.push({ key: `PR-${pr.id}`, kind: 'pullRequest', text: `Approve PR #${pr.id}`, gain });
      }
    }
  }
  if (connected('jira')) {
    for (const i of issues) {
      const isBlockerBug = i.type === 'Bug' && BLOCKER_PRIORITIES.has(i.priority) && !DONE_STATUSES.has(i.status);
      if (!isBlockerBug && !DONE_STATUSES.has(i.status)) {
        const gain = gainOf((n) => {
          n.issues.find((x) => x.key === i.key).status = 'Done';
        });
        if (gain > 0) todos.push({ key: i.key, kind: 'issue', text: `Finish ${i.key}`, gain });
      }
    }
  }
  if (connected('docs') && !input.docsReady) {
    const gain = gainOf((n) => { n.docsReady = true; });
    if (gain > 0) todos.push({ key: 'docs', kind: 'docs', text: 'Publish the release notes', gain });
  }
  return todos;
}

/**
 * "Why this score" explanation (0.8.0, P2-2): structured facts behind the
 * breakdown, so the UI can show the reasoning without re-deriving it.
 * The facts are language-free (keys, counts, ids) — the UI formats them
 * through the i18n dictionary. The numbers come from the same inputs and
 * the same deduction constants as scoreReleaseCore, so the explanation
 * can never disagree with the score; pass the already-computed result
 * to avoid scoring twice (it is recomputed when omitted).
 * @returns {{isEmpty:boolean, rescaled:boolean, slices:Array}}
 *   slices: [{ key, value (null = excluded), max, state: 'scored'|'excluded',
 *   facts }] — blockers facts { bugs:[keys], failedDeployments:[ids],
 *   unapprovedPrs:[keys] }; pullRequests { total, good, unapproved:[ids] };
 *   issuesDone { done, total }; docs { ready }.
 */
export function explainScore(input, weights = READINESS_WEIGHTS, result = null) {
  const w = normalizeWeights(weights);
  const r = result ?? scoreReleaseCore(input, w);
  const issues = input.issues ?? [];
  const pullRequests = input.pullRequests ?? [];
  const deployments = input.deployments ?? [];
  const blockers = r.blockers ?? [];
  const goodPrs = pullRequests.filter(
    (pr) => (pr.state === 'MERGED' || (pr.state === 'OPEN' && pr.approvals > 0)) && pr.checks === 'pass',
  ).length;
  const doneCount = issues.filter((i) => DONE_STATUSES.has(i.status)).length;
  return {
    isEmpty: issues.length === 0 && pullRequests.length === 0 && deployments.length === 0,
    rescaled: r.rescaled,
    slices: [
      {
        key: 'blockers',
        value: r.breakdown.blockers,
        max: w.blockers,
        state: r.breakdown.blockers === null ? 'excluded' : 'scored',
        facts: {
          bugs: blockers.filter((b) => b.kind === 'bug').map((b) => b.key),
          failedDeployments: blockers.filter((b) => b.kind === 'deployment').map((b) => b.key),
          unapprovedPrs: blockers.filter((b) => b.kind === 'pullRequest').map((b) => b.key),
        },
      },
      {
        key: 'pullRequests',
        value: r.breakdown.pullRequests,
        max: w.pullRequests,
        state: r.breakdown.pullRequests === null ? 'excluded' : 'scored',
        facts: {
          total: pullRequests.length,
          good: goodPrs,
          unapproved: pullRequests.filter((pr) => pr.state === 'OPEN' && pr.approvals === 0).map((pr) => `PR-${pr.id}`),
        },
      },
      {
        key: 'issuesDone',
        value: r.breakdown.issuesDone,
        max: w.issuesDone,
        state: r.breakdown.issuesDone === null ? 'excluded' : 'scored',
        facts: { done: doneCount, total: issues.length },
      },
      {
        key: 'docs',
        value: r.breakdown.docs,
        max: w.docs,
        state: r.breakdown.docs === null ? 'excluded' : 'scored',
        facts: { ready: !!input.docsReady },
      },
    ],
  };
}
