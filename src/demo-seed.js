// Demo-data seed — PURE logic, no Forge calls, no network.
// What a judge sees on a fresh site with zero configuration: the app ships
// with three bundled scenarios and shows one of them (clearly labelled
// "Demo data") whenever there is no real release data to score.
// The scenarios mirror the shipped mock sample (release-sample.json).
export const DEMO_SCENARIOS = {
  // The shipped sample: a release in trouble (23/100, BLOCKED).
  blocked: {
    projectKey: 'SHIP',
    version: '1.4.0',
    docsReady: false,
    issues: [
      { key: 'SHIP-1', priority: 'Medium', status: 'Done', summary: 'Add dark mode toggle', type: 'Story' },
      { key: 'SHIP-2', priority: 'High', status: 'Done', summary: 'Fix login crash on iOS', type: 'Bug' },
      { key: 'SHIP-3', priority: 'Medium', status: 'In Progress', summary: 'Offline sync for mobile', type: 'Story' },
      { key: 'SHIP-9', priority: 'Blocker', status: 'To Do', summary: 'Data loss when saving offline draft', type: 'Bug' },
    ],
    pullRequests: [
      { approvals: 2, checks: 'pass', id: 101, state: 'MERGED', title: 'Dark mode' },
      { approvals: 0, checks: 'pending', id: 102, state: 'OPEN', title: 'Offline sync (unreviewed)' },
    ],
    deployments: [
      { environment: 'staging', id: 'dep-1', state: 'SUCCESSFUL' },
      { environment: 'production', id: 'dep-2', state: 'FAILED' },
    ],
  },
  // The happy path: everything green, 100/100 READY.
  ready: {
    projectKey: 'SHIP',
    version: '2.0.0',
    docsReady: true,
    issues: [
      { key: 'SHIP-11', priority: 'Medium', status: 'Done', summary: 'Add dark mode toggle', type: 'Story' },
      { key: 'SHIP-12', priority: 'High', status: 'Done', summary: 'Fix login crash on iOS', type: 'Bug' },
      { key: 'SHIP-13', priority: 'Medium', status: 'Done', summary: 'Offline sync for mobile', type: 'Story' },
      { key: 'SHIP-14', priority: 'Low', status: 'Done', summary: 'Update onboarding copy', type: 'Task' },
    ],
    pullRequests: [
      { approvals: 2, checks: 'pass', id: 201, state: 'MERGED', title: 'Dark mode' },
      { approvals: 1, checks: 'pass', id: 202, state: 'MERGED', title: 'Offline sync' },
    ],
    deployments: [
      { environment: 'production', id: 'dep-9', state: 'SUCCESSFUL' },
    ],
  },
  // A fresh project with nothing in it yet: 0/100 BLOCKED.
  empty: {
    projectKey: 'SHIP',
    version: '0.0.0',
    docsReady: false,
    issues: [],
    pullRequests: [],
    deployments: [],
  },
};

/** Deep copy of one scenario, flagged as demo data. */
export function getDemoContext(scenario = 'blocked') {
  const seed = DEMO_SCENARIOS[scenario];
  if (!seed) throw new Error(`getDemoContext: unknown scenario "${scenario}" (use "blocked", "ready" or "empty")`);
  return { ...JSON.parse(JSON.stringify(seed)), demo: true };
}

/** True when a release context has nothing to score. */
export function isEmptyContext(ctx) {
  if (!ctx) return true;
  return (ctx.issues ?? []).length === 0
    && (ctx.pullRequests ?? []).length === 0
    && (ctx.deployments ?? []).length === 0;
}

/**
 * Refuse an action that must only run on real data (e.g. publishing release
 * notes to Confluence). Demo data is labelled sample content — publishing it
 * would create a fake page on a real site.
 */
export function assertRealContext(ctx) {
  if (ctx?.demo) {
    throw new Error('Demo data cannot be published. Set a project and version in ShipCheck Settings first.');
  }
}

/**
 * Decide what the dashboard scores: real data, or the demo seed.
 * @param {object} opts { real, settings, scenario }
 * @returns the context to score, with demo/demoReason flags attached.
 */
export function selectContext({ real, settings, scenario = 'blocked' }) {
  if (settings?.demoMode === true) {
    return { ...getDemoContext(scenario), demoReason: 'manual' };
  }
  if (isEmptyContext(real)) {
    return { ...getDemoContext(scenario), demoReason: 'empty' };
  }
  return { ...real, demo: false };
}
