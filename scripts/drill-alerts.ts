/**
 * Alert-path drill from the launch checklist (docs/launch-checklist.md §C):
 * runs the shipped alert query against the live Analytics Engine SQL API,
 * rules on the response shape the Worker's parser assumes, evaluates the
 * alert thresholds, and delivers any resulting alerts to the webhook:
 *
 *   CLOUDFLARE_API_TOKEN=<token with Account Analytics read> \
 *   bun run scripts/drill-alerts.ts <DATASET_NAME> <WEBHOOK_URL> [options]
 *
 * Options:
 *   --window <minutes>            query window (default 60)
 *   --min-sample-size <n>         override the step-failure sample floor
 *   --failure-rate <fraction>     override the step-failure rate threshold
 *   --dead-letter-threshold <n>   override the dead-letter threshold
 *   --rate-limit-threshold <n>    override the rate-limit threshold
 *   --rows-file <path>            read a `{ "data": [...] }` JSON file
 *                                 instead of querying, to rehearse the
 *                                 evaluation and delivery half offline
 *
 * The query requires Analytics Engine to be enabled on the account and a
 * token with the Account Analytics read permission; the wrangler OAuth
 * token does not satisfy the SQL API. Setting any threshold to 0 fires a
 * synthetic alert on any window, which exercises delivery without waiting
 * for real failures. Exits nonzero when the shape check fails, the query
 * fails, or a delivery is not accepted.
 *
 * To put real rows into a dataset without waiting for traffic, write a job
 * record to the environment's JOBS namespace and send its message by hand;
 * wrangler has no send command, but the REST API accepts one:
 *
 *   POST /accounts/<account>/queues/<queue id>/messages  {"body":{"jobId":"..."}}
 *
 * The consumer runs the job's next step against the staging secrets and the
 * step's events land in the dataset. `wrangler queues purge <name>` clears
 * the leftovers.
 */

import {
  DATASET_NAME_PATTERN,
  DEFAULT_ALERT_THRESHOLDS,
  alertMessage,
  alertWindowQuery,
  evaluateObservabilityAlerts,
  summarizeAlertWindow,
  type AlertThresholds,
  type AnalyticsEngineSqlRow,
} from '../src/observability-alerts';

const positional = process.argv.slice(2);
function optionValue(flag: string): string | undefined {
  const index = positional.indexOf(flag);
  return index === -1 ? undefined : positional[index + 1];
}
function has(flag: string): boolean {
  return positional.includes(flag);
}

const DATASET = positional[0] ?? '';
const WEBHOOK_URL = positional[1] ?? '';
const ROWS_FILE = optionValue('--rows-file');
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

if (!DATASET || !WEBHOOK_URL || (ROWS_FILE === undefined && (!ACCOUNT_ID || !API_TOKEN))) {
  console.error('usage: CLOUDFLARE_API_TOKEN=... bun run scripts/drill-alerts.ts <DATASET_NAME> <WEBHOOK_URL> [--rows-file <path>] [threshold overrides]');
  process.exit(2);
}

const WINDOW_MINUTES = Number(optionValue('--window') ?? 60);
const THRESHOLDS: AlertThresholds = {
  minSampleSize: Number(optionValue('--min-sample-size') ?? DEFAULT_ALERT_THRESHOLDS.minSampleSize),
  failureRateThreshold: Number(optionValue('--failure-rate') ?? DEFAULT_ALERT_THRESHOLDS.failureRateThreshold),
  deadLetterThreshold: Number(optionValue('--dead-letter-threshold') ?? DEFAULT_ALERT_THRESHOLDS.deadLetterThreshold),
  rateLimitThreshold: Number(optionValue('--rate-limit-threshold') ?? DEFAULT_ALERT_THRESHOLDS.rateLimitThreshold),
};

/** Accepts a bare row array or the `{ data: [...] }` envelope the SQL API
 * documents; anything else fails the drill instead of masquerading as rows. */
function rowsFromSqlPayload(payload: unknown): AnalyticsEngineSqlRow[] | null {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: AnalyticsEngineSqlRow[] }).data;
  }
  return null;
}

async function loadRows(): Promise<AnalyticsEngineSqlRow[]> {
  let payload: unknown;
  if (ROWS_FILE !== undefined) {
    payload = JSON.parse(await Bun.file(ROWS_FILE).text());
  } else {
    if (!DATASET_NAME_PATTERN.test(DATASET)) {
      console.log(`FAIL\talert query\tdataset name ${JSON.stringify(DATASET)} does not match ${DATASET_NAME_PATTERN}`);
      process.exit(2);
    }
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: new Headers({ Authorization: `Bearer ${API_TOKEN}` }),
        body: alertWindowQuery(WINDOW_MINUTES, DATASET),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      console.log(`FAIL\talert query\tstatus ${response.status}: ${(await response.text()).slice(0, 200)}`);
      process.exit(1);
    }
    console.log('PASS\talert query\taccepted');
    payload = await response.json();
  }
  const rows = rowsFromSqlPayload(payload);
  if (rows === null) {
    console.log(`FAIL\trow shape\tno data array in ${JSON.stringify(payload).slice(0, 200)}`);
    process.exit(1);
  }
  return rows;
}

const rows = await loadRows();
console.log(`Raw rows (${rows.length}):\n${JSON.stringify(rows, null, 2)}`);

const shapeFindings: string[] = [];
for (const row of rows) {
  if (typeof row.blob1 !== 'string') shapeFindings.push(`row without a blob1 string: ${JSON.stringify(row)}`);
  if (typeof row.count !== 'number' || !Number.isFinite(row.count)) {
    shapeFindings.push(`count is ${JSON.stringify(row.count)}, not a finite JSON number — summarizeAlertWindow would drop this row silently`);
  }
}
console.log(shapeFindings.length === 0
  ? 'PASS\trow shape\tdata is an array of rows with blob1 strings and numeric counts'
  : `FAIL\trow shape\t${shapeFindings.join('; ')}`);

const summary = summarizeAlertWindow(rows, WINDOW_MINUTES);
console.log(`Window summary: ${JSON.stringify(summary)}`);

const alerts = evaluateObservabilityAlerts(summary, THRESHOLDS);
console.log(`Evaluated alerts at thresholds ${JSON.stringify(THRESHOLDS)}: ${JSON.stringify(alerts)}`);

let deliveriesAccepted = 0;
for (const alert of alerts) {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ...alert, message: alertMessage(alert) }),
    signal: AbortSignal.timeout(20_000),
  });
  const accepted = response.ok;
  if (accepted) deliveriesAccepted += 1;
  console.log(`${accepted ? 'PASS' : 'FAIL'}\twebhook delivery\t${alert.kind} answered ${response.status}`);
}

const shapeOk = shapeFindings.length === 0;
const allDelivered = deliveriesAccepted === alerts.length;
console.error(`\nshape ${shapeOk ? 'ok' : 'MISMATCH'}, ${deliveriesAccepted}/${alerts.length} alerts delivered`);
process.exit(shapeOk && allDelivered ? 0 : 1);
