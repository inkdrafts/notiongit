# ADR 0004: Two observability sinks over one event schema

- Status: Accepted
- Date: 2026-09-03
- Decision: Emit every provisioning funnel event twice from one typed schema —
  as a structured `console.log` line into Cloudflare Workers Logs for
  correlatable per-job search, and as one Analytics Engine data point into
  `notiongit_provisioning_events` for aggregate dashboards and threshold
  alerts. Ship the alert check wired and tested but leave its cron trigger
  commented out until the Analytics Engine SQL response shape is verified
  against a live dataset.

## Context

Issue #26 asks for two different things that read as one. "Define structured
log/event schemas keyed by random correlation/job IDs" and "measure per-step
latency/success/failure" describe per-job search: given a `jobId` from a user
report, reconstruct what happened. "Add dashboards/queries and alerts for
sustained per-step failure rate ... dead letters, and provider/rate-limit
anomalies" describes aggregation over a window, where individual jobs are
noise.

These have opposite cost curves on Cloudflare. Logs are cheap to write and
expensive to aggregate: answering "what is the failure rate of `verify_deploy`
this hour" from Workers Logs means scanning every line in the window, and the
window itself is at most 7 days. Analytics Engine is the reverse — a `GROUP BY`
over months of data is one query, but the columns are positional (`blob1`,
`double2`), the write is fire-and-forget, and it is the wrong tool for reading
one job's story.

The privacy constraint pushes the same way. Issue #26's implementation
constraints forbid logging tokens, codes, database IDs, repository contents,
Notion content, raw provider bodies, or unnecessary user identity. The funnel
already had a correlation ID that satisfies this for free: the `jobId` minted in
`beginNotionAuthorization` before any job record exists, random and
non-identifying, already used as the KV key and the queue message body. No
second identifier and no user identity was needed to correlate consent through
terminal job state.

## Decision

1. **One schema, two sinks.** `ProvisioningEvent` in `src/observability.ts` is a
   discriminated union of eleven variants. `emitProvisioningEvent` writes the
   JSON line and, when `PROVISIONING_METRICS` is bound, the data point. Callers
   emit one event and do not choose a sink. The schema is the contract both
   sinks read, which is what makes the column map in
   [`docs/observability.md`](../observability.md) a document about one thing
   rather than two.
2. **The Analytics Engine binding is optional everywhere it is threaded.**
   `ObservabilityEnv.PROVISIONING_METRICS` is `?`, and a `writeDataPoint` that
   throws is swallowed. Local development, every existing test's fake env, and
   an account whose dataset has not been created yet all still emit the log
   line. A metrics sink must never fail the operation it observes.
3. **Redaction is a typecheck, not a convention.**
   `OBSERVABILITY_EVENT_FIELDS` lists every field name the union may use, and
   `AllowlistedEventFields` fails `bun run typecheck` when a variant grows a
   field the list does not contain. Adding a free-text field is therefore a
   deliberate act with a compiler error in front of it, rather than something a
   later contributor does by habit. The `redaction canary` tests in
   `test/observability.test.ts` are the runtime half: they push a token-bearing
   `Error` through the real emission path and assert it reaches neither sink.
4. **Alerts aggregate; they never identify.** `summarizeAlertWindow` folds SQL
   rows keyed on `blob1` and `blob3` and deliberately never selects `blob2`, the
   `jobId`. An alert payload is a step name, a closed `kind`, and counts. The
   cost is a triage step: an operator who gets an alert must search Workers Logs
   to find which jobs are failing. That step is documented, and it is the right
   trade — a webhook is the least trustworthy destination in this system.
5. **The alert cron trigger stays commented out.** See below.

## Rejected approaches

- **An external APM or session-replay product.** Issue #26 puts third-party
  session replay and marketing attribution requiring personal tracking
  explicitly out of scope, and the product's premise is that a non-developer's
  content and credentials do not leave their own accounts. Shipping a
  third-party agent that sees request context would contradict the privacy
  claim this feature exists to make verifiable, and would add a vendor to a
  system whose entire runtime is one Worker.
- **Logpush only, with no aggregation layer.** Logpush to R2 or an external sink
  preserves the events for longer than Workers Logs' 7 days, and needs no second
  schema. But it moves the aggregation problem rather than solving it: someone
  still has to build and run queries over stored JSON to get a per-step failure
  rate, which means another store, another query engine, and another place the
  events live. Analytics Engine gives the same aggregate for the cost of a
  binding. Logpush remains available later for long-term archival, and it reads
  the same `console.log` lines with no code change.
- **Ad-hoc counters in KV.** Tempting because KV is already bound. It fails on
  the same limitation the queue already works around: Workers KV has no
  compare-and-swap, so concurrent consumer invocations incrementing a counter
  lose writes. It would also add durable state with no TTL story to a project
  where every record expires in 24 hours, and it would make a metrics write able
  to fail a provisioning step. `writeDataPoint` is fire-and-forget by design.

## The deliberate scope cut

`AnalyticsEngineSqlResponse` in `src/observability-alerts.ts` is written from
Cloudflare's documented SQL API shape and has not been checked against a live
account. Cloudflare's SQL API page documents the endpoint, the bearer auth, and
that the query text goes in the POST body, but does not state the JSON response
schema; the `FORMAT` clause also offers `JSON`, `JSONEachRow`, and
`TabSeparated`, any of which would parse differently.

Three options were on the table.

Omitting the alerting handler entirely would have left issue #26's alerting
requirement unmet and pushed the whole design decision to a later session that
would face the same unverified response shape with less context.

Guessing — shipping the handler with the cron trigger enabled — is worse than it
looks. `summarizeAlertWindow` drops rows it cannot interpret rather than
throwing, which is right for a live alert check but means a wrong response shape
produces "no alerts" indistinguishable from "nothing is wrong". An alerting
system that fails closed and silently is worse than no alerting system, because
someone will trust it.

So: ship it wired, tested, and uninvoked. `evaluateObservabilityAlerts` is pure
and fully unit-tested, so every threshold rule is proven without a network. The
`scheduled` handler in `index.ts` calls `runObservabilityAlertCheck`, which
returns `{ checked: false }` when the credentials are absent. `wrangler.toml`'s
`[triggers]` block is commented out with the reason inline. Turning alerting on
is then a two-line config change plus two secrets, made by someone who has run
the query against a real dataset and seen the response — not a guess baked into
the merge.

## Consequences and required follow-up

- **Confirm both datasets appear after the first real deploy.** Cloudflare
  creates an Analytics Engine dataset automatically on the first write once the
  binding is declared, so `notiongit_provisioning_events` and
  `notiongit_staging_provisioning_events` need no manual creation. Until traffic
  writes to them they hold nothing, which is a working state, not a broken one:
  the log sink carries every event regardless.
- **Set the two alert secrets** once the datasets exist and the response shape is
  verified: `wrangler secret put CF_ANALYTICS_API_TOKEN` and
  `wrangler secret put OBSERVABILITY_ALERT_WEBHOOK_URL`, per environment. The
  analytics token needs Account Analytics read permission only; it is not a
  deploy token. `CLOUDFLARE_ACCOUNT_ID` is already a non-secret `[vars]` entry.
- **Fix the hardcoded dataset name before enabling staging alerts.**
  `ANALYTICS_DATASET` in `src/observability-alerts.ts` is a module constant set
  to the production dataset, so a staging alert check would query production.
  The `PROVISIONING_METRICS` binding is correctly per-environment; only the alert
  query is not.
- **Verify the SQL response shape, then uncomment `[triggers]`.** Pay particular
  attention to whether `SUM(_sample_interval) AS count` returns a JSON number or
  a string: `summarizeAlertWindow` requires `typeof row.count === 'number'` and
  drops the row otherwise.
- **Per-job forensics has the shortest retention window.** Workers Logs keeps 3
  days on the Free plan and 7 on Paid; Analytics Engine keeps three months; the
  job record in KV keeps 24 hours. A user report older than a week can be
  answered from aggregates and from `blob2`, but not from the full log line. The
  account's plan tier is not recorded in this repository, so confirm it before
  publishing a retention figure in a privacy claim.
- **Queue backlog and age are not measured by this application**, because a
  Worker cannot see the depth of the queue behind it. Cloudflare's own Queues
  dashboard and the `queuesBacklogAdaptiveGroups` GraphQL dataset are the source
  for that, and Cloudflare has no Queues notification type to subscribe to, so
  alerting on backlog would mean polling. That is a follow-up, not part of this
  issue.

## References

- [`docs/observability.md`](../observability.md)
- [Workers Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/)
- [issue #26 — Observability](https://github.com/inkdrafts/notiongit/issues/26)
