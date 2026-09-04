# Architecture

The Worker is deliberately a thin foundation. HTTP handlers translate requests
into application operations; provider clients (`repository-naming.ts`,
`repository-generation.ts`, `repository-config.ts`, `github-pages.ts`,
`notion-sync.ts`, `site-deployment.ts`, `github-app-auth.ts`,
`notion-template.ts`) contain GitHub and Notion API code; the durable job
queue (`provisioning-job.ts`, `provisioning-steps.ts`,
`provisioning-queue.ts` — see "Durable provisioning job queue" below) makes
provisioning resumable and idempotent; storage owns the KV records these
modules read and write; and the UI will contain browser-facing HTML and
assets. These boundaries keep provider details out of routing and keep secrets
server-only. The credential inventory, retention table, and their enforcement
are documented in [`security-data-flow.md`](security-data-flow.md) (ADR 0004).

## Environments and secrets

`wrangler.toml` has separate `staging` and `production` KV and Queue bindings.
Both are created and deployed (2026-09-01) under Cloudflare account
`58fbcc5baba3339f96fe72fe81f5ee6f` (account ID is non-secret configuration,
like the App ID below; never commit an API token), workers.dev subdomain
`notiongit`:

| Environment | Worker name | URL |
| --- | --- | --- |
| staging | `notiongit-staging` | `https://notiongit-staging.notiongit.workers.dev` |
| production | `notiongit` | `https://notiongit.notiongit.workers.dev` |

Each has served `GET /healthz` successfully. Local development uses
Wrangler's local binding emulators instead of these live resources.

The manual Deploy GitHub Action workflow additionally needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, which
are **not yet set** — set them with `gh secret set` (never paste the token
into a commit, issue, or chat) before relying on that workflow; deploying
locally with an authenticated `wrangler` CLI, as done here, does not need
them.

Set secrets with Wrangler; values are never committed or placed in browser code:

```sh
wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging
wrangler secret put GITHUB_CLIENT_ID --env staging
wrangler secret put GITHUB_CLIENT_SECRET --env staging
wrangler secret put NOTION_CLIENT_ID --env staging
wrangler secret put NOTION_CLIENT_SECRET --env staging
```

Repeat for `production`. `.dev.vars.example` contains placeholders only; copy it
to `.dev.vars` for local work if a future handler needs the names.

The GitHub App registration, permission matrix, callback URLs, non-secret App
identity variables, and rotation procedure are maintained in the
[`GitHub App runbook`](github-app-runbook.md). `GITHUB_APP_ID` and
`GITHUB_APP_SLUG` are configuration values; the App private key and OAuth
client secret remain Cloudflare secrets.

The Notion public connection settings, template schema, API-version pin, and
credential rotation procedure are maintained in the
[`Notion integration runbook`](notion-integration-runbook.md) and its
[`sanitized template build sheet`](notion-template.md).

## Notion authorization continuation

Notion authorization is the second half of onboarding: `GET /connect/notion`
only starts for a `jobId` that `/auth/github/callback` already created a
`ProvisioningJob` for, and answers `409 provisioning_job_missing` otherwise, so
an old bookmark cannot walk a user through consent for a job with no repository
to configure. GitHub-first ordering, and writing the Notion secrets from this
second authorization rather than the queue, is
[ADR 0005](decisions/0005-notion-secret-handoff.md).

`GET /connect/notion` creates a ten-minute HMAC-signed state containing only a
job reference and nonce. The nonce is replay-tracked in `JOBS` and copied into
an HttpOnly, Secure, SameSite cookie so a callback from a different browser
flow is rejected. `GET /auth/notion/callback` validates and consumes that state
before exchanging Notion's one-time code at `/v1/oauth/token`, using the
environment-derived callback URL and the pinned `Notion-Version: 2022-06-28`
header.

The exchange result is handed directly to the request-local onboarding
continuation as `{ jobId, accessToken, duplicatedTemplateId }`. The access and
refresh tokens, workspace metadata, OAuth code, and duplicated-root ID are not
written to KV, queue messages, cookies, logs, or browser responses. The
production continuation (`continueNotionOnboarding` in `index.ts`) spends the
token immediately: `resolveNotionTemplateDatabases`
(`notion-template.ts`) walks the duplicated root — paginated block children,
descending into sub-pages within an explicit depth/fetch budget — and matches
each `child_database` (whose block id is the database id) against the Pages
and Posts schema fingerprints (required property names and types per the
pinned `Notion-Version: 2022-06-28`, never titles). Because a fresh duplicate
can briefly serve empty or partial content, propagation-shaped outcomes are
retried with bounded backoff inside the request, honoring Notion's
`Retry-After`; a fetched database whose schema matches no fingerprint (or
more than one) fails fast and distinct — `notion_template_database_missing`
vs `notion_template_database_ambiguous`, plus separate codes for a
non-duplicated authorization, an unreadable or empty root, and exhausted
 transient retries. The continuation then validates the complete sync-engine
 contract: required properties and types, required select values, and the
 types of optional fields when present. Missing properties, wrong types, and
 unsupported options are returned per database with remediation that names the
 correct Notion database. Only a successful validation is persisted in the
 resolution record (`notion:template-resolution:<job id>`, same 24-hour TTL as
 every other record): normalized Pages/Posts database IDs plus each database's
 non-secret schema summary (property types and select/multi-select option
 names). No token, page title, or row content ever reaches it.

The continuation then spends the token a second time, in the same request: it
mints an installation token from the job's `installationId` and writes
`NOTION_TOKEN`, `NOTION_PAGES_DATABASE_ID`, and `NOTION_POSTS_DATABASE_ID` into
the generated repository's Actions secrets (`actions-secrets.ts`). This is the
only place the Notion token exists, so it is the only place those secrets can
be written. The databases are resolved fresh on every authorization rather than
read back from the resolution record: re-authorizing duplicates the template
again, so a stored resolution can name databases the user is no longer writing
in. Only once all three secrets are durably written does the job get a
`notionSecretsWrittenAt` timestamp (a timestamp, never the values) and reach
`PROVISIONING_QUEUE`. A secret write that fails partway leaves the job
`awaiting_notion` with that field still null; the OAuth code is single-use, so
recovery is a fresh `/connect/notion?job_id=...` authorization, which re-runs
the whole write. A queue handoff that fails after the secrets are written also
leaves the job `awaiting_notion` and answers `502 provisioning_handoff_failed`
with a retry URL — re-authorizing then skips straight back to the handoff
instead of rewriting anything.

The HTTP response contains the job ID, whether template duplication occurred,
and the non-secret repository and site URLs; failures return their distinct
error code with non-secret details (missing roles, scanned count, or schema
validation issues).

## Durable provisioning job queue

Provisioning spans several third-party API calls over 60–120 seconds and can
partially succeed, so it does not run to completion inside one HTTP request.
`GET /auth/github/callback` (`finishGithubCallback` in `index.ts`) only runs
the part that structurally cannot be replayed later: verifying the signed
OAuth state, exchanging the single-use `code` for a short-lived user access
token, resolving identity, and generating (or reusing) the destination
repository — GitHub requires user-to-server authentication for
generate-from-template, so this step needs the OAuth token in memory and
cannot be deferred. Once generation succeeds, the callback persists a
`ProvisioningJob` record (`provisioning-job.ts`) with status `awaiting_notion`
and redirects the browser to `/connect/notion?job_id=...` — the OAuth token and
code are already out of scope by the time the response is written and are never
queued or stored. The queue is not told about the job here. The Notion callback
enqueues it, and only after writing the repository's three Actions secrets (see
"Notion authorization continuation" above), so no step can run against a
repository whose sync workflow would find no credentials. A job that a user
abandons between the two authorizations simply expires with its record's TTL.

Everything after generation — verifying the generated repository is
readable, patching `_config.yml`, enabling Pages, dispatching and awaiting
the Notion sync, and awaiting the resulting deploy — runs as seven ordered,
independently retriable steps (`PROVISIONING_STEP_ORDER` in
`provisioning-job.ts`; handlers in `provisioning-steps.ts`), driven by the
queue consumer in `provisioning-queue.ts`. None of these steps need the
OAuth token: each mints its own installation token from the job's durable,
non-secret `installationId` (`github-app-auth.ts`) and discards it when the
step returns, so no token of any kind is ever part of durable state — the
architecture never needed to trade that away to make the OAuth-to-queue
handoff work.

A queue message carries only `{ jobId }`; the `ProvisioningJob` record in KV
is the sole source of truth for progress. Each consumer invocation acquires
a short-lived per-job lock, advances exactly one pending step, persists the
result, and either enqueues a continuation message (steps remain), asks the
queue to redeliver the same message after a backoff (a retryable step
failure, a lock another attempt still holds, a record not yet visible
through KV's eventual consistency — a message can be delivered before the
write that preceded its enqueue has propagated — or a step that succeeded
and was durably saved but whose continuation then failed to enqueue, in
which case the saved success is left untouched and a retryable
`provisioning_enqueue_failed` breadcrumb is written onto the step now
waiting, so a record whose message has stalled never reads as healthy; the
breadcrumb clears as soon as that step is next booked, and a stalled record
can be re-driven by re-sending its `{ jobId }`), or acks (the job just
reached a terminal status). A KV write failure while persisting a step's
result is the one outcome that *does* count as a step failure: the success
was never durable, so the standard failure path releases the lock and the
step re-runs. Because progress lives in the record rather than the
message, a redelivered, duplicated, or out-of-order message is always safe:
a step already marked `succeeded` is skipped, and a job already `succeeded`,
`failed`, or `dead_letter` is acked without touching a provider. Six of the
seven steps are simple idempotent GETs or already-reconciling writes; the
one exception, dispatching the Notion sync workflow, persists a
before-dispatch marker (the excluded run-id snapshot and dispatch time) so
a crash — or a failed attempt — between the dispatch call and recording its
correlated run resumes by correlating that same window instead of starting
a second workflow run. Step failures re-read the record before persisting
the failure precisely so a marker a step wrote mid-attempt is never wiped
by the failure bookkeeping.

A step failure is classified (`classifyProvisioningError`) from the same
error taxonomy each provider module already exposes: retryable failures
(rate limits, timeouts, transient 5xxs) revert the step to `pending` and the
queue asks for redelivery after an exponential backoff (30s, 60s, ... capped
at 15 minutes, or the provider's own `Retry-After` when present); anything
else — or a retryable failure that has recurred
`PROVISIONING_STEP_MAX_ATTEMPTS` times — marks the step `failed` and the job
`dead_letter`, and the message is acked immediately rather than left to
exhaust Cloudflare's own retry budget. `wrangler.toml`'s
`max_retries`/`dead_letter_queue` on the queue consumer exist as the
platform's own backstop for a consumer that throws unexpectedly (a bug, a
KV outage) or a message whose job record never materializes within the
retry budget — the application's own per-job dead-lettering is the primary
mechanism and is what a future progress UI or ops tooling should read
(the progress projection in `progress.ts` is exactly that reader today:
`GET /progress` and `GET /progress/status` project the job record into
browser-safe stage states and taxonomy copy, and the record is never
mutated by a read). The
consumer batch stays at one message: steps such as `await_sync` poll
provider APIs inline for minutes, so a larger sequential batch could exceed
the consumer's wall-clock limit and force redelivery of every message in it.

Workers KV has no compare-and-swap, so the per-job lock cannot give perfect
mutual exclusion: two consumer invocations that read the job at the same
instant can both observe no lock and both proceed. Closing that race
completely would need a Durable Object, which this queue's expected
throughput does not justify; the accepted fallback is that six of the seven
steps are idempotent (see above), so the rare double acquisition wastes a
redundant step execution rather than corrupting job state or double-mutating
GitHub. The sync dispatch's marker is a narrower guarantee than that: it
makes a *sequential*
crash-then-retry safe (see above), but does not by itself prevent two
invocations that are genuinely in flight at the same instant from both
reading the marker unset and both dispatching — closing that specific case
needs the same compare-and-swap the lock lacks. This is called out as a
known, accepted limitation rather than a silent one; a Durable-Object-backed
lock is the natural follow-up if genuine concurrent redelivery of the same
job is ever observed in practice. Every `ProvisioningJob`
record — including the sync dispatch marker, the only durable state
adjacent to an in-flight operation — is written with the same
`expirationTtl` used everywhere else in this project (24 hours), so expired
jobs and their transient state are removed on KV's own schedule rather than
needing a separate sweep.

## Provisioning throttle and per-account quota

All provisioning mutations — everything that creates or changes content on
GitHub — pass through two gates owned by `provisioning-throttle.ts`, guarding
GitHub's app-wide secondary rate limits (~80 mutations per minute, ~500 per
hour) with the existing `JOBS` KV namespace and no Durable Object.

**What gates where.** The synchronous onboarding callback gates twice: at
its very start, as soon as the authenticated account id exists and before
any further token spend (`acquireProvisioningStart`), and once per real
generate POST via `generateOrReuseRepository`'s `beforeCreate` hook, which
consumes the global budget immediately before each POST fires
(`consumeGlobalMutationBudget`). The queue consumer gates every step before
minting its installation token (`gateProvisioningStep`): every pass renews
the account lease — so a job that spends minutes inside one inline poll
never outlives its lease — but only the content-creating steps
`patch_config`, `configure_pages`, and `dispatch_sync` consume global
budget. Reads and polls (`verify_repository`, `await_sync`,
`await_deploy_build`, `verify_deploy`) are free. Reuse never spends budget:
a callback that adopts an existing repository fires no generate POST, and
re-running an idempotent step that turns out to need no change still paid
only its gate check.

**The lease is the per-account quota.** `github:account-lease:<account id>`
names the one job allowed to provision for a GitHub account while it lives
(`leaseTtlSeconds`, renewed at every queue step, released the moment the job
reaches a terminal status). Capacity one is the honest quota for this
product: every attempt converges on the same reuse-biased destination
repository, so admitting spaced-out concurrent provisionings for one account
would buy nothing except duplicate GitHub work — and the lease doubles as
the anti-replay quota, turning a replayed or duplicated callback into a 409
`github_provisioning_already_active` instead of a second round of mutations.
A wedged job (one that stopped renewing) recovers through the TTL alone: the
next *sync-path* contender finds the lease expired — or live but naming a
job record that is missing or terminal — and breaks it. A queue-side job
that finds a foreign live lease is instead superseded: it terminal-fails
with `github_provisioning_superseded` and never steals the lease.

**Global budget semantics.** `github:rate:global` holds both fixed-window
counters (minute and hour) in one key, written only by
`consumeGlobalMutationBudget`, and only for real content-creating calls —
the sync generate and the three queue mutations. The increment is written
before the external call fires, so a crash in between over-counts, the
conservative direction; there is no decrement or refund path anywhere. The
read-modify-write is serialized per key inside an isolate by a promise-chain
mutex, which makes admission exact within one isolate — and deterministic
in the tests. Across isolates KV is eventually consistent: each racing
isolate can commit at most one admission per window that the others never
saw, so the honest worst case is `budget + 32 − 1` per window at 32 racing
isolates. The defaults (30/240) stay under GitHub's ceilings even at that
bound (61/min, 271/hour); the ceilings exist so misconfiguration cannot do
worse. A counter that arrives unparseable fails closed — refusing a
mutation that might have been admitted only delays provisioning, and the
state's two-hour TTL bounds the outage.

**Operator variables** (wrangler `[vars]`, all environments; a
present-but-invalid value — non-integer, NaN, ≤ 0 — fails the deploy's
config parse by throwing, valid values are clamped):

| Variable | Default | Clamp | Meaning |
| --- | --- | --- | --- |
| `PROVISIONING_MUTATIONS_PER_MINUTE` | `30` | ≤ 60 | Global content-creating mutations per fixed minute window |
| `PROVISIONING_MUTATIONS_PER_HOUR` | `240` | ≤ 400 | Global content-creating mutations per fixed hour window |
| `PROVISIONING_LEASE_TTL_SECONDS` | `1800` | 60–86400 | Per-account lockout bound; also how long a wedged job blocks its account |
| `PROVISIONING_CONTROL_MODE` | `active` | `active`, `pause`, or `kill` | Process-wide admission mode; the KV control record can make the mode stricter at the next fresh KV read |
| `PROVISIONING_PAUSED_STAGES` | empty | Known admission stages | Pauses listed stages and lets queued jobs resume after the control is cleared |
| `PROVISIONING_REJECTED_STAGES` | empty | Known admission stages | Rejects new work at listed stages; existing queue work remains paused until the control is cleared |
| `PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_SECONDS` | `86400` | 60–2592000 | TTL for the per-account attempt record |
| `PROVISIONING_ACCOUNT_ATTEMPT_LIMIT` | `3` | 1–10000 | Identified account attempts allowed in the window |
| `PROVISIONING_REQUEST_BURST_WINDOW_SECONDS` | `60` | 60–3600 | TTL for the HMAC-keyed request burst record |
| `PROVISIONING_REQUEST_BURST_LIMIT` | `10` | 1–10000 | Requests allowed per privacy-preserving network-prefix bucket |
| `PROVISIONING_DENIED_IDENTITY_COOLDOWN_SECONDS` | `3600` | 60–2592000 | TTL for an identity denied by GitHub or marked suspended |
| `PROVISIONING_ADMISSION_AUDIT_TTL_SECONDS` | `604800` | 60–2592000 | TTL for admission decision records |

Admission control details, activation commands, rollback, and incident steps are in [`docs/provisioning-admission-runbook.md`](provisioning-admission-runbook.md).

Admission records use the same Workers KV consistency model as the existing
throttle. Promise-chain locks serialize read-modify-write operations within one
Worker isolate. KV propagation can delay a control update or allow bounded
over-admission across isolates, so operators use the kill switch before
investigating provider traffic and keep the existing mutation headroom. A
control record with `expiresAt: null` is deliberate operator configuration; all
per-request, per-account, denial, callback, and audit records have finite TTLs.

**Wait/resume guarantee.** A refused gate pass is free: no token minted, no
provider call, no attempt consumed, no lock held. The job is persisted
`queued` or `paused` and unlocked with a wait breadcrumb (`reason:
'global_throttled'` or a stage-pause reason, plus times — never identity or
error text), and the continuation is handed to a *fresh* queue message
carrying `delaySeconds` — the next window boundary plus margin for budget
waits, jittered, floored at 1s. A fresh
message is a new delivery, so waiting can never exhaust the consumer's
`max_retries = 6` platform budget and dead-letter a healthy job; the same
transport carries a step failure that arrives with GitHub's own
`Retry-After`, at the provider's own pacing (± 5% jitter), under its own
much larger ceiling (`PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS` = 24) so that
honoring GitHub's pacing cannot dead-letter the job through the regular
five-attempt ceiling. The breadcrumb clears the moment the step next books
and on every terminal save, so a record never shows a stall that has ended.
`test/provisioning-load.test.ts` drives the synthetic version of this
end-to-end: several accounts × several jobs through both gates over a
budget far smaller than the workload, asserting every job reaches a
terminal status, every window's observed mutations stay within the
configured budgets, every wait or redelivery carries a delay of at least
one second, and nothing dead-letters with a throttle code.

## GitHub Pages provisioning

The `configure_pages` queue step calls the Pages API with `build_type:
legacy` and `source: { branch: main, path: / }`. A `409` is treated as an
idempotent existing-site result: the current site is inspected and updated
only when its source or explicit build type is incompatible. Provider 404,
validation, permission, and rate-limit failures are surfaced as distinct
step errors; network and 5xx failures use a bounded retry inside the step
before the queue's own retry ever needs to redeliver the message. KV stores
only Pages status, URLs, and the desired source metadata.

## Notion sync dispatch and deploy verification

The `dispatch_sync` step dispatches the generated repository's own
`sync-notion.yml` workflow (`allow_bulk_delete: false`) with a freshly
minted installation token. `workflow_dispatch` never returns a run id, so
the run is correlated the standard way: the workflow's run ids are
snapshotted immediately before dispatch, and the first `workflow_dispatch`
run created afterward with an id outside that snapshot is adopted (see
"Durable provisioning job queue" above for how a crash mid-dispatch resumes
without a duplicate run). The following `await_sync` step polls that run
until GitHub reports it `completed`; a conclusion that is not `success` is a
distinct step error (`github_sync_run_failed`) — the run's own
machine-readable summary output is never read, since step outputs are not
retrievable outside the run itself and could carry Notion content.

Once the sync run completes, `await_deploy_build` reads the repository's
`main` HEAD (unchanged if the sync was a no-op) and polls `GET
.../pages/builds/latest` until it reports a terminal status for that exact
commit — never a stale build in flight for an older one. A matching
`errored` build is `github_deploy_build_failed`; a build that never reaches
a terminal, matching state within the bounded backoff is
`github_deploy_timeout`. Only once the build is `built` does the final
`verify_deploy` step fetch the public Pages URL directly; a build finishing
does not guarantee the CDN in front of it already serves the new content, so
a URL that keeps failing after bounded retries is reported as its own
outcome, `github_deploy_url_unreachable`, distinct from a build failure. The
job reaches `status: "succeeded"` only after the public URL answers, and its
record carries the non-secret run id, run URL, conclusion, commit sha,
build id, and build status. The progress projection reads the job record,
never the reverse: a `GET /progress` read is read-only by construction.

## Observability

Every stage of the funnel — consent, enqueue, each step attempt, and the
terminal job outcome — emits one typed event (`observability.ts`) correlated by
the same random `jobId` that already keys the KV record and the queue message,
so no second identifier and no user identity is needed to follow a job from
consent to first deploy. Each event goes to two sinks: a structured
`console.log` line, which Workers Logs ingests with no binding and which
answers "what happened to this job", and the optional `PROVISIONING_METRICS`
Analytics Engine dataset, which answers "how is the funnel doing" without
scanning logs. Every event field is a closed error code, an enum, a boolean, or
a number, and `OBSERVABILITY_EVENT_FIELDS` turns "no free-text field" into a
typecheck rather than a convention — the canary tests in
`test/observability.test.ts` push a token-bearing error through the real
emission path and assert it reaches neither sink. Threshold alerting over the
dataset (`observability-alerts.ts`) is wired into the `scheduled` handler and
unit-tested, but `wrangler.toml` leaves its cron trigger commented out until
the Analytics Engine SQL response shape is verified against a live dataset. The
event schema, column map, dashboard queries, retention, access, and the triage
runbook are in [`Observability`](observability.md); the two-sink decision is
[ADR 0004](decisions/0004-observability.md).

## Deployment

Run `bun run build` for the dry-run check. The manual Deploy workflow accepts a
staging or production environment and requires the repository's Cloudflare API
token and account ID secrets. Production DNS and OAuth are intentionally outside
this foundation issue.
