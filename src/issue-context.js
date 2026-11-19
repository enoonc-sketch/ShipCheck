// Per-issue context — PURE logic, no Forge calls.
// Powers the jira.issuePanel view: which release the issue belongs to,
// whether it blocks that release, and the release score it contributes to.
// Reuses the same scoring engine as the dashboard (no second source of truth).
import { scoreRelease } from './scoring.js';
import { collectBlockers } from './blockers.js';

const BLOCKER_PRIORITIES = new Set(['Blocker', 'Highest']);
const DONE_STATUSES = new Set(['Done', 'Closed', 'Resolved']);

/**
 * @param {object} ctx release context { issues[], pullRequests[], deployments[], docsReady, version, projectKey }
 * @param {string} issueKey e.g. "SHIP-9"
 * @returns {found:true, issue, isBlocker, blockerReason?, release:{version,projectKey,score,verdict}, releaseBlockers, scoreDrag, linkedPullRequests}
 *          or {found:false, issueKey}
 *   scoreDrag (0.7.0, P1-9): what the release score would become if this
 *   issue were Done — { ifFixed, delta }. For an already-Done issue the
 *   delta is 0. Linked PRs are the release PRs associated with this issue
 *   (dev-status issueKey, or a title that mentions the key).
 */
export function getIssueContext(ctx, issueKey) {
  const issues = ctx?.issues ?? [];
  const issue = issues.find((i) => i.key === issueKey);
  if (!issue) return { found: false, issueKey };
  const result = scoreRelease(ctx);
  const releaseBlockers = collectBlockers(ctx);
  const isBlocker = issue.type === 'Bug'
    && BLOCKER_PRIORITIES.has(issue.priority)
    && !DONE_STATUSES.has(issue.status);
  // P1-9: the score drag of this issue — rescore the release with this
  // issue Done. A blocker bug drags twice (blocker slice + issues slice);
  // an ordinary open issue drags only the issues slice.
  const fixedCtx = {
    ...ctx,
    issues: issues.map((i) => (i.key === issueKey ? { ...i, status: 'Done' } : i)),
  };
  const fixedScore = scoreRelease(fixedCtx).score;
  const scoreDrag = { ifFixed: fixedScore, delta: fixedScore - result.score };
  // P1-9: PRs linked to this issue — dev-status recorded the issue key,
  // otherwise a title mentioning the key counts (same rule as layer 1).
  const keyLower = issueKey.toLowerCase();
  const linkedPullRequests = (ctx.pullRequests ?? []).filter((pr) =>
    pr.issueKey === issueKey
    || (typeof pr.title === 'string' && pr.title.toLowerCase().includes(keyLower)),
  ).map((pr) => ({
    id: pr.id,
    title: pr.title ?? '',
    state: pr.state,
    matchedVia: pr.matchedVia ?? 'title',
  }));
  return {
    found: true,
    issue,
    isBlocker,
    blockerReason: isBlocker ? 'Open Blocker bug' : undefined,
    release: {
      version: ctx.version,
      projectKey: ctx.projectKey,
      score: result.score,
      verdict: result.verdict,
    },
    releaseBlockers,
    scoreDrag,
    linkedPullRequests,
  };
}
