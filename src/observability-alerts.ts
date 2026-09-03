import { PROVISIONING_STEP_ORDER, type ProvisioningStepName } from './provisioning-job';

export interface StepFailureWindow {
  step: ProvisioningStepName;
  succeeded: number;
  failed: number;
}

export interface AlertWindowSummary {
  windowMinutes: number;
  stepFailures: StepFailureWindow[];
  deadLetterCount: number;
  rateLimitedCount: number;
}

export interface AlertThresholds {
  minSampleSize: number;
  failureRateThreshold: number;
  deadLetterThreshold: number;
  rateLimitThreshold: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  minSampleSize: 5,
  failureRateThreshold: 0.2,
  deadLetterThreshold: 1,
  rateLimitThreshold: 10,
};

export type ObservabilityAlert =
  | {
      kind: 'step_failure_rate';
      step: ProvisioningStepName;
      failureRate: number;
      sampleSize: number;
      windowMinutes: number;
    }
  | { kind: 'dead_letter_spike'; count: number; windowMinutes: number }
  | { kind: 'rate_limit_spike'; count: number; windowMinutes: number };

export function evaluateObservabilityAlerts(
  summary: AlertWindowSummary,
  thresholds: AlertThresholds,
): ObservabilityAlert[] {
  const alerts: ObservabilityAlert[] = [];

  for (const step of PROVISIONING_STEP_ORDER) {
    const window = summary.stepFailures.find((candidate) => candidate.step === step);
    if (!window) continue;

    const sampleSize = window.succeeded + window.failed;
    if (sampleSize === 0 || sampleSize < thresholds.minSampleSize) continue;

    const failureRate = window.failed / sampleSize;
    if (failureRate < thresholds.failureRateThreshold) continue;

    alerts.push({
      kind: 'step_failure_rate',
      step,
      failureRate,
      sampleSize,
      windowMinutes: summary.windowMinutes,
    });
  }

  if (summary.deadLetterCount >= thresholds.deadLetterThreshold) {
    alerts.push({
      kind: 'dead_letter_spike',
      count: summary.deadLetterCount,
      windowMinutes: summary.windowMinutes,
    });
  }

  if (summary.rateLimitedCount >= thresholds.rateLimitThreshold) {
    alerts.push({
      kind: 'rate_limit_spike',
      count: summary.rateLimitedCount,
      windowMinutes: summary.windowMinutes,
    });
  }

  return alerts;
}

export interface AnalyticsEngineSqlRow {
  [column: string]: unknown;
}

/** Cloudflare's Analytics Engine SQL HTTP API response shape, written from its
 * docs and NOT yet verified against a live account, which is why every row is
 * re-parsed defensively below rather than trusted. */
export interface AnalyticsEngineSqlResponse {
  data: AnalyticsEngineSqlRow[];
}

function toStepName(value: unknown): ProvisioningStepName | null {
  return PROVISIONING_STEP_ORDER.find((step) => step === value) ?? null;
}

export function summarizeAlertWindow(
  rows: AnalyticsEngineSqlRow[],
  windowMinutes: number,
): AlertWindowSummary {
  const perStep = new Map<ProvisioningStepName, { succeeded: number; failed: number }>();
  let deadLetterCount = 0;
  let rateLimitedCount = 0;

  for (const row of rows) {
    if (typeof row.blob1 !== 'string') continue;
    if (typeof row.count !== 'number' || !Number.isFinite(row.count)) continue;

    const eventType = row.blob1;
    const count = row.count;

    if (eventType === 'step_succeeded' || eventType === 'step_failed') {
      const step = toStepName(row.blob3);
      if (!step) continue;

      const totals = perStep.get(step) ?? { succeeded: 0, failed: 0 };
      if (eventType === 'step_succeeded') totals.succeeded += count;
      else totals.failed += count;
      perStep.set(step, totals);
      continue;
    }

    if (eventType === 'job_dead_lettered') deadLetterCount += count;
    else if (eventType === 'rate_limited') rateLimitedCount += count;
  }

  const stepFailures = PROVISIONING_STEP_ORDER.flatMap((step) => {
    const totals = perStep.get(step);
    return totals ? [{ step, succeeded: totals.succeeded, failed: totals.failed }] : [];
  });

  return { windowMinutes, stepFailures, deadLetterCount, rateLimitedCount };
}

export interface AlertCheckEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CF_ANALYTICS_API_TOKEN: string;
  OBSERVABILITY_ALERT_WEBHOOK_URL: string;
}

const DEFAULT_ALERT_WINDOW_MINUTES = 60;
const ANALYTICS_DATASET = 'notiongit_provisioning_events';

function alertWindowQuery(windowMinutes: number): string {
  // Interpolated into SQL text, so it is reduced to a positive integer rather
  // than trusted as an arbitrary caller-supplied number.
  const minutes = Math.max(1, Math.floor(windowMinutes));
  return [
    `SELECT blob1, blob3, SUM(_sample_interval) AS count`,
    `FROM ${ANALYTICS_DATASET}`,
    `WHERE timestamp > NOW() - INTERVAL '${minutes}' MINUTE`,
    `GROUP BY blob1, blob3`,
  ].join(' ');
}

function isSqlResponse(value: unknown): value is AnalyticsEngineSqlResponse {
  return typeof value === 'object' && value !== null && Array.isArray((value as { data?: unknown }).data);
}

function alertMessage(alert: ObservabilityAlert): string {
  switch (alert.kind) {
    case 'step_failure_rate':
      return `Provisioning step ${alert.step} failed ${(alert.failureRate * 100).toFixed(1)}% of ${alert.sampleSize} attempts in the last ${alert.windowMinutes} minutes`;
    case 'dead_letter_spike':
      return `${alert.count} provisioning jobs were dead-lettered in the last ${alert.windowMinutes} minutes`;
    case 'rate_limit_spike':
      return `${alert.count} provider rate-limit responses in the last ${alert.windowMinutes} minutes`;
  }
}

export interface AlertCheckOptions {
  fetcher?: typeof fetch;
  /** Unread while the query uses a relative SQL `INTERVAL`. */
  now?: () => number;
  windowMinutes?: number;
  thresholds?: AlertThresholds;
}

export async function runObservabilityAlertCheck(
  env: Partial<AlertCheckEnv>,
  options: AlertCheckOptions = {},
): Promise<{ checked: boolean; alerts: ObservabilityAlert[] }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_ANALYTICS_API_TOKEN;
  const webhookUrl = env.OBSERVABILITY_ALERT_WEBHOOK_URL;
  if (!accountId || !token || !webhookUrl) return { checked: false, alerts: [] };

  const fetcher = options.fetcher ?? fetch;
  const windowMinutes = options.windowMinutes ?? DEFAULT_ALERT_WINDOW_MINUTES;

  let rows: AnalyticsEngineSqlRow[];
  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: new Headers({ Authorization: `Bearer ${token}` }),
        body: alertWindowQuery(windowMinutes),
      },
    );
    if (!response.ok) {
      console.log(JSON.stringify({ type: 'alert_query_failed' }));
      return { checked: false, alerts: [] };
    }
    const payload: unknown = await response.json();
    rows = isSqlResponse(payload) ? payload.data : [];
  } catch {
    console.log(JSON.stringify({ type: 'alert_query_failed' }));
    return { checked: false, alerts: [] };
  }

  const alerts = evaluateObservabilityAlerts(
    summarizeAlertWindow(rows, windowMinutes),
    options.thresholds ?? DEFAULT_ALERT_THRESHOLDS,
  );

  for (const alert of alerts) {
    try {
      const delivery = await fetcher(webhookUrl, {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...alert, message: alertMessage(alert) }),
      });
      if (!delivery.ok) {
        console.log(JSON.stringify({ type: 'alert_dispatch_failed', kind: alert.kind }));
      }
    } catch {
      console.log(JSON.stringify({ type: 'alert_dispatch_failed', kind: alert.kind }));
    }
  }

  return { checked: true, alerts };
}
