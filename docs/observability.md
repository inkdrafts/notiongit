# Observability

The provisioning funnel emits one event stream. `src/observability.ts` defines
the events; `emitProvisioningEvent` writes each one as a structured `console.log`
line, which Cloudflare Workers Logs ingests with no binding and no paid plan. The
log line answers "what happened to this job". Workers Logs and Traces are pinned
in `wrangler.toml`'s `[observability]` block, so a deploy can never silently
turn them off. There is no second sink: the
Analytics Engine dataset and its alert check were removed on 2026-09-05 so the
project runs entirely on the Cloudflare free tier — the design lives in
[`docs/decisions/0004-observability.md`](decisions/0004-observability.md) and in
git history if the funnel ever needs aggregates or proactive alerts again.

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

`job_succeeded` doubles as the first-successful-deploy signal: `verify_deploy` is
the last entry in `PROVISIONING_STEP_ORDER`, and it only succeeds once the public
Pages URL answers, so a job reaching `job_succeeded` has by construction served
the user's site at least once. There is no separate deploy event to reconcile
against.

There is no job-expiry event. A job that neither succeeds nor dead-letters within
`PROVISIONING_JOB_TTL_SECONDS` (24 hours) is removed by KV's own TTL with nothing
emitted, so expiry is visible only as a `jobId` whose event stream stops
mid-funnel.

### Manual sync re-runs

`status_rerun_dispatched` is emitted once, after `statusRerun` dispatches the
sync workflow, so a count of this event over a window answers "how many manual
re-runs happened, and when." A refused attempt (IP burst, a paused or
kill-switched admission stage, or the per-account spacing and daily-cap window
in `admitStatusRerun`) emits no funnel event. The admission-audit KV rows
(`docs/security-data-flow.md` §3) carry every refusal with its reason: a
refusal is the throttle working as designed, not a funnel anomaly, and an
operator who pauses a stage already knows it is paused.

## Retention

Three retention windows apply, and they are all different.

- **Job records in KV: 24 hours.** `PROVISIONING_JOB_TTL_SECONDS` in
  `provisioning-job.ts` is `24 * 60 * 60`, and every record this project writes
  uses the same `expirationTtl`. After that, the durable record of what a job did
  is gone, and only the log line remains.
- **Admission audit records in KV: 7 days.** `PROVISIONING_AUDIT_TTL_SECONDS`
  (default `7 * 24 * 60 * 60`) covers every admission refusal the kill switch,
  burst limiter, and account limiter write.
- **Workers Logs: 3 days.** Cloudflare's Workers Logs page gives 3 days on the
  Free plan and 7 on the Paid plan (verified 2026-09-03). The free figure is the
  one in force, and it is what the policy pages claim.

The practical consequence is that per-job forensics has the shortest window.
A user report older than three days can no longer be answered from the full
structured log line; the dead-letter queue count and the KV job record within
its 24 hours are what remain.

## Incident triage

Start with a `jobId`. If a user reported the problem, the `jobId` is in the `202`
response their browser received and in the URL of the onboarding flow.

1. **Reconstruct one job's funnel.** In the Cloudflare dashboard, filter Workers
   Logs for `notiongit` on `jobId = "<jobId>"`, sorted oldest first. You get the
   whole stream in order: `consent_started`, `consent_completed`, `job_queued`,
   then a `step_started`/`step_succeeded` pair per step, and either
   `job_succeeded` or a run of `step_failed` attempts ending in
   `job_dead_lettered`. Read the last `step_failed`: its `errorCode`, `attempt`,
   `retryable`, and `terminal` fields say what failed and whether the queue gave
   up or the classifier did. For a live incident,
   `wrangler tail notiongit --format pretty --search <jobId>` streams the same
   lines.
2. **Check for a rate limit.** A `rate_limited` line immediately after a
   `step_failed` means the provider asked for a delay, and `retryAfterSeconds` is
   what it asked for. Its absence means the failure was not throttling.
3. **Read the durable record**, if the job is under 24 hours old:

   ```sh
   wrangler kv key get "github:onboarding-job:<jobId>" --binding JOBS --remote --text
   ```

   Add `--env staging` for staging. The record carries per-step `attempts`,
   `lastError`, the sync run id and URL, and the deploy commit and build id. It is
   the only place the repository name appears; the event stream never carries it.
4. **Judging severity from counts.** The Queues dashboard shows the
   `notiongit-provisioning-dlq` backlog; a non-zero depth means jobs the
   application gave up on, one user per message. Workers Logs filtered on
   `type = "step_failed"` over the last 24 hours gives the failure rate per step
   for the same period.

A stream ending at `job_dead_lettered` is a job the application gave up on
deliberately. A stream that just stops after a `step_succeeded` and never resumes
is the enqueue-failure case described in
[`Durable provisioning job queue`](architecture.md#durable-provisioning-job-queue);
re-send `{ jobId }` to `notiongit-provisioning` to re-drive it.

## Redaction tests

The `redaction canary` block in `test/observability.test.ts` is the enforcement,
not this paragraph. Two of its three tests plant the canary string
`ghs_CANARY1234567890abcdef` inside an `Error.message`, drive a real provisioning
attempt through `processProvisioningMessage` with a KV write that rejects with
that error, and assert the canary appears in none of the log lines and not in the
persisted `ProvisioningJob` record. The third asserts that every field name on
every emitted event comes from the `OBSERVABILITY_EVENT_FIELDS` allowlist.

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
