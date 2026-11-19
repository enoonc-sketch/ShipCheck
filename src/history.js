// Score-history engine — PURE logic, no Forge calls, no LLM.
// Stores one readiness snapshot per release version in Forge Storage
// (key HISTORY_STORAGE_KEY) so the dashboard can show "this version vs last".
// Scoring weights and verdict thresholds are NOT touched here — see scoring.js.
//
// 0.7.0 storage layout (P1-5): history is split per version so one
// release's re-scores never evict another's:
//   - `shipcheck:history:index` — one entry per version (the LATEST
//     snapshot of that version: { version, score, verdict, recordedAt,
//     rules }), sorted by recordedAt, capped at 200 versions. The trend
//     line reads this key only.
//   - `shipcheck:history:<version>` — the last 5 snapshots of that
//     version (for detail, not needed by the trend).
// The old flat `shipcheck:score-history` key (0.6.0) is migrated once
// into the new layout and then deleted (see migrateLegacyHistory).
// Per-value size limit (Forge KVS, official docs 2026-11-16): 240 KiB —
// a 5-snapshot array is a few KB, far below it; the 200-version index
// is ~30 KB. Total storage is bounded by construction.
import { scoreRelease, rulesVersion } from './scoring.js';

export const HISTORY_STORAGE_KEY = 'shipcheck:score-history';
export const HISTORY_INDEX_KEY = 'shipcheck:history:index';
export const MAX_HISTORY_ENTRIES = 50;
export const MAX_SNAPSHOTS_PER_VERSION = 5;
export const MAX_HISTORY_VERSIONS = 200;

const VERDICTS = new Set(['READY', 'CAUTION', 'BLOCKED']);

/** Storage key holding the last snapshots of one version. */
export function historyKeyFor(version) {
  return `shipcheck:history:${String(version).trim()}`;
}

/** Validate one snapshot; throws on garbage instead of storing it. */
function validateSnapshot(s) {
  if (!s || typeof s.version !== 'string' || s.version.trim() === '') {
    throw new Error('recordSnapshot: snapshot.version is required');
  }
  if (typeof s.score !== 'number' || !Number.isFinite(s.score) || s.score < 0 || s.score > 100) {
    throw new Error('recordSnapshot: snapshot.score must be a number between 0 and 100');
  }
  if (!VERDICTS.has(s.verdict)) {
    throw new Error(`recordSnapshot: snapshot.verdict must be READY, CAUTION or BLOCKED (got "${s.verdict}")`);
  }
  if (s.rules !== undefined && (typeof s.rules !== 'string' || s.rules.trim() === '')) {
    throw new Error('recordSnapshot: snapshot.rules must be a non-empty string when present');
  }
}

/** The scoring-rules tag of a snapshot; snapshots without one are 0.6.0. */
export function rulesOf(snapshot) {
  return snapshot?.rules ?? '0.6.0';
}

/**
 * Build the history snapshot for a release context by RECOMPUTING the
 * score on the backend (P0-4). The frontend's score/verdict are never
 * trusted: recordScore only passes a version, and this function derives
 * the snapshot from the real context. Demo contexts return null — demo
 * scores must not pollute history (the 0.5.1 demo 23/100 was recorded).
 * The snapshot carries the scoring-rules version (P0-4) so a trend
 * across a rule change can be labelled instead of silently comparing
 * unlike scores.
 * @param {object} ctx release context (scoreRelease input shape + demo flag)
 * @param {object} weights scoring weights used (default READINESS_WEIGHTS)
 * @returns {{version:string, score:number, verdict:string, rules:string}|null}
 */
export function snapshotFromContext(ctx, weights) {
  if (!ctx || ctx.demo) return null;
  const result = scoreRelease(ctx, weights);
  return { version: ctx.version, score: result.score, verdict: result.verdict, rules: rulesVersion(weights) };
}

/**
 * Append (or replace, for the same version) one snapshot.
 * @param {Array} history existing snapshots (never mutated)
 * @param {object} snapshot { version, score, verdict, recordedAt? }
 * @returns {Array} new history, sorted by recordedAt, capped at MAX_HISTORY_ENTRIES
 */
export function recordSnapshot(history, snapshot) {
  validateSnapshot(snapshot);
  const entry = {
    version: snapshot.version.trim(),
    score: snapshot.score,
    verdict: snapshot.verdict,
    recordedAt: snapshot.recordedAt ?? new Date().toISOString(),
  };
  if (snapshot.rules !== undefined) entry.rules = snapshot.rules;
  const next = (history ?? []).filter((s) => s.version !== entry.version);
  next.push(entry);
  next.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
  return next.slice(-MAX_HISTORY_ENTRIES);
}

/**
 * Append one snapshot to a single version's list (0.7.0, P1-5). Unlike
 * recordSnapshot (flat history, one entry per version), a version keeps
 * its last 5 snapshots so re-scores of the same version are visible.
 * @returns {Array} new list, sorted by recordedAt, capped at 5
 */
export function appendSnapshot(entries, snapshot) {
  validateSnapshot(snapshot);
  const entry = {
    version: snapshot.version.trim(),
    score: snapshot.score,
    verdict: snapshot.verdict,
    recordedAt: snapshot.recordedAt ?? new Date().toISOString(),
  };
  if (snapshot.rules !== undefined) entry.rules = snapshot.rules;
  const next = [...(entries ?? []), entry];
  next.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
  return next.slice(-MAX_SNAPSHOTS_PER_VERSION);
}

/**
 * Upsert one version's latest snapshot into the history index (0.7.0,
 * P1-5). The index holds exactly one entry per version (its latest
 * snapshot), sorted by recordedAt, capped at 200 versions — the oldest
 * version drops off entirely (its per-version key is deleted by the
 * caller). Returns the new index, never mutating the input.
 */
export function updateVersionIndex(index, snapshot) {
  validateSnapshot(snapshot);
  const entry = {
    version: snapshot.version.trim(),
    score: snapshot.score,
    verdict: snapshot.verdict,
    recordedAt: snapshot.recordedAt ?? new Date().toISOString(),
  };
  if (snapshot.rules !== undefined) entry.rules = snapshot.rules;
  const next = (index ?? []).filter((s) => s.version !== entry.version);
  next.push(entry);
  next.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
  return next.slice(-MAX_HISTORY_VERSIONS);
}

/**
 * One-time migration of the 0.6.0 flat history array into the 0.7.0
 * per-version layout. Groups entries by version (last 5 each), builds
 * the index from each version's latest snapshot. Pure: the caller writes
 * the returned keys and deletes the legacy key.
 * @returns {{index:Array, perVersion:Object<string, Array>}}
 */
export function migrateLegacyHistory(flatHistory) {
  const perVersion = {};
  for (const s of flatHistory ?? []) {
    try {
      validateSnapshot(s);
    } catch (e) {
      continue; // skip garbage instead of failing the migration
    }
    const entry = {
      version: s.version.trim(),
      score: s.score,
      verdict: s.verdict,
      recordedAt: s.recordedAt ?? new Date().toISOString(),
    };
    if (s.rules !== undefined) entry.rules = s.rules;
    perVersion[entry.version] = appendSnapshot(perVersion[entry.version], entry);
  }
  let index = [];
  for (const entries of Object.values(perVersion)) {
    index = updateVersionIndex(index, entries[entries.length - 1]);
  }
  return { index, perVersion };
}

/**
 * Compare the newest snapshot with the one before it.
 * @returns {{current:object|null, previous:object|null, delta:number, direction:'up'|'down'|'flat'|'none'}}
 */
export function computeTrend(history) {
  const h = history ?? [];
  const current = h[h.length - 1] ?? null;
  const previous = h.length >= 2 ? h[h.length - 2] : null;
  if (!current || !previous) return { current, previous: null, delta: 0, direction: 'none' };
  const delta = current.score - previous.score;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return { current, previous, delta, direction };
}

/** One readable line for the dashboard and the weekly digest. */
export function trendLabel(trend) {
  if (!trend || trend.direction === 'none' || !trend.previous) {
    return 'First recorded score — no previous version to compare.';
  }
  const { delta, previous, current } = trend;
  let line;
  if (trend.direction === 'up') line = `▲ ${delta} pts vs ${previous.version} (${previous.score}/100)`;
  else if (trend.direction === 'down') line = `▼ ${-delta} pts vs ${previous.version} (${previous.score}/100)`;
  else line = `— no change vs ${previous.version} (${previous.score}/100)`;
  // P0-4: the two snapshots were scored under different rules — say so,
  // or the delta reads as progress/regression it is not. Snapshots
  // without a rules tag are 0.6.0 (pre-rules).
  if (current && rulesOf(current) !== rulesOf(previous)) {
    line += '（规则已变：旧规则）';
  }
  return line;
}
