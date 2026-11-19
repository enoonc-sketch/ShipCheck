// Blockers rollup — PURE logic. One list for the UI: every hard blocker in a release.
// THIS FILE IS THE SINGLE BLOCKER ENTRY POINT for the whole app (0.6.0):
// scoreRelease() (src/scoring.js), the getBlockers resolver (src/index.js)
// and the weekly digest (src/trigger.js) all use collectBlockers() — never
// build a second blocker list, or the verdict and the list can disagree.
const BLOCKER_PRIORITIES = new Set(['Blocker', 'Highest']);
const DONE_STATUSES = new Set(['Done', 'Closed', 'Resolved']);

/**
 * @param {object} ctx { issues[], pullRequests[], deployments[] }
 * @returns {Array<{kind:string, key:string, summary:string}>}
 */
export function collectBlockers(ctx) {
  const blockers = [];
  for (const i of ctx.issues ?? []) {
    if (i.type === 'Bug' && BLOCKER_PRIORITIES.has(i.priority) && !DONE_STATUSES.has(i.status)) {
      blockers.push({ kind: 'bug', key: i.key, summary: i.summary ?? i.key });
    }
  }
  for (const pr of ctx.pullRequests ?? []) {
    if (pr.state === 'OPEN' && pr.approvals === 0) {
      blockers.push({ kind: 'pullRequest', key: `PR-${pr.id}`, summary: `PR #${pr.id} "${pr.title ?? ''}" has no approvals` });
    }
  }
  for (const d of ctx.deployments ?? []) {
    if (d.state === 'FAILED') {
      blockers.push({ kind: 'deployment', key: d.id, summary: `Deployment to ${d.environment} failed` });
    }
  }
  return blockers;
}
