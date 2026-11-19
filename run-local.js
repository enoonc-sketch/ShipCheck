// Local demo runner — proves the whole ShipCheck pipeline end to end
// with the MOCK adapter: no Atlassian account, no network, no Forge deploy.
// Also demos the three demo-seed scenarios (blocked / ready / empty) and the
// version-trend engine, so a reviewer can see every UI state locally.
// Run: node run-local.js
import { fetchReleaseContext } from './src/adapters.js';
import { scoreRelease } from './src/scoring.js';
import { collectBlockers } from './src/blockers.js';
import { generateReleaseNotes } from './src/release-notes.js';
import { getDemoContext } from './src/demo-seed.js';
import { recordSnapshot, computeTrend, trendLabel } from './src/history.js';
import { buildDigest, shouldSendDigest } from './src/digest.js';

function showRelease(ctx, label) {
  const result = scoreRelease(ctx);
  const blockers = collectBlockers(ctx);
  console.log(`\n--- ${label} ---`);
  console.log(`ShipCheck — ${ctx.projectKey} ${ctx.version}${ctx.demo ? ' (demo data)' : ''}`);
  console.log(`Score: ${result.score}/100 — ${result.verdict}`);
  console.log('Breakdown:', JSON.stringify(result.breakdown));
  console.log(`Blockers (${blockers.length}):`);
  for (const b of blockers) console.log(`  - [${b.kind}] ${b.key}: ${b.summary}`);
  console.log(`Warnings (${result.warnings.length}):`);
  for (const w of result.warnings) console.log(`  - ${w}`);
  return result;
}

// 1. The shipped sample, via the mock adapter (unchanged baseline behaviour).
const ctx = await fetchReleaseContext({ adapter: 'mock', version: '1.4.0' });
const result = showRelease(ctx, 'Mock adapter — SHIP 1.4.0 (shipped sample)');
const notes = generateReleaseNotes({ version: ctx.version, issues: ctx.issues, format: 'markdown' });
console.log('\n--- Release notes (Markdown) ---\n' + notes);

// 2. The other two demo-seed scenarios (zero-config demo for judges).
showRelease(getDemoContext('ready'), 'Demo seed — ready (2.0.0, all green)');
showRelease(getDemoContext('empty'), 'Demo seed — empty (0.0.0, fresh project)');

// 3. Version trend: 1.3.0 scored 80, then 1.4.0 scored 23.
let history = [];
history = recordSnapshot(history, { version: '1.3.0', score: 80, verdict: 'CAUTION', recordedAt: '2026-11-01T00:00:00.000Z' });
history = recordSnapshot(history, { version: '1.4.0', score: result.score, verdict: result.verdict, recordedAt: '2026-11-16T00:00:00.000Z' });
console.log('\n--- Version trend ---');
console.log(trendLabel(computeTrend(history)));

// 4. Weekly digest: would it fire on Friday 2026-11-20, never sent before?
const digest = buildDigest({
  projectKey: 'SHIP',
  version: '1.4.0',
  result,
  blockers: collectBlockers(ctx),
  trend: computeTrend(history),
});
console.log('\n--- Weekly digest preview ---');
console.log(digest.subject);
console.log(digest.markdown);
console.log('\nDigest due on Fri 2026-11-20 (never sent)?',
  shouldSendDigest({ digestEnabled: true, digestDay: 5, projectKey: 'SHIP', version: '1.4.0' }, new Date('2026-11-20T09:00:00.000Z'), null));
