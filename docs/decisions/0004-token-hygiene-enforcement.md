# ADR 0004: Token hygiene enforcement

- Status: Accepted
- Date: 2026-09-03
- Decision: Enforce the write-through / no-token-at-rest invariant with
  self-redacting `Secret` wrappers at credential mint points, one sanctioned
  log serializer, a journey-driven canary suite, and TTL-only retention —
  with an explicit prohibition on deleting the template-resolution record.

## Context

Issue #19 asks the project to enforce and test what the code so far held by
convention: access tokens are confined to the request that mints them and
never reach KV, the queue, logs, or responses. The convention was documented
in comments and policed by scattered per-module test assertions, but nothing
structural prevented a future `console.error(error)` or a `{...spread}` of a
token-bearing object into a record, and the two paths that discard diagnostics
entirely (the GitHub callback's 502 fallthrough and the queue consumer's
catch) meant a leak added there would be invisible to tests.

Three facts anchored the design:

1. The durable queue architecture already removed every token
   from storage: the callback spends the user token synchronously, and every
   queue step mints its own installation token from the non-secret
   `installationId` (see "Durable provisioning job queue" in
   `docs/architecture.md`). Enforcement had to protect that shape, not
   re-architect it.
2. All four KV record families already carry correct TTLs, there is no
   `kv.delete`/`kv.list` in `src/`, and no cron trigger exists. Retention is
   already TTL-only in fact; it only needed to be TTL-only on purpose.
3. The one record a naive "hygiene" pass would delete —
   `notion:template-resolution:{jobId}` — is load-bearing.

## Decision

1. **Secrets are wrapped at their mint points, and nowhere else.**
   `exchangeGithubCode`, `exchangeNotionCode`, and
   `createGithubInstallationToken` return `Secret<'github-user-access'>`,
   `Secret<'notion-user-access'>`, and `Secret<'github-installation'>`
   respectively, and the two cross-boundary handoffs
   (`NotionOAuthContinuation.accessToken`, `StepRunnerContext.installationToken`)
   carry the wrapper. `toString()`/`toJSON()` render `"[redacted]"`, so any
   accidental serialization — the structural leak this design exists to close
   — prints a loud marker instead of a credential. The value leaves only via
   the explicit, greppable `.raw` / `.bearer()` unwraps at provider-call
   sites. Leaf provider clients keep plain `string` parameters: function
   arguments are memory-only and cannot reach KV, a response, or a log
   without first passing through code that holds a `Secret`.
2. **One diagnostics module owns all stringification for logs.**
   `src/safe-serialize.ts` exposes `redactValue`, `serializeForLog`, and
   `reportError` — the only `console.*` producer of error diagnostics in
   `src/`. It is wired into exactly the three places that previously
   discarded diagnostics: the GitHub callback's 502 fallthrough, the queue
   consumer's catch, and the Notion callback's non-`NotionOAuthError`
   fallthrough. No levels, no sinks, no framework. The Notion error
   `details` merge into response bodies goes through `redactValue`,
   covering the one dynamic browser surface. The provisioning funnel and
   alert telemetry introduced by the observability work are the other
   sanctioned console producers; their payloads are closed typechecked
   allowlists of non-secret fields, and the canary suite scans them too.
3. **TTL-only retention; the resolution record is never deleted.** No
   `kv.delete`, no cron trigger, no delete endpoint, no scan. Every record
   expires on the TTL documented in `docs/security-data-flow.md` §3.
   Deleting `notion:template-resolution:{jobId}` at job completion is
   explicitly prohibited: `hasValidatedNotionTemplate` (`src/index.ts:480`)
   re-reads and revalidates that record whenever the same job id starts or
   finishes a GitHub connection (`beginGithubInstall`, `finishGithubCallback`),
   so it gates same-jobId reconnection and retry. A hygiene delete would
   break real flows while removing nothing sensitive — the record holds
   database IDs and property type names only.
4. **The invariant is enforced by a journey-driven canary suite plus static
   tripwires.** `test/token-hygiene.test.ts` drives the Notion callback, the
   GitHub callback, the full seven-step pipeline, the three error funnels,
   and the disconnect (mint-404) timeline with synthetic canary credentials,
   asserting their absence from KV writes, queue messages, response bodies
   and redirect headers, thrown errors, console output, and the Analytics
   Engine data points captured through a fake metrics binding — plus
   positive-flow assertions proving each canary genuinely flowed, per-write
   TTL logs pinning the retention table, and zero recorded delete
   operations. Console records are pinned to the sanctioned producers: a
   journey fails if any console line is not a `[notiongit] …` reportError
   line or a structured funnel event. Statically: `console.*` may appear in
   `src/` only in `safe-serialize.ts`, `observability.ts`, and
   `observability-alerts.ts`, and no `src/` error message may be built from
   interpolation (an interpolated message is the one channel that would
   carry a credential into an otherwise-redacted log line).

## Rejected approaches

- **Branded string types on every provider-client parameter.** The compile
  time boundary would have covered ~40 signature edits across seven leaf
  modules while adding no durable-state protection: arguments never
  serialize, so a branded token buys nothing that `Secret`-at-mint-points
  does not already provide, at a much larger diff.
- **Closed-sink allowlists (typed "safe string" unions for response bodies,
  à la a `JsonSafe<T>` wrapper).** Rejected on soundness, not taste: a
  branded leaf is still assignable to a plain-`string` field, so one
  unsanitized field defeats the sink typing silently, while every legitimate
  response shape (schema summaries, error details with non-secret fields)
  has to be re-modeled inside the allowlist. Runtime redaction at the mint
  point plus canary detection covers both failure modes the sink typing only
  pretended to cover.
- **Deleting the template-resolution record on job completion.** Breaks
  verified reconnection/retry flows for no security gain; see Decision 3.
- **Cron-triggered cleanup or KV scans for expiry.** `kv.list` is
  eventually consistent and chargeable, and TTL already removes every
  record; a sweeper would duplicate the platform and add a new failure mode.
- **A disconnect/delete endpoint.** Job ids are the only secret-less handle,
  and deleting by a guessable id without an auth design is itself a
  vulnerability. Documented as a follow-up option (authenticated) in
  `docs/security-data-flow.md` §8.
- **Shortening the terminal job TTL to ~10 minutes.** Contradicts the
  record's role as the job's outcome summary and manufactures dead-letter
  noise for monitoring. Kept as a documented option: if a shorter
  post-mortem window is ever required, a terminal-TTL constant is the honest
  mechanism, not deletion machinery.

## Consequences

- **The forgotten-`.raw` failure mode is a burned provider call, not a
  leak.** A handler that forgets to unwrap sends `Authorization: Bearer
  [redacted]` and gets a 401/404, which classifies as a step failure and
  retries — bounded by `max_retries = 6` in `wrangler.toml` (and the
  per-step attempt ceiling) before dead-lettering visibly. This is a
  deliberate feature: the mistake is loud in provider metrics and job state
  instead of silent in a log line. The cost is at most one wasted retry
  cycle per forgotten unwrap; review greps `.raw`/`.bearer()` to prevent it.
- **`"[redacted]"` in a response body, a KV value, or a queue message is
  now a bug by definition**, not a safety net — the canary suite fails on
  the marker in those surfaces even though it cannot leak. Console records
  may contain the marker; that is the sign the funnel did its job.
- Three `console.error` call sites appear in platform logs where previously
  nothing was written. Volume is bounded: the queue catch fires at most
  `max_retries = 6` per message.
- The scattered per-module canary assertions in other test files remain,
  except the brittle `JSON.stringify(job)` substring scan in
  `test/provisioning-job.test.ts`, whose intent is strictly subsumed by the
  pipeline journey's every-put canary scan of job records.

## References

- `docs/security-data-flow.md` — credential inventory, retained-state table,
  egress surfaces, revocation timelines, enforcement map
- `src/secret.ts`, `src/safe-serialize.ts`, `test/token-hygiene.test.ts`
- ADR 0002 (Notion onboarding), and the durable queue design it extends
