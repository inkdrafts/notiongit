# Security and data flow

This document is the audit answer to three questions: what credentials exist,
where they can and cannot travel, and what the Worker retains after a request
ends. It is written to be checkable against `test/token-hygiene.test.ts` by a
reviewer with no code access; the enforcement map in §5 names the journey and
static tripwire that pins each claim.

## 1. Credential inventory

| Credential | Enters the Worker | Lifetime | Must never reach |
| --- | --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | `wrangler secret put` (deployment config) | Until rotated | KV, queue, responses, logs, browser code |
| `GITHUB_CLIENT_SECRET` | `wrangler secret put` | Until rotated | KV, queue, responses, logs (doubles as the GitHub state HMAC key, §7) |
| `NOTION_CLIENT_SECRET` | `wrangler secret put` | Until rotated | KV, queue, responses, logs (doubles as the Notion state HMAC key, §7) |
| Notion OAuth one-time `code` | `?code=` on the Notion callback | One provider exchange, request-local | KV, queue, responses, logs |
| GitHub OAuth one-time `code` | `?code=` on the GitHub callback | One provider exchange, request-local | KV, queue, responses, logs |
| Notion user access token | Notion token exchange (`exchangeNotionCode`) | Write-through: dies with the Notion callback request | Everything except the Notion API calls it authenticates |
| Notion refresh token | Notion token exchange response | Typed in the exchange result, never read | Everything (the canary suite proves it is never read) |
| GitHub user access token | GitHub token exchange (`exchangeGithubCode`) | Write-through: dies with the GitHub callback request | Everything except the GitHub API calls of that request |
| Installation token | Minted per provisioning step (`createGithubInstallationToken`) | One queue message; discarded when the step returns | Everything except that step's GitHub API calls |
| App JWT | Minted per App-API call from the private key | ~10 minutes; sent only as a Bearer header to GitHub | KV, queue, responses, logs |
| Actions secret plaintexts | Would enter via `writeGithubActionsSecrets` (not yet wired, §7) | Sealed to the repository's public key inside one request | Everything except the sealed envelope body |

Non-secret configuration (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, client IDs,
API version pins) is public by design and may appear in responses and URLs.

## 2. Journey walkthroughs

**Notion callback.** `GET /connect/notion` stores a signed-state record
(pending, 10-minute TTL) and redirects to Notion's authorize URL with an
HttpOnly state cookie. `GET /auth/notion/callback` validates state and cookie,
rewrites the state record to `consumed` (60-minute replay TTL), exchanges the
one-time code, and hands the resulting token to the production continuation
**as a `Secret`** while still inside the request. The continuation resolves
the duplicated template with that token and persists only the resulting
database IDs and schema summaries. The token, refresh token, workspace ID,
bot ID, and code are never written anywhere and are garbage when the request
returns.

**GitHub callback.** `GET /connect/github` requires a valid template
resolution for the job and stores a signed-state record. `GET
/auth/github/callback` verifies state, exchanges the code, and spends the user
token immediately on identity, installation, and repository generation —
GitHub requires user-to-server authentication there, so this is the one step
that cannot be deferred. It then persists the `ProvisioningJob` record
(non-secret metadata only), rewrites the state record to `consumed`, enqueues
`{ jobId }`, and responds 202. The user token and code are out of scope
before the response is written.

**Queue pipeline.** Each queue message names a job; the consumer mints a fresh
installation token from the job's durable, non-secret `installationId`,
passes it to exactly one step handler as a `Secret`, and discards it when the
handler returns. No token of any kind is part of durable state.

## 3. Retained state

Every KV record the Worker writes, with every field. There is no other key
shape, no scan, and no delete call in `src/`; removal is TTL-only.

| Key pattern | Record and fields | TTL | Written when |
| --- | --- | --- | --- |
| `github:oauth-state:{nonce}` | `GithubStateRecord`: `version` (1), `jobId`, `nonce`, `expiresAt`, `phase` (`pending` \| `setup_received` \| `consumed`), optional `installationId`, optional `identity {id, login, accountType}` | 600s as `pending`; 3600s from the `setup_received`/`consumed` write | GitHub connect/callback |
| `notion:oauth-state:{nonce}` | `NotionStateRecord`: `version` (1), `jobId`, `nonce`, `expiresAt`, `phase` (`pending` \| `consumed`) | 600s as `pending`; 3600s from the `consumed` write | Notion connect/callback |
| `notion:template-resolution:{jobId}` | `NotionTemplateResolutionRecord`: `version` (1), `jobId`, `resolution {pagesDatabaseId, postsDatabaseId, templateSchemaVersion, scannedDatabaseCount, pagesSchema {databaseId, propertyTypes, optionNames}, postsSchema {…}, resolvedAt}` | 86400s, single write, never rewritten or deleted (ADR 0004) | Successful Notion template resolution |
| `github:onboarding-job:{jobId}` | `ProvisioningJob`: `version` (1), `jobId`, `installationId`, `identity {id, login, accountType}`, `status`, `steps {status, attempts, updatedAt, lastError {code, retryable} \| null}` per step, `data {repository {name, url, baseurl, kind}, generatedRepository {id, fullName, name, htmlUrl, defaultBranch, templateFullName, templateHeadSha, templateHeadTreeSha, headSha, headTreeSha, reused}, pages {status, url, htmlUrl, buildType, source, reused} \| null, sync {runId, htmlUrl, conclusion} \| null, syncDispatchMarker {excludedRunIds, dispatchedAtMs} \| null, deployment {commitSha, buildId, status, verifiedAt} \| null}`, `lock {owner, acquiredAt, expiresAt} \| null`, `createdAt`, `updatedAt`, `completedAt` | 86400s, rolling: refreshed by every write including the terminal one | GitHub callback and every queue advance |

Queue payloads are exactly `{ jobId }` — the record in KV is the sole source
of truth, so a message carries nothing else.

## 4. Egress surfaces

- **Browser responses** carry fixed error codes, the two 202 body shapes
  (`notion_authorized` summary; `provisioning` summary), and — on Notion
  OAuth errors — the error's `details`, merged through `redactValue` so a
  credential-named key cannot reach the body. Provider response bodies are
  never echoed.
- **Queue messages** are exactly `{ jobId }`.
- **Platform logs** carry output from three sanctioned producers only:
  `reportError` (`console.error('[notiongit] <context>', serializeForLog(error))`,
  whose serializer renders `Secret`s as `"[redacted]"`, redacts
  credential-named keys regardless of value, bounds depth and cycles, and
  renders `Error`s as `{name, message, …own fields}`); the provisioning
  funnel events (`emitProvisioningEvent` writes one
  `JSON.stringify(event)` line, whose fields are a typechecked closed
  allowlist — job id, step names, classified error codes, durations — never
  an `Error`, a provider body, or a credential); and the observability
  alert adapter's closed `{type, kind}` status lines.
- **Analytics Engine** (`PROVISIONING_METRICS`, optional binding) receives
  one data point per funnel event, built from the same allowlisted fields.
  The alert evaluator queries aggregated windows and POSTs findings to an
  operator webhook; an alert carries a step name, a closed `kind`, and
  counts — never a job id, a token, or a provider body.

## 5. Enforcement

- **Structural:** every credential is wrapped at its mint point
  (`exchangeGithubCode`, `exchangeNotionCode`,
  `createGithubInstallationToken`) and at the two cross-boundary handoffs
  (`NotionOAuthContinuation`, `StepRunnerContext`) in a self-redacting
  `Secret`. Serialization yields `"[redacted]"`; the value leaves only
  through the greppable `.raw` / `.bearer()` unwraps at provider-call sites.
- **Diagnostic:** error diagnostics are produced only by
  `src/safe-serialize.ts`; funnel and alert telemetry only by
  `src/observability.ts` / `src/observability-alerts.ts`, whose event
  fields are a typechecked closed allowlist.
- **Systematic:** `test/token-hygiene.test.ts` drives five journeys (Notion
  callback, GitHub callback, the full seven-step pipeline, the three error
  funnels, the disconnect timeline) with synthetic canary credentials and
  fails if any canary or credential-shaped key name appears in KV writes,
  queue messages, response bodies and redirect headers, thrown errors,
  console output, or the Analytics Engine data points captured through a
  fake metrics binding — and it fails if a journey passes vacuously,
  because each also asserts the canary genuinely flowed (the recorded
  provider `Authorization` headers). Per-write TTL logs pin the retention
  table in §3; the journeys additionally assert zero delete operations.
  Console records are further pinned to the sanctioned producers: a
  journey fails if any console line is not a `[notiongit] …` reportError
  line or a structured funnel event. Two static tripwires hold the
  structural invariants: `console.*` appears in `src/` only in the three
  sanctioned sinks, and no `src/` error message is built from
  interpolation.

Run `bun test test/token-hygiene.test.ts`.

## 6. Revocation and removal timelines

- **OAuth state records** expire by TTL (10 minutes pending, 60 minutes
  consumed) and are the only records that gate anything time-sensitive.
- **Template resolution** expires 24 hours after the single write. It is
  *not* deleted at job completion: `hasValidatedNotionTemplate`
  (`src/index.ts:480`) re-reads and revalidates it when the same job id
  reconnects GitHub (`beginGithubInstall` and `finishGithubCallback`), so a
  retry or a setup-callback-before-OAuth-callback works without repeating the
  Notion flow. Deleting it "for hygiene" would break those flows while
  removing nothing sensitive — the record holds database IDs and property
  type names only. To remove one early (e.g. a support request), use
  `wrangler kv key delete` with the exact key; there is deliberately no
  endpoint that does this.
- **Provisioning jobs** expire 24 hours after their last write, terminal ones
  included (the rolling TTL is refreshed by every save, so an active job
  never expires mid-flight, and a finished record — including its non-secret
  outcome metadata and sync-dispatch marker — is removed on schedule).
- **GitHub App uninstall / authorization revocation** needs no data flow:
  the next installation-token mint returns 404, the step is classified
  non-retryable, and the job lands in `dead_letter` with a
  `github_app_auth_failed` last error. The record then simply ages out on the
  rolling 24-hour TTL. Provider-side tokens die at the provider; the Worker
  never holds them long enough to revoke.

## 7. What the guarantees do not cover

- **Post-unwrap handling.** `.raw` hands a credential to a leaf provider
  client as a plain string. The type boundary ends there; the canary journeys
  are the detection layer for anything a leaf client does wrong. The
  forgotten-`.raw` failure mode is a failed provider call (GitHub receives
  `Bearer [redacted]`), not a leak — see ADR 0004.
- **KV wire format.** `kv.get<T>` casts declare record types without
  validating the stored JSON. The single-writer discipline (only this
  Worker's code writes these keys, with versioned records) is what makes the
  casts acceptable; a second writer would need a parse boundary.
- **State signing key reuse.** The OAuth client secrets double as state HMAC
  keys, so rotating `GITHUB_CLIENT_SECRET` invalidates every in-flight GitHub
  state (and likewise for Notion). Rotation is safe when nothing is in
  flight; a dedicated signing secret is the fix if that coupling ever hurts.
- **Infrastructure and deployment surfaces.** Cloudflare's queue, KV, and
  Workers internals, `wrangler`/dashboard secret storage, and CI secrets are
  trusted platforms outside this document's scope.
- **Terminal job retention.** A finished job's record lives 24 hours past its
  last write. If a shorter post-mortem window is ever required, the honest
  mechanism is a shorter terminal TTL (a documented option in ADR 0004), not
  deletion machinery.

## 8. Follow-ups

- **`writeGithubActionsSecrets` wiring.** The Actions-secrets pipeline
  (`actions-secrets.ts`) is built but not called: writing the sync workflow's
  Notion token requires the token at queue-consumer time, i.e. a persistence
  decision that would put a credential back into durable state. Until that
  decision is made deliberately (encrypted at rest, or re-entering via a
  fresh request), the sync workflow must be authorized some other way. Named
  follow-up; do not wire it casually.
- **Authenticated disconnect endpoint.** If early removal of a job's records
  is ever wanted as a product feature, it must be an authenticated endpoint,
  not a guessable-id delete. Until then, TTL expiry and manual
  `wrangler kv key delete` are the only removal paths.
