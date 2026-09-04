/**
 * Post-install status surface.
 *
 * The worker keeps no durable account-to-site binding (the provisioning job
 * record expires and is never an input here), so a returning owner re-proves
 * ownership with a fresh GitHub OAuth authorization, every render re-derives
 * site truth from GitHub with an installation token minted on the spot, and
 * the only retained state is the short-lived signed session cookie in the
 * browser plus the per-account rerun window below.
 */

import { withKeyLock } from './provisioning-throttle';

/**
 * Fixed limits for the manual re-run. Plain constants rather than the
 * throttle's env-var pattern: the rerun shares the provisioning mutation
 * budget already, and these two numbers have no operator tuning story.
 */
export const STATUS_RERUN_SPACING_SECONDS = 300;
export const STATUS_RERUN_DAILY_LIMIT = 10;
export const STATUS_RERUN_WINDOW_SECONDS = 24 * 60 * 60;

export const STATUS_RERUN_KEY_PREFIX = 'status:rerun:';

/** Value of `status:rerun:<accountId>`. Numeric account id only — never a login or token. */
export interface StatusRerunWindow {
  version: 1;
  windowStartedAt: number;
  lastRerunAt: number;
  count: number;
}

export function statusRerunKey(accountId: number): string {
  return `${STATUS_RERUN_KEY_PREFIX}${accountId}`;
}

export type StatusRerunAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'spacing' | 'daily_cap' | 'unavailable'; retryAfterSeconds: number };

function validRerunWindow(value: unknown): value is StatusRerunWindow {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Number.isSafeInteger(record.windowStartedAt) &&
    Number.isSafeInteger(record.lastRerunAt) &&
    Number.isSafeInteger(record.count) &&
    (record.count as number) >= 0
  );
}

/**
 * Consume one slot in the account's rerun window, written BEFORE the caller
 * dispatches so a crash in between overcounts — the conservative direction,
 * the same budget pattern the provisioning throttle uses. The fixed window
 * admits `STATUS_RERUN_DAILY_LIMIT` reruns over `STATUS_RERUN_WINDOW_SECONDS`,
 * and two reruns must sit at least `STATUS_RERUN_SPACING_SECONDS` apart. A
 * corrupted or unreadable record fails closed: a missed manual re-run only
 * delays a sync, while admitting on one could defeat the cap.
 */
export async function admitStatusRerun(
  kv: KVNamespace,
  accountId: number,
  nowMs: number,
): Promise<StatusRerunAdmission> {
  const key = statusRerunKey(accountId);
  return withKeyLock(key, async (): Promise<StatusRerunAdmission> => {
    let stored: StatusRerunWindow | null | 'corrupted';
    try {
      const value: unknown = await kv.get(key, 'json');
      stored = value === null || validRerunWindow(value) ? (value as StatusRerunWindow | null) : 'corrupted';
    } catch {
      stored = 'corrupted';
    }
    if (stored === 'corrupted') {
      return { admitted: false, reason: 'unavailable', retryAfterSeconds: STATUS_RERUN_SPACING_SECONDS };
    }

    let windowStartedAt: number;
    let count: number;
    let lastRerunAt: number;
    if (stored === null || stored.windowStartedAt + STATUS_RERUN_WINDOW_SECONDS * 1000 <= nowMs) {
      windowStartedAt = nowMs;
      count = 0;
      lastRerunAt = 0;
    } else {
      windowStartedAt = stored.windowStartedAt;
      count = stored.count;
      lastRerunAt = stored.lastRerunAt;
    }
    const windowEndsAt = windowStartedAt + STATUS_RERUN_WINDOW_SECONDS * 1000;
    if (count >= STATUS_RERUN_DAILY_LIMIT) {
      return {
        admitted: false,
        reason: 'daily_cap',
        retryAfterSeconds: Math.max(Math.ceil((windowEndsAt - nowMs) / 1000), 1),
      };
    }
    if (nowMs < lastRerunAt + STATUS_RERUN_SPACING_SECONDS * 1000) {
      return {
        admitted: false,
        reason: 'spacing',
        retryAfterSeconds: Math.max(Math.ceil((lastRerunAt + STATUS_RERUN_SPACING_SECONDS * 1000 - nowMs) / 1000), 1),
      };
    }

    const updated: StatusRerunWindow = { version: 1, windowStartedAt, lastRerunAt: nowMs, count: count + 1 };
    await kv.put(key, JSON.stringify(updated), {
      expirationTtl: Math.max(Math.ceil((windowEndsAt - nowMs) / 1000), 60),
    });
    return { admitted: true };
  });
}
