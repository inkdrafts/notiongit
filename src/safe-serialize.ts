/**
 * The only sanctioned ways credentials-adjacent data becomes a string or a log
 * line.
 *
 * Invariants:
 * - Every string returned by serializeForLog is safe for platform logs:
 *   Secret instances render "[redacted]", keys matching the credential-key
 *   pattern redact regardless of value, depth and cycles are bounded, and an
 *   unserializable input degrades to a short safe string.
 * - reportError is the single console sink in src/. Nothing else in the
 *   codebase may call console.*; the canary suite fails if one appears on a
 *   route a journey drives.
 * - This module never inspects values to decide whether they are secret: the
 *   decision is structural (Secret type) or lexical (key name). It cannot be
 *   talked into printing a Secret.
 */

import { REDACTED, Secret } from './secret';

const CREDENTIAL_KEY = /token|secret|password|authorization|credential|private.?key/i;
const MAX_DEPTH = 8;

/**
 * Shared across one redactValue walk so a cycle is detected at any depth;
 * entries are removed on the way back out, so unrelated branches that
 * legitimately revisit an object are not misread as cycles.
 */
const inProgress = new WeakSet<object>();

/**
 * Deep-walk a value into a redacted plain-JSON structure.
 *
 * `Error` instances render as `{name, message, ...own enumerable fields}` so
 * error classes like `GithubAppAuthError {status}` and `NotionOAuthError
 * {code, status, details}` render usefully instead of `{}`.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value instanceof Secret) return REDACTED;
  if (value instanceof Error) {
    const rendered: Record<string, unknown> = { name: value.name, message: value.message };
    for (const [key, field] of Object.entries(value)) {
      rendered[key] = redactFieldValue(key, field, depth);
    }
    return rendered;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return '[truncated]';
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[truncated]';
    if (inProgress.has(value)) return '[circular]';
    inProgress.add(value);
    const rendered: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      rendered[key] = redactFieldValue(key, field, depth);
    }
    inProgress.delete(value);
    return rendered;
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') {
    try {
      return String(value);
    } catch {
      return REDACTED;
    }
  }
  if (typeof value === 'function') return '[function]';
  return value;
}

function redactFieldValue(key: string, field: unknown, depth: number): unknown {
  if (CREDENTIAL_KEY.test(key)) return REDACTED;
  return redactValue(field, depth + 1);
}

/** JSON.stringify(redactValue(value)), with a String() fallback; safe for logs. */
export function serializeForLog(value: unknown): string {
  const redacted = redactValue(value);
  try {
    const text = JSON.stringify(redacted);
    return text === undefined ? String(redacted) : text;
  } catch {
    return String(redacted);
  }
}

/** The only console sink in src/. */
export function reportError(context: string, error: unknown): void {
  console.error(`[notiongit] ${context}`, serializeForLog(error));
}
