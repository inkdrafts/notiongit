# ADR 0004: Keep the Notion token out of the provisioning queue

- Status: Blocked pending a product decision
- Date: 2026-09-03
- Decision: Do not implement issue #46 by persisting the Notion user token.

## Context

Issue #46 asks the Worker to write `NOTION_TOKEN`,
`NOTION_PAGES_DATABASE_ID`, and `NOTION_POSTS_DATABASE_ID` before the first
real sync. It allows the Worker to re-dispatch after an earlier
credential-less no-op, but it does not provide a way to obtain the Notion
token when that re-dispatch occurs. The current onboarding flow authorizes
Notion first and GitHub second.

The Notion access token exists only during `/auth/notion/callback`. That
callback resolves and validates the two database IDs, then discards the
token. The GitHub callback creates the repository later, and the provisioning
queue receives only `{ jobId }`. No later step can recover the token.

The repository security contract, documented by issue #16, issue #19, and
`docs/architecture.md`, keeps user tokens out of KV, queue messages, logs,
errors, and browser responses. Encrypting the token before storage does not
satisfy that contract. A queue message is durable because Cloudflare retains
it during retries and dead-letter handling.

## Decision

Keep the request-local token boundary. Do not add a token field to
`ProvisioningJob`, a token-bearing queue message, or an encrypted token
record.

Do not add a queue step that calls `writeGithubActionsSecrets`. That step would
have the installation token and database IDs, but it would not have the
Notion token required for `NOTION_TOKEN`.

The current flow cannot satisfy either issue #46 outcome without changing the
onboarding lifecycle. The implementation remains blocked until the product
chooses one of these flows:

1. Start GitHub authorization first. After repository generation, redirect to
   Notion authorization. The Notion callback then resolves the databases,
   writes the three secrets while the token is request-local, records only
   non-secret write metadata, and enqueues the provisioning job.
2. Keep Notion authorization first. After repository generation, ask the user
   to authorize Notion a second time. The second callback writes the secrets
   while its token is request-local.

The first flow uses one authorization per provider and is the preferred shape.
It changes the current landing-page CTA and exposes the GitHub step before the
M5 "Hardening & launch" work identified in ADR 0003. No numbered issue for
that launch change exists in this repository, so issue #46 must not adopt this
flow silently. The second flow preserves the current CTA but asks the user for
a second Notion authorization and may repeat template-duplication behavior.

## Consequences

The existing code remains safe under the token-hygiene contract, but the first
sync can still complete as `success` when `notiongit-sync` performs its
documented missing-credentials no-op. That result must not be presented as a
real content sync after issue #46 is implemented.

Any implementation of the selected flow must add a non-secret readiness state
to `ProvisioningJobData`, gate `dispatch_sync` on that state, and test partial
secret writes, callback retries, queue handoff failure, and the absence of the
token from all durable and browser-visible data.

## References

- [Issue #46](https://github.com/inkdrafts/notiongit/issues/46)
- [ADR 0002: Notion onboarding via OAuth template duplication](0002-notion-onboarding.md)
- [Issue #16: Durable provisioning job model](https://github.com/inkdrafts/notiongit/issues/16)
- [Issue #19: Token hygiene enforcement](https://github.com/inkdrafts/notiongit/issues/19)
