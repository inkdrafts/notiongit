# Observability

The provisioning funnel emits one event stream to two sinks. `src/observability.ts`
defines the events; `emitProvisioningEvent` writes each one as a structured
`console.log` line (which Cloudflare Workers Logs ingests with no binding) and,
when the optional `PROVISIONING_METRICS` binding is present, as one Analytics
Engine data point. The log line answers "what happened to this job"; the dataset
answers "how is the funnel doing" without scanning logs. See
[`docs/decisions/0004-observability.md`](decisions/0004-observability.md) for why
there are two sinks rather than one.

Every event is correlated by `jobId` — the random, non-identifying token minted in
`beginNotionAuthorization` (`notion-oauth.ts`) before any job record exists, and
already used as the KV key, the queue message body, and the `202` response field.
Nothing else identifies the user. Correlation therefore costs no user identity and
no second identifier.

`status_rerun_dispatched` is the one exception: `POST /status/rerun` has no
durable job to key on, so it carries a `requestLabel` field instead of
`jobId` — the same per-request random label `statusRerun` already mints for
the admission audit (see `docs/security-data-flow.md` §3), not a
`ProvisioningJob` id. It never correlates across requests and never links to
an account.

## Event schema

`src/observability.ts` is the schema. Read it there rather than here: the field
list is a discriminated union, and `OBSERVABILITY_EVENT_FIELDS` makes adding a
field to any variant fail `bun run typecheck` unless the field name is added to
the allowlist too. That is the mechanism that keeps a free-text field — an
`Error.message`, a provider body, a Notion or GitHub identifier — from being added
by habit.

Twelve event types:

| Event | Emitted when |
| --- | --- |
| `consent_started` | `GET /connect/notion` redirects the user to Notion's authorization screen. |
| `consent_completed` | The Notion callback exchanged its code and resolved the template. |
| `consent_failed` | The Notion callback failed, with a closed `NotionOAuthErrorCode`. |
| `job_queued` | The GitHub callback persisted a `ProvisioningJob` and enqueued `{ jobId }`. |
| `job_enqueue_failed` | That enqueue threw; the job record is already `dead_letter`. |
| `step_started` | The queue consumer booked one step attempt, before minting its installation token. |
| `step_succeeded` | A step's result was durably written to KV. Never paired with a failure for the same attempt. |
| `step_failed` | One step attempt failed, with its classified code and whether the failure is retryable and terminal. |
| `rate_limited` | The same failure carried a `Retry-After`. Emitted **in addition to** `step_failed`, never instead of it. |
| `job_succeeded` | Every step succeeded. |
| `job_dead_lettered` | A step failure was terminal, either unretryable or the fifth attempt. |
| `status_rerun_dispatched` | `POST /status/rerun` dispatched the sync workflow. See "Manual sync re-runs" below. |

`job_succeeded` doubles as the first-successful-deploy metric: `verify_deploy` is
the last entry in `PROVISIONING_STEP_ORDER`, and it only succeeds once the public
Pages URL answers, so a job reaching `job_succeeded` has by construction served
the user's site at least once. There is no separate deploy event to reconcile
against.

There is no job-expiry event. A job that neither succeeds nor dead-letters within
`PROVISIONING_JOB_TTL_SECONDS` (24 hours) is removed by KV's own TTL with nothing
emitted, so expiry is visible only as a `jobId` whose event stream stops
mid-funnel. The query for that is under "Incident triage" below.

### Manual sync re-runs

`status_rerun_dispatched` is emitted once, after `statusRerun` dispatches the
sync workflow, so a count of this event over a window answers "how many manual
re-runs happened, and when." A refused attempt (IP burst, a paused or
kill-switched admission stage, or the per-account spacing and daily-cap window
in `admitStatusRerun`) emits no funnel event. The admission-audit KV rows
(`docs/security-data-flow.md` §3) already carry every refusal with its reason;
an Analytics Engine event is worth the added surface only if an operator would
act on an aggregate refusal count, and none of these refusal reasons are an
anomaly rather than the throttle working as designed — an operator who pauses
the stage already knows it is paused, and a spacing or daily-cap refusal is a
user hitting their own quota, not a funnel problem. This mirrors the decision
already made for alert thresholds: refusals are not wired into
`observability-alerts.ts` either.

```sql
SELECT
    toStartOfHour(timestamp) AS hour,
    SUM(_sample_interval) AS manual_reruns
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'status_rerun_dispatched'
GROUP BY hour
ORDER BY hour
```

## Analytics Engine column map

`blob1` is always the event type and `blob2` always the `jobId`. `blob3` is the
event's primary dimension, so one `GROUP BY blob1, blob3` aggregates any event by
the thing that distinguishes it. `blob4` is the error code where `blob3` is a step
name, and the provider where `blob3` is an error code. `index1` is the event type,
and `double1` is always the emitter's own `ts` in epoch milliseconds — distinct
from the platform's `timestamp` column, which records ingest time and is what
every query below filters on.

| Event | blob3 | blob4 | double2 | double3 | double4 | double5 |
| --- | --- | --- | --- | --- | --- | --- |
| `consent_started` | `provider` | | | | | |
| `consent_completed` | `provider` | | `templateDuplicated` (1/0) | | | |
| `consent_failed` | `errorCode` | `provider` | | | | |
| `job_queued` | | | | | | |
| `job_enqueue_failed` | `errorCode` | | | | | |
| `step_started` | `step` | | `attempt` | | | |
| `step_succeeded` | `step` | | `attempt` | `durationMs` | | |
| `step_failed` | `step` | `errorCode` | `attempt` | `durationMs` | `retryable` (1/0) | `terminal` (1/0) |
| `rate_limited` | `step` | `errorCode` | `retryAfterSeconds` | | | |
| `job_succeeded` | | | `totalDurationMs` | | | |
| `job_dead_lettered` | `step` | `errorCode` | `totalDurationMs` | | | |
| `status_rerun_dispatched` | | | | | | |

`eventDataPoint` in `src/observability.ts` is the authority for this table, and
`test/observability.test.ts` asserts the exact blob and double arrays for all
twelve variants, so a column that moves breaks a test rather than a dashboard.
`blob2` for `status_rerun_dispatched` is the per-request label described above,
not a `ProvisioningJob` id — see "Every event is correlated by `jobId`" above.

## Dashboard queries

Run these against `notiongit_provisioning_events` from the Analytics Engine SQL
API (`POST
https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`,
`Authorization: Bearer <token>`, query text as the request body) or from the
dashboard's query builder. Substitute `notiongit_staging_provisioning_events` for
staging. Every count is `SUM(_sample_interval)` rather than `COUNT()` — see
"Sampling" below.

### Per-step failure rate

```sql
SELECT
    blob3 AS step,
    sumIf(_sample_interval, blob1 = 'step_succeeded') AS succeeded,
    sumIf(_sample_interval, blob1 = 'step_failed') AS failed,
    sumIf(_sample_interval, blob1 = 'step_failed') / SUM(_sample_interval) AS failure_rate
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '60' MINUTE
    AND blob1 IN ('step_succeeded', 'step_failed')
GROUP BY step
HAVING SUM(_sample_interval) >= 5
ORDER BY failure_rate DESC
```

The `HAVING` clause is the dashboard equivalent of `minSampleSize`: without it a
step with one attempt and one failure reads as 100%. To see which error codes
drive a step's rate, add `blob4 AS error_code` to the `SELECT` and `GROUP BY`, and
drop the `step_succeeded` half of the filter.

Step latency uses the same rows:

```sql
SELECT
    blob3 AS step,
    quantileWeighted(0.5)(double3, _sample_interval) AS p50_ms,
    quantileWeighted(0.95)(double3, _sample_interval) AS p95_ms
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob1 = 'step_succeeded'
GROUP BY step
```

### Dead letters

```sql
SELECT
    blob3 AS step,
    blob4 AS error_code,
    SUM(_sample_interval) AS dead_lettered,
    quantileWeighted(0.5)(double2, _sample_interval) AS p50_total_ms
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob1 = 'job_dead_lettered'
GROUP BY step, error_code
ORDER BY dead_lettered DESC
```

One dead letter is one user whose site was never provisioned, so the alert
threshold for this is 1. Pair it with the funnel's two ends to see the rate rather
than the count:

```sql
SELECT
    blob1 AS event,
    SUM(_sample_interval) AS count
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '24' HOUR
    AND blob1 IN ('consent_started', 'consent_completed', 'job_queued', 'job_succeeded', 'job_dead_lettered')
GROUP BY event
```

The gap between `job_queued` and `job_succeeded` plus `job_dead_lettered` is the
set of jobs still in flight or expired unnoticed.

### Provider and rate-limit anomalies

```sql
SELECT
    blob3 AS step,
    blob4 AS error_code,
    SUM(_sample_interval) AS hits,
    quantileWeighted(0.95)(double2, _sample_interval) AS p95_retry_after_seconds
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '60' MINUTE AND blob1 = 'rate_limited'
GROUP BY step, error_code
ORDER BY hits DESC
```

`error_code` separates the providers: `notion_*` codes come from the Notion side
of the funnel, `github_*` codes from GitHub. Consent-side provider failures are a
separate query, because they happen before any step exists:

```sql
SELECT
    blob3 AS error_code,
    SUM(_sample_interval) AS failures
FROM notiongit_provisioning_events
WHERE timestamp > NOW() - INTERVAL '60' MINUTE AND blob1 = 'consent_failed'
GROUP BY error_code
ORDER BY failures DESC
```

Remember that `rate_limited` accompanies a `step_failed` rather than replacing it,
so the two queries count the same underlying attempt. A spike in both is one
event, not two.

### Queue backlog and age

**The application cannot measure this and does not try.** A Worker sees the
message it is handed, not the depth of the queue behind it or the age of the
oldest message waiting in it. Any backlog number this application emitted would be
a guess, so there is no app-side backlog metric and no `notiongit_provisioning_events`
query for one.

Use Cloudflare's own Queues metrics for `notiongit-provisioning` instead. Backlog
size in messages and in bytes, consumer concurrency, and message lag are on the
queue's page in the Cloudflare dashboard and in the GraphQL Analytics API dataset
`queuesBacklogAdaptiveGroups` (field `messages` for average backlog depth). The
realtime backlog, including `oldest_message_timestamp_ms`, comes from
`GET /accounts/{account_id}/queues/{queue_id}/metrics`.

Cloudflare's Notifications product has no Queues notification type as of
2026-09-03 (checked against the available-notifications list), so there is nothing
to subscribe to for a backlog threshold. Alerting on backlog therefore means
polling one of the two APIs above on a schedule. That is not built here and is not
in issue #26's scope; the application-side signal for a stuck funnel is a rising
`step_started` count with no matching `step_succeeded` or `step_failed`, which the
per-step query above already shows.

## Retention

Three retention windows apply, and they are all different.

- **Job records in KV: 24 hours.** `PROVISIONING_JOB_TTL_SECONDS` in
  `provisioning-job.ts` is `24 * 60 * 60`, and every record this project writes
  uses the same `expirationTtl`. After that, the durable record of what a job did
  is gone, and only the two observability sinks remain.
- **Analytics Engine: three months.** Cloudflare's Analytics Engine limits page
  states "Data written to Workers Analytics Engine is stored for three months"
  (verified 2026-09-03).
- **Workers Logs: 3 days on the Free plan, 7 days on the Paid plan.** Cloudflare's
  Workers Logs page gives both figures and a maximum retention of 7 days (verified
  2026-09-03). Which one applies depends on the account's plan, and this repository
  does not record which plan the `notiongit` account is on. Confirm it before
  relying on the longer figure — see "Manual verification follow-up".

The practical consequence is that per-job forensics has the shortest window of the
three. A user report older than a week can be answered from aggregates and from
`blob2`, but the full structured log line for that job is gone.

## Sampling

This application applies none. `emitProvisioningEvent` writes one data point per
event with no sampling, no batching, and no dropping, so at this project's volume
the dataset is a complete record of the funnel.

Analytics Engine samples on its own at high write volume. The documented reason
`_sample_interval` exists is that a stored row can represent several original rows,
and Cloudflare's guidance is to use `SUM(_sample_interval)` in place of `COUNT()`
so aggregates reflect the unsampled data. Every query in this document does that,
and so does the alert check: `alertWindowQuery` in `src/observability-alerts.ts`
selects `SUM(_sample_interval) AS count`. A dashboard that reverts to `COUNT()`
will silently under-report the moment sampling engages.

## Access

Both sinks are Cloudflare account resources, so reading them requires access to
the Cloudflare account that owns the Worker
(`58fbcc5baba3339f96fe72fe81f5ee6f`, see
[`Environments and secrets`](architecture.md#environments-and-secrets)). That is
the same trust boundary as the GitHub App private key and the Notion and GitHub
client secrets, which are Cloudflare secrets on the same account. Anyone who can
read the dataset or the logs can already read those.

Querying the dataset from outside the dashboard needs an API token with Account
Analytics read permission. `CF_ANALYTICS_API_TOKEN` is exactly that token, stored
as a Cloudflare secret; it is not a deploy token and should not be given write
scopes.

There is no wider access tier, because there is nothing to widen to: the events
carry no user identity, no repository name, no Notion identifier, and no token, so
a "redacted view" for a broader audience would be identical to the raw data.

## Incident triage

Start with a `jobId`. If a user reported the problem, the `jobId` is in the `202`
response their browser received and in the URL of the onboarding flow.

If an **alert** started the incident, you do not have one. The webhook payload
deliberately carries no `jobId` (see `runObservabilityAlertCheck`), so an alert
tells you *which step is failing and how often*, never *whose job*. Step 1 turns
the alert into a set of `jobId` values; steps 2 onward are the same either way.

1. **Get the job IDs.** In the Cloudflare dashboard, open Workers Logs for
   `notiongit` and filter on the structured fields the log lines already carry:
   `type = "step_failed"` and `step = "<step from the alert>"` over the alert's
   window. Each matching line carries its `jobId`. For a live incident,
   `wrangler tail notiongit --format json --search step_failed` streams the same
   lines. The Analytics Engine dataset cannot do this step: `blob2` holds the
   `jobId`, but the alert path never selects it, and querying it back out is only
   worth doing once the log window has expired (see below).
2. **Reconstruct one job's funnel.** Filter Workers Logs on
   `jobId = "<jobId>"`, sorted oldest first. You get the whole stream in order:
   `consent_started`, `consent_completed`, `job_queued`, then a
   `step_started`/`step_succeeded` pair per step, and either `job_succeeded` or a
   run of `step_failed` attempts ending in `job_dead_lettered`. Read the last
   `step_failed`: its `errorCode`, `attempt`, `retryable`, and `terminal` fields
   say what failed and whether the queue gave up or the classifier did.
3. **Check for a rate limit.** A `rate_limited` line immediately after a
   `step_failed` means the provider asked for a delay, and `retryAfterSeconds` is
   what it asked for. Its absence means the failure was not throttling.
4. **Read the durable record**, if the job is under 24 hours old:

   ```sh
   wrangler kv key get "github:onboarding-job:<jobId>" --binding JOBS --remote --text
   ```

   Add `--env staging` for staging. The record carries per-step `attempts`,
   `lastError`, the sync run id and URL, and the deploy commit and build id. It is
   the only place the repository name appears; the event stream never carries it.
5. **If the log window has expired**, fall back to the dataset, which keeps three
   months:

   ```sql
   SELECT timestamp, blob1 AS event, blob3, blob4, double2, double3
   FROM notiongit_provisioning_events
   WHERE blob2 = '<jobId>' AND timestamp > NOW() - INTERVAL '90' DAY
   ORDER BY timestamp
   ```

   This gives the same sequence with codes and durations, but without the field
   names. Use the column map above to read it.
6. **Decide whether the job stalled or died.** A stream ending at `step_started`
   with no matching `step_succeeded` or `step_failed` is a job whose consumer
   invocation never returned, which the queue's own `max_retries` and dead-letter
   queue handle. A stream ending at `job_dead_lettered` is a job the application
   gave up on deliberately. A stream that just stops after a `step_succeeded` and
   never resumes is the enqueue-failure case described in
   [`Durable provisioning job queue`](architecture.md#durable-provisioning-job-queue);
   re-send `{ jobId }` to `notiongit-provisioning` to re-drive it.

## Redaction tests

The `redaction canary` block in `test/observability.test.ts` is the enforcement,
not this paragraph. Two of its three tests plant the canary string
`ghs_CANARY1234567890abcdef` inside an `Error.message`, drive a real provisioning
attempt through `processProvisioningMessage` with a KV write that rejects with
that error, and assert the canary appears in none of the log lines, none of the
Analytics Engine data points, and not in the persisted `ProvisioningJob` record.
The third asserts that every field name on every emitted event comes from the
`OBSERVABILITY_EVENT_FIELDS` allowlist.

What this proves: the production path that hands an arbitrary caught error to
`classifyProvisioningError` reduces it to a closed code before anything is
emitted, for both a classified provider error (`github_sync_rate_limited`, which
also emits `rate_limited`) and a completely unclassified `Error` (which becomes
`provisioning_step_failed` and dead-letters). It proves this by running the real
emission path, not by inspecting a hand-built event.

What it does not prove. It exercises one error-carrying path, the KV write
failure; a future code path that formats an error into a *new* event field would
need its own canary. It says nothing about the Notion consent half of the funnel,
which is covered by type constraints only. And it cannot prove the general claim
"no secret ever reaches a sink" — that claim rests on the union's field types plus
the `AllowlistedEventFields` typecheck, and the canary tests are the runtime check
that the typecheck is not being routed around.

## Alert thresholds

`DEFAULT_ALERT_THRESHOLDS` in `src/observability-alerts.ts`:

| Threshold | Value | Fires when |
| --- | --- | --- |
| `minSampleSize` | 5 | A step is skipped entirely below this many attempts in the window. |
| `failureRateThreshold` | 0.2 | `failed / (succeeded + failed)` reaches 20% for a step at or above the sample size. |
| `deadLetterThreshold` | 1 | Any `job_dead_lettered` event in the window. |
| `rateLimitThreshold` | 10 | Ten or more `rate_limited` events in the window. |

The window defaults to 60 minutes. Alerts come back in a fixed order — step alerts
in `PROVISIONING_STEP_ORDER`, then dead-letter, then rate-limit — so the same
window always produces the same sequence.

Each alert is POSTed to `OBSERVABILITY_ALERT_WEBHOOK_URL` as its own JSON request,
the alert object plus a rendered `message`:

```json
{
  "kind": "step_failure_rate",
  "step": "verify_deploy",
  "failureRate": 0.5,
  "sampleSize": 8,
  "windowMinutes": 60,
  "message": "Provisioning step verify_deploy failed 50.0% of 8 attempts in the last 60 minutes"
}
```

```json
{ "kind": "dead_letter_spike", "count": 3, "windowMinutes": 60,
  "message": "3 provisioning jobs were dead-lettered in the last 60 minutes" }
```

```json
{ "kind": "rate_limit_spike", "count": 14, "windowMinutes": 60,
  "message": "14 provider rate-limit responses in the last 60 minutes" }
```

No payload carries a `jobId`, a token, or a provider response body — that is why
triage step 1 above exists.

The check is inert until both `CF_ANALYTICS_API_TOKEN` and
`OBSERVABILITY_ALERT_WEBHOOK_URL` are set as Cloudflare secrets;
`runObservabilityAlertCheck` returns `{ checked: false }` when either is missing,
without querying anything. `CLOUDFLARE_ACCOUNT_ID` is already a non-secret `[vars]`
entry in `wrangler.toml`. To enable alerting:

```sh
wrangler secret put CF_ANALYTICS_API_TOKEN --env staging
wrangler secret put OBSERVABILITY_ALERT_WEBHOOK_URL --env staging
```

The `[triggers]` block in `wrangler.toml` is deliberately commented out, so even
with both secrets set nothing invokes the `scheduled` handler. Uncomment it only
after the verification below.

## Manual verification follow-up

Three things are unverified. None of them blocks the event sinks, which are
covered by tests; all of them block turning the cron trigger on.

1. **The Analytics Engine SQL response row shape has not been checked against a
   live account.** `AnalyticsEngineSqlResponse` in `src/observability-alerts.ts`
   assumes `{ data: [...] }`, and Cloudflare's SQL API page documents the endpoint,
   the auth header, and the request body without stating the response schema. The
   `FORMAT` clause offers `JSON`, `JSONEachRow`, and `TabSeparated`, which is
   another way the shape could differ from the assumption. `summarizeAlertWindow`
   is written defensively — an uninterpretable row is dropped, not thrown on — so a
   wrong assumption fails silently as "no alerts" rather than loudly. Verify by
   writing a few data points, running `alertWindowQuery`'s SQL by hand, and
   comparing the response to the interface. Check specifically whether
   `count` comes back as a JSON number or a string: `summarizeAlertWindow` requires
   `typeof row.count === 'number'` and drops the row otherwise, which is the most
   likely way this silently returns zero alerts.
2. **Neither dataset has received a data point yet.** Cloudflare creates an
   Analytics Engine dataset automatically the first time a Worker writes to it
   after the binding is declared ("Get started", verified 2026-09-03), so nothing
   needs creating by hand — but until a deploy carrying this code serves real
   traffic, every query above returns nothing. Confirm both datasets are queryable
   after the first such deploy.
3. **The account's Workers Logs plan tier is not recorded**, so the retention
   figure above is either 3 or 7 days. Check the plan on the Cloudflare account
   before writing 7 days into any user-facing privacy claim.

`ANALYTICS_DATASET` is no longer hardcoded: `runObservabilityAlertCheck` reads
the dataset name from `PROVISIONING_METRICS_DATASET`, a non-secret `[vars]`
entry set per environment in `wrangler.toml` (`notiongit_provisioning_events`
in production, `notiongit_staging_provisioning_events` in staging), so a
staging alert check can no longer query production data.

## References

- [Workers Analytics Engine: get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [Workers Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Analytics Engine SQL reference: statements](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/)
- [Analytics Engine SQL reference: aggregate functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/)
- [Available Cloudflare notifications](https://developers.cloudflare.com/notifications/notification-available/)
- [issue #26 — Observability](https://github.com/inkdrafts/notiongit/issues/26)
