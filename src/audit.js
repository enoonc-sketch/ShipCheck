// Audit log — PURE logic + storage-injected helpers, no Forge calls.
// Stage 0 review T10: the codebase had zero audit logging (`audit`
// appeared 0 times in src/), so a site admin could never answer "who
// changed what, when". Admin operations are now recorded: settings
// saves, release-notes publishes, AI summary calls, digest runs, and
// denied admin attempts (see requireAdmin in index.js).
//
// Storage: ONE key, `shipcheck:audit:events`, holding the last 100
// events oldest-first (FIFO — the 101st drops the oldest). Forge
// Storage caps a single value at 240 KiB; 100 small events are a few
// tens of KiB at most (pinned by a test in test/audit.test.js).
// Events hold only the time, the caller's account id, the action, the
// outcome and small identifying details (project/version/space/page id,
// score/verdict, result code). Secrets are structurally excluded:
// buildAuditEvent throws on secret-looking detail keys (review T9),
// and detail values must be flat primitives — no summary text, no
// settings blob, no keys, tokens or webhook URLs ever reach the log.
//
// Audit writes NEVER throw: recordAuditEvent swallows storage errors,
// because a failed audit write must never break the operation it
// records (same principle as the digest push channels, which never
// fail the digest). Reads surface storage errors honestly instead.
export const AUDIT_STORAGE_KEY = 'shipcheck:audit:events';
export const AUDIT_MAX_EVENTS = 100;

// Recordable actions. audit.read is denial-only: a successful read of
// the log is not itself logged (that would spam the log with its own
// reads); a DENIED read attempt is recorded under it.
export const AUDIT_ACTIONS = [
  'settings.save',
  'notes.publish',
  'ai.summary',
  'digest.run',
  'audit.read',
];

const DETAIL_MAX_STRING = 500;
const SECRET_KEY_PATTERN = /api[-_]?key|token|secret|password|credential|webhook/i;

/**
 * Build one audit event, validating its shape. Throws on garbage
 * instead of storing it — a malformed event must fail loudly at the
 * call site (tests), never silently enter the log.
 * @param {object} e { action, accountId?, ok?, detail?, at? }
 * @returns {{at:string, action:string, accountId:string|null, ok:boolean, detail:object}}
 */
export function buildAuditEvent({ action, accountId = null, ok = true, detail = {}, at } = {}) {
  if (!AUDIT_ACTIONS.includes(action)) {
    throw new Error(`buildAuditEvent: unknown audit action: ${String(action)}`);
  }
  if (accountId !== null && typeof accountId !== 'string') {
    throw new Error('buildAuditEvent: accountId must be a string or null');
  }
  if (typeof ok !== 'boolean') {
    throw new Error('buildAuditEvent: ok must be a boolean');
  }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error('buildAuditEvent: detail must be a plain object');
  }
  if (at !== undefined && typeof at !== 'string') {
    throw new Error('buildAuditEvent: at must be an ISO timestamp string');
  }
  const cleanDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`buildAuditEvent: detail key "${key}" must never be recorded in the audit log`);
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      cleanDetail[key] =
        typeof value === 'string' && value.length > DETAIL_MAX_STRING
          ? value.slice(0, DETAIL_MAX_STRING - 1) + '…'
          : value;
    } else {
      throw new Error('buildAuditEvent: detail values must be flat (string, number, boolean or null)');
    }
  }
  return { at: at ?? new Date().toISOString(), action, accountId, ok, detail: cleanDetail };
}

/**
 * Append one event to a list, oldest-first, capped FIFO.
 * Never mutates the input. The oldest event drops off past `max`.
 * @param {Array} events existing events (oldest-first)
 * @param {object} event one built event
 * @param {number} max cap (default AUDIT_MAX_EVENTS)
 * @returns {Array} new list
 */
export function appendAuditEvent(events, event, max = AUDIT_MAX_EVENTS) {
  const next = [...(events ?? []), event];
  return next.slice(-Math.max(1, max));
}

/**
 * Record one event in Forge Storage (via the injected storage object).
 * Never throws — see the header comment.
 * @param {object} storage Forge Storage ({ get, set })
 * @param {object} event one built event
 */
export async function recordAuditEvent(storage, event) {
  try {
    const current = await storage.get(AUDIT_STORAGE_KEY);
    const list = Array.isArray(current) ? current : [];
    await storage.set(AUDIT_STORAGE_KEY, appendAuditEvent(list, event));
  } catch (e) {
    // Swallowed on purpose: the audit trail must never break the
    // operation it records.
  }
}

/**
 * Read the audit log, newest-first, capped at `limit`.
 * @param {object} storage Forge Storage ({ get })
 * @param {object} opts { limit? } (default AUDIT_MAX_EVENTS, clamped)
 * @returns {Promise<Array>} events, newest first (empty when none stored)
 */
export async function readAuditEvents(storage, { limit = AUDIT_MAX_EVENTS } = {}) {
  const current = await storage.get(AUDIT_STORAGE_KEY);
  if (!Array.isArray(current)) return [];
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, AUDIT_MAX_EVENTS) : AUDIT_MAX_EVENTS;
  return [...current].reverse().slice(0, n);
}
