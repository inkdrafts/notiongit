# ADR 0005: Write the Notion secrets from the second authorization, GitHub-first

- Status: Accepted
- Date: 2026-09-03
- Decision: Reorder onboarding to GitHub authorization first, then Notion.
  The Notion callback writes `NOTION_TOKEN`, `NOTION_PAGES_DATABASE_ID`, and
  `NOTION_POSTS_DATABASE_ID` into the already-created repository and only then
  hands the job to `PROVISIONING_QUEUE`.

## Context

This decision was first drafted as ADR 0004 ("Keep the Notion token out of the
provisioning queue") on the `codex/issue-46` branch, which recorded the
blocker but never merged. `main` independently reached its own ADR 0004
(`0004-observability.md`) in the meantime, so that number is taken; this
document restates the original's context and resolves it under 0005 instead
of renumbering history.

Issue #46 asks the Worker to write the three secrets above before the first
real sync, so a re-dispatch after an earlier credential-less no-op has
something to authenticate with. The blocker: the Notion access token exists
only during `/auth/notion/callback`, which used to run *before* GitHub
authorization and discarded the token immediately after resolving the Pages
and Posts database IDs. The GitHub callback created the repository later, and
the provisioning queue received only `{ jobId }`. No later step could recover
the token.

The repository's token-hygiene contract (issue #16, issue #19,
`docs/architecture.md`) keeps user tokens out of KV, queue messages, logs,
errors, and browser responses. Encrypting the token before storage does not
satisfy that contract — a queue message is durable, and Cloudflare retains it
across retries and dead-letter handling. So neither a token field on
`ProvisioningJob` nor a queue step that calls `writeGithubActionsSecrets`
(which has the installation token and database IDs, but never the Notion
token) can close the gap. The lifecycle itself had to change.

Two flows were identified as the only ones that keep the token
request-local while still writing the secrets:

1. GitHub authorization first, repository generation, then Notion
   authorization — whose callback resolves the databases, writes the three
   secrets while its token is request-local, and only then enqueues the job.
2. Keep Notion first, then ask the user to authorize Notion a **second time**
   after repository generation, so that second callback's token is
   request-local to a request that also has a repository to write into.

## Decision

Flow 1. GitHub authorization moves first. Product accepted the landing-page
CTA change and exposing the GitHub step ahead of the M5 "Hardening & launch"
work (ADR 0003) — flow 1 uses one authorization per provider, while flow 2
would ask the user to authorize Notion twice and risk re-duplicating the
template on the second pass.

`ProvisioningJob` gains one non-secret field, `notionSecretsWrittenAt: number
| null` on `ProvisioningJobData`, and one new status, `awaiting_notion`,
ahead of `queued` in the lifecycle. `createProvisioningJob` starts every job
`awaiting_notion` with the field `null`. `finishGithubCallback` creates the
job in that state and redirects the browser to `/connect/notion?job_id=...`
instead of touching the queue. `continueNotionOnboarding` — still the sole
place the Notion token exists — resolves the databases fresh (never from a
cached resolution, since a second authorization duplicates the template
again and would otherwise pair a fresh token with stale database IDs), mints
an installation token, calls `writeGithubActionsSecrets`, stamps
`notionSecretsWrittenAt`, and only then sends `{ jobId }` to
`PROVISIONING_QUEUE`. No job is ever visible to the queue before its secrets
exist, so no gate is needed inside `dispatch_sync` or the queue consumer's
step-advancement loop beyond a one-line defensive check; `dispatch_sync`
itself throws if it is ever reached without `notionSecretsWrittenAt` set, as
insurance rather than the enforcement mechanism.

A secret write that fails partway leaves the job `awaiting_notion` with
`notionSecretsWrittenAt` still `null`. The Notion OAuth code is single-use,
so recovery is a fresh `/connect/notion?job_id=...` authorization, which
re-runs the whole write (GitHub's secrets endpoint is create-or-replace, so
re-writing all three is safe). A queue handoff failure *after* the secrets
are written also leaves the job `awaiting_notion` — never `dead_letter` —
and answers `502 provisioning_handoff_failed` with a retry URL, so
re-authorizing skips straight back to the handoff instead of repeating the
secret write.

## Rejected

- **Enqueue the job immediately after repository generation and gate
  `dispatch_sync` on a readiness field**, letting `verify_repository`,
  `patch_config`, and `configure_pages` run while the user is still inside
  Notion's consent screen. Explored in full as a competing design (parallel
  architect candidates plus an independent cross-judge). Rejected: every
  piece of machinery it needs — a second KV store to avoid the queue and the
  callback racing to write the same job record, a distinct "waiting on a
  human" outcome so the wait does not burn the step's retry budget or the
  platform's queue-level retry ceiling, and a poll-backoff schedule — exists
  solely to survive a concurrency window that early enqueueing itself
  creates. The wall-clock savings (three GitHub API polling steps that
  finish in tens of seconds) did not justify the added surface, and its
  residual risk (two independently-scheduled wake-up messages landing near
  the same instant, amplifying the double-dispatch gap already documented on
  `tryAcquireProvisioningLock`) is structural, not incidental.
- **Second Notion authorization, GitHub-then-Notion-then-Notion** (ADR 0004's
  original flow 2): superseded once product accepted the CTA change.

## Consequences

- The landing page's single call to action now points at `/connect/github`;
  `/connect/notion` requires an existing job and answers `409
  provisioning_job_missing` otherwise, so a bookmarked or hand-typed link
  cannot start a Notion consent flow with no repository to write into.
- `finishGithubCallback` no longer returns a JSON body — it redirects. The
  Notion callback's `202` is the flow's one informative response and now
  carries the non-secret repository and site URLs alongside the existing
  authorization summary.
- A job abandoned between the two authorizations simply expires with its KV
  record's existing TTL; the GitHub repository it already created is not
  itself cleaned up. This mirrors the existing TTL-based cleanup idiom used
  everywhere else in this pipeline and is accepted as out of scope here.
- `dispatch_sync` recording GitHub Actions' missing-credentials no-op as a
  real sync `success` is now structurally unreachable: no job reaches the
  queue without its secrets.

## References

- [Issue #46](https://github.com/inkdrafts/notiongit/issues/46)
- [ADR 0002: Notion onboarding via OAuth template duplication](0002-notion-onboarding.md)
- [ADR 0003: GitHub App visibility and ownership model](0003-github-app-visibility.md)
- [Issue #16: Durable provisioning job model](https://github.com/inkdrafts/notiongit/issues/16)
- [Issue #19: Token hygiene enforcement](https://github.com/inkdrafts/notiongit/issues/19)
