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
server-only.

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
transient retries. What the continuation persists is the resolution record
(`notion:template-resolution:<job id>`, same 24-hour TTL as every other
record): normalized Pages/Posts database IDs plus each database's non-secret
schema summary (property types and select/multi-select option names), which
the later schema-validation and secret-writing steps consume. No token, page
title, or row content ever reaches it. The HTTP response contains only the
job ID and whether template duplication occurred; failures return their
distinct error code with non-secret details (missing roles, scanned count).

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
`ProvisioningJob` record (`provisioning-job.ts`), enqueues `{ jobId }` to
`PROVISIONING_QUEUE`, and responds `202` with only the identity and
repository data known so far — the OAuth token and code are already out of
scope by the time the response is written and are never queued or stored.
If the enqueue itself fails, the job record is marked `dead_letter` with a
`provisioning_enqueue_failed` step error before the request surfaces a 502,
so durable state never shows a `queued` job that no message will ever
process; restarting the flow creates a fresh job.

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
queue to redeliver the same message after a backoff (a retryable failure, a
lock another attempt still holds, or a record not yet visible through KV's
eventual consistency — a message can be delivered before the write that
preceded its enqueue has propagated), or acks (the job just reached a
terminal status). Because progress lives in the record rather than the
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
mechanism and is what a future progress UI or ops tooling should read. The
consumer batch stays at one message: steps such as `await_sync` poll
provider APIs inline for minutes, so a larger sequential batch could exceed
the consumer's wall-clock limit and force redelivery of every message in it.

Workers KV has no compare-and-swap, so the per-job lock cannot give perfect
mutual exclusion: two consumer invocations that read the job at the same
instant can both observe no lock and both proceed. Closing that race
completely would need a Durable Object, which this queue's expected
throughput does not justify; the accepted fallback is that every step stays
idempotent (or, for the sync dispatch, resumable via its marker), so the
rare double acquisition wastes a redundant step execution rather than
corrupting job state or double-mutating GitHub. Every `ProvisioningJob`
record — including the sync dispatch marker, the only durable state
adjacent to an in-flight operation — is written with the same
`expirationTtl` used everywhere else in this project (24 hours), so expired
jobs and their transient state are removed on KV's own schedule rather than
needing a separate sweep.

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
build id, and build status for a future progress UI.

## Deployment

Run `bun run build` for the dry-run check. The manual Deploy workflow accepts a
staging or production environment and requires the repository's Cloudflare API
token and account ID secrets. Production DNS and OAuth are intentionally outside
this foundation issue.
