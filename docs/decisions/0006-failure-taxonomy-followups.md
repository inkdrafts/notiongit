# ADR 0006: Failure taxonomy follow-ups from #53

- Status: Accepted
- Date: 2026-09-05
- Decision: Sign off on the 73-entry copy review unmodified, on the strength
  of the existing hygiene tripwire. Defer the orphan-row lint to its own
  unscheduled issue instead of implementing it inside the launch-gating
  issue. Treat the concurrent-redelivery limitation and the repository reuse
  marker as already handled elsewhere.

## Context

Issue #55 asked that every leftover attention item from #53's failure
taxonomy resolve to an explicit accepted or done status before
notiongit#28's launch gate. Four items were open:

1. A human read of the 73 registry entries in `src/failures.ts`, since that
   copy is production-facing.
2. The sturdy repository reuse marker, already promoted to its own issue
   (#73).
3. The documented, accepted limitation that concurrent redelivery can
   double-dispatch the sync workflow.
4. An unscheduled follow-up: an "orphan-row lint" that would flag registry
   entries no code path can ever produce, via `Exclude<ProvisioningFailureCode,
   ThrownFailureCode>` with three named synthetic-code exceptions.

## Decision

**Copy review.** Read all 73 entries end to end against the tone the
registry already sets (plain second-person guidance, no provider jargon,
consistent message/action split) and against `test/failures.test.ts`'s copy
hygiene test, which already asserts no bearer token, hex id, long digit run,
or provider domain leaks into `user.message`, `user.action`, or
`support.note`. Found no wording that needed to change. Sign-off is
unmodified; the hygiene test is the durable check that keeps this true going
forward, per the issue's own instruction.

**Concurrent redelivery.** Already documented as an accepted limitation in
`docs/architecture.md` ("Durable provisioning job queue"), with the
Durable-Object-backed lock named as the natural follow-up if genuine
concurrent redelivery is observed. No new action needed for #55.

**Repository reuse marker.** Tracked and scoped in #73, which gates launch
on its own. Out of scope for #55.

**Orphan-row lint.** Deferred. See Rejected.

## Rejected

- **Implementing the `ThrownFailureCode` orphan lint now, inside #55.**
  Traced how registry codes actually reach a caller and found they come from
  at least three distinct mechanisms, not one: module-declared thrown-error
  unions (`NotionOAuthErrorCode` and its seven siblings, already proven a
  subset of the taxonomy by the `AssertSubset` compile check in
  `test/failures.test.ts`), literal codes passed to `FlowFailure` at
  call sites (`src/index.ts`, `src/github-user-auth.ts`), and codes built
  directly as object literals inside status-switch logic that never throws a
  typed error at all (`authError`'s `github_authorization_unavailable`
  branch in `src/index.ts`, `provisioning-job.ts`'s
  `provisioning_step_failed` breadcrumb). `notion_unavailable` is both a
  `CALLBACK_FALLBACKS` default and a code two literal throw sites in
  `notion-oauth.ts` also use directly, so it cannot be one of the "synthetic"
  exceptions the issue's phrasing assumes. A correct `ThrownFailureCode`
  union needs an exhaustive trace of every code-producing site across all
  twelve-odd modules that touch the taxonomy, not a reuse of the module
  `ErrorCode` unions the existing compile check already imports. Unlike that
  existing check, nothing threads `ThrownFailureCode` through the actual
  throw and object-literal sites, so TypeScript cannot self-verify the
  union's completeness; a wrong union either blocks legitimate registry
  entries as false orphans or silently misses real ones. The issue itself
  scoped this as "does not gate launch" and "small, unscheduled" work
  separate from the copy-review sign-off; landing an unverifiable lint to
  close #55 faster would trade a real launch-gating deliverable for a
  cosmetic one, on a codebase that is in its hardening pass. Filed as
  notiongit#74 instead, carrying this investigation forward so the next
  attempt starts from the real code-producing surface instead of a guess at
  it.

## Consequences

- #55 closes with the copy review signed off and the other three items
  reaffirmed as already handled: one in `docs/architecture.md`, one in #73,
  one promoted to notiongit#74.
- No source file changes: the copy needed none, and this ADR plus the closed
  issue are the sign-off artifact the issue asked for.
- notiongit#74 carries the orphan-row lint forward with the mechanism
  inventory already done, so it does not need to be rediscovered.

## References

- [Issue #55](https://github.com/inkdrafts/notiongit/issues/55)
- [Issue #53: the onboarding failure taxonomy](https://github.com/inkdrafts/notiongit/issues/53)
- [Issue #73: sturdy repository reuse marker](https://github.com/inkdrafts/notiongit/issues/73)
- [Issue #74: orphan-row lint for the failure registry](https://github.com/inkdrafts/notiongit/issues/74)
- `docs/architecture.md`, "Durable provisioning job queue"
