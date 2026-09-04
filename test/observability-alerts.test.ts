import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateObservabilityAlerts,
  runObservabilityAlertCheck,
  summarizeAlertWindow,
  type AlertCheckEnv,
  type AlertWindowSummary,
  type AnalyticsEngineSqlRow,
} from '../src/observability-alerts';

const ENV: AlertCheckEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CF_ANALYTICS_API_TOKEN: 'analytics-token',
  OBSERVABILITY_ALERT_WEBHOOK_URL: 'https://hooks.example.com/observability',
  PROVISIONING_METRICS_DATASET: 'notiongit_provisioning_events',
};

const SQL_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`;

function summary(overrides: Partial<AlertWindowSummary> = {}): AlertWindowSummary {
  return {
    windowMinutes: 60,
    stepFailures: [],
    deadLetterCount: 0,
    rateLimitedCount: 0,
    ...overrides,
  };
}

function sqlResponse(rows: AnalyticsEngineSqlRow[]): Response {
  return new Response(JSON.stringify({ data: rows }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('evaluateObservabilityAlerts', () => {
  test('stays quiet below the failure-rate threshold', () => {
    const alerts = evaluateObservabilityAlerts(
      summary({ stepFailures: [{ step: 'await_sync', succeeded: 9, failed: 1 }] }),
      DEFAULT_ALERT_THRESHOLDS,
    );

    expect(alerts).toEqual([]);
  });

  test('fires exactly at the failure-rate threshold', () => {
    const alerts = evaluateObservabilityAlerts(
      summary({ stepFailures: [{ step: 'await_sync', succeeded: 8, failed: 2 }] }),
      DEFAULT_ALERT_THRESHOLDS,
    );

    expect(alerts).toEqual([
      { kind: 'step_failure_rate', step: 'await_sync', failureRate: 0.2, sampleSize: 10, windowMinutes: 60 },
    ]);
  });

  test('fires above the failure-rate threshold', () => {
    const alerts = evaluateObservabilityAlerts(
      summary({ stepFailures: [{ step: 'await_sync', succeeded: 5, failed: 5 }] }),
      DEFAULT_ALERT_THRESHOLDS,
    );

    expect(alerts).toEqual([
      { kind: 'step_failure_rate', step: 'await_sync', failureRate: 0.5, sampleSize: 10, windowMinutes: 60 },
    ]);
  });

  test('never fires on a sample smaller than minSampleSize, even at a 100% failure rate', () => {
    const alerts = evaluateObservabilityAlerts(
      summary({ stepFailures: [{ step: 'verify_deploy', succeeded: 0, failed: 4 }] }),
      DEFAULT_ALERT_THRESHOLDS,
    );

    expect(alerts).toEqual([]);
  });

  test('never fires on an empty sample', () => {
    const alerts = evaluateObservabilityAlerts(
      summary({ stepFailures: [{ step: 'verify_deploy', succeeded: 0, failed: 0 }] }),
      { ...DEFAULT_ALERT_THRESHOLDS, minSampleSize: 0 },
    );

    expect(alerts).toEqual([]);
  });

  test('stays quiet below the dead-letter threshold and fires at and above it', () => {
    const quiet = evaluateObservabilityAlerts(summary({ deadLetterCount: 0 }), DEFAULT_ALERT_THRESHOLDS);
    const atThreshold = evaluateObservabilityAlerts(summary({ deadLetterCount: 1 }), DEFAULT_ALERT_THRESHOLDS);
    const above = evaluateObservabilityAlerts(summary({ deadLetterCount: 6 }), DEFAULT_ALERT_THRESHOLDS);

    expect(quiet).toEqual([]);
    expect(atThreshold).toEqual([{ kind: 'dead_letter_spike', count: 1, windowMinutes: 60 }]);
    expect(above).toEqual([{ kind: 'dead_letter_spike', count: 6, windowMinutes: 60 }]);
  });

  test('stays quiet below the rate-limit threshold and fires at and above it', () => {
    const quiet = evaluateObservabilityAlerts(summary({ rateLimitedCount: 9 }), DEFAULT_ALERT_THRESHOLDS);
    const atThreshold = evaluateObservabilityAlerts(summary({ rateLimitedCount: 10 }), DEFAULT_ALERT_THRESHOLDS);
    const above = evaluateObservabilityAlerts(summary({ rateLimitedCount: 41 }), DEFAULT_ALERT_THRESHOLDS);

    expect(quiet).toEqual([]);
    expect(atThreshold).toEqual([{ kind: 'rate_limit_spike', count: 10, windowMinutes: 60 }]);
    expect(above).toEqual([{ kind: 'rate_limit_spike', count: 41, windowMinutes: 60 }]);
  });

  test('orders simultaneous alerts by step order, then dead-letter, then rate-limit', () => {
    const alerts = evaluateObservabilityAlerts(
      summary({
        stepFailures: [
          { step: 'await_sync', succeeded: 0, failed: 5 },
          { step: 'verify_repository', succeeded: 1, failed: 9 },
        ],
        deadLetterCount: 2,
        rateLimitedCount: 20,
      }),
      DEFAULT_ALERT_THRESHOLDS,
    );

    expect(alerts).toEqual([
      { kind: 'step_failure_rate', step: 'verify_repository', failureRate: 0.9, sampleSize: 10, windowMinutes: 60 },
      { kind: 'step_failure_rate', step: 'await_sync', failureRate: 1, sampleSize: 5, windowMinutes: 60 },
      { kind: 'dead_letter_spike', count: 2, windowMinutes: 60 },
      { kind: 'rate_limit_spike', count: 20, windowMinutes: 60 },
    ]);
  });
});

describe('summarizeAlertWindow', () => {
  test('folds well-formed rows into per-step, dead-letter, and rate-limit totals', () => {
    const result = summarizeAlertWindow(
      [
        { blob1: 'step_succeeded', blob2: 'job-1', blob3: 'verify_repository', count: 8 },
        { blob1: 'step_failed', blob2: 'job-2', blob3: 'verify_repository', count: 2 },
        { blob1: 'step_failed', blob2: 'job-3', blob3: 'await_sync', count: 3 },
        { blob1: 'job_dead_lettered', blob2: 'job-3', blob3: 'await_sync', count: 4 },
        { blob1: 'rate_limited', blob2: 'job-4', blob3: 'patch_config', count: 11 },
        { blob1: 'job_succeeded', blob2: 'job-5', count: 7 },
      ],
      30,
    );

    expect(result).toEqual({
      windowMinutes: 30,
      stepFailures: [
        { step: 'verify_repository', succeeded: 8, failed: 2 },
        { step: 'await_sync', succeeded: 0, failed: 3 },
      ],
      deadLetterCount: 4,
      rateLimitedCount: 11,
    });
  });

  test('drops uninterpretable rows instead of throwing', () => {
    const result = summarizeAlertWindow(
      [
        { blob2: 'job-1', blob3: 'verify_repository', count: 5 },
        { blob1: 42, blob2: 'job-2', blob3: 'verify_repository', count: 5 },
        { blob1: 'step_failed', blob2: 'job-3', blob3: 'verify_repository', count: '5' },
        { blob1: 'step_failed', blob2: 'job-4', blob3: 'not_a_real_step', count: 5 },
        { blob1: 'step_failed', blob2: 'job-5', blob3: 'verify_repository', count: 1 },
      ],
      60,
    );

    expect(result).toEqual({
      windowMinutes: 60,
      stepFailures: [{ step: 'verify_repository', succeeded: 0, failed: 1 }],
      deadLetterCount: 0,
      rateLimitedCount: 0,
    });
  });
});

describe('runObservabilityAlertCheck', () => {
  for (const missing of Object.keys(ENV) as (keyof AlertCheckEnv)[]) {
    test(`reports no check and issues no request when ${missing} is absent`, async () => {
      const calls: string[] = [];
      const env = { ...ENV, [missing]: '' };

      const result = await runObservabilityAlertCheck(env, {
        fetcher: async (input, init) => {
          calls.push(new Request(input, init).url);
          return sqlResponse([]);
        },
      });

      expect(result).toEqual({ checked: false, alerts: [] });
      expect(calls).toEqual([]);
    });
  }

  test('posts a webhook alert for a window that trips a threshold', async () => {
    const webhookRequests: Request[] = [];
    let sqlBody = '';

    const result = await runObservabilityAlertCheck(ENV, {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.url === SQL_ENDPOINT) {
          expect(request.method).toBe('POST');
          expect(request.headers.get('authorization')).toBe(`Bearer ${ENV.CF_ANALYTICS_API_TOKEN}`);
          sqlBody = await request.text();
          return sqlResponse([
            { blob1: 'step_failed', blob2: 'job-1', blob3: 'verify_repository', count: 5 },
          ]);
        }
        webhookRequests.push(request);
        return new Response(null, { status: 204 });
      },
    });

    expect(result.checked).toBe(true);
    expect(sqlBody).toBe(
      "SELECT blob1, blob3, SUM(_sample_interval) AS count FROM notiongit_provisioning_events"
      + " WHERE timestamp > NOW() - INTERVAL '60' MINUTE GROUP BY blob1, blob3",
    );
    expect(sqlBody).not.toContain('blob2');
    expect(result.alerts).toEqual([
      { kind: 'step_failure_rate', step: 'verify_repository', failureRate: 1, sampleSize: 5, windowMinutes: 60 },
    ]);
    expect(webhookRequests).toHaveLength(1);
    expect(webhookRequests[0].url).toBe(ENV.OBSERVABILITY_ALERT_WEBHOOK_URL);
    expect(webhookRequests[0].method).toBe('POST');
    expect(await webhookRequests[0].json()).toEqual({
      kind: 'step_failure_rate',
      step: 'verify_repository',
      failureRate: 1,
      sampleSize: 5,
      windowMinutes: 60,
      message: 'Provisioning step verify_repository failed 100.0% of 5 attempts in the last 60 minutes',
    });
  });

  test('delivers the remaining alerts when one webhook post rejects', async () => {
    const delivered: unknown[] = [];

    const result = await runObservabilityAlertCheck(ENV, {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.url === SQL_ENDPOINT) {
          return sqlResponse([
            { blob1: 'step_failed', blob2: 'job-1', blob3: 'verify_repository', count: 5 },
            { blob1: 'job_dead_lettered', blob2: 'job-1', blob3: 'verify_repository', count: 3 },
          ]);
        }
        const body = await request.json();
        if ((body as { kind: string }).kind === 'step_failure_rate') throw new Error('webhook unreachable');
        delivered.push(body);
        return new Response(null, { status: 204 });
      },
    });

    expect(result.checked).toBe(true);
    expect(result.alerts).toHaveLength(2);
    expect(delivered).toEqual([
      {
        kind: 'dead_letter_spike',
        count: 3,
        windowMinutes: 60,
        message: '3 provisioning jobs were dead-lettered in the last 60 minutes',
      },
    ]);
  });

  test('reports no check when the metrics query returns a non-ok response', async () => {
    const calls: string[] = [];

    const result = await runObservabilityAlertCheck(ENV, {
      fetcher: async (input, init) => {
        calls.push(new Request(input, init).url);
        return new Response('', { status: 500 });
      },
    });

    expect(result).toEqual({ checked: false, alerts: [] });
    expect(calls).toEqual([SQL_ENDPOINT]);
  });
});
