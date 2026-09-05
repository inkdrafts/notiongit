# Launch-gate reviews

The five launch reviews required by issue #28, each grounded in the merged
implementation rather than intent. Companion documents carry the operating
detail: [`security-data-flow.md`](security-data-flow.md) for the credential
audit, [`observability.md`](observability.md) for alerting and triage,
[`provisioning-admission-runbook.md`](provisioning-admission-runbook.md) for
the abuse controls and kill switch, and [`launch-checklist.md`](launch-checklist.md)
for the gate rows that reference this file. Reviewed 2026-09-05 against
`main` plus the launch-gate PR.

## 1. Least-privilege review

**Verified:** the permissions the App is registered with are exactly the
permissions the code uses, and no more.

The registered set (`docs/github-app-manifest.html`,
[`github-app-runbook.md`](github-app-runbook.md) "Least-privilege permission
matrix") is six repository permissions: Metadata read; Administration,
Contents, Secrets, Actions, Pages write. The endpoints `src/` actually calls
map onto that set one-for-one:

| Code path | Endpoint | Permission |
| --- | --- | --- |
| `repository-generation.ts` | `POST /repos/{template}/generate`, `GET /user/repos` | Administration write; Metadata |
| `actions-secrets.ts` | `GET .../actions/secrets/public-key`, `PUT .../actions/secrets/{name}` | Secrets write |
| `github-pages.ts`, `site-deployment.ts` | `GET/POST .../pages`, `GET .../pages/builds/latest` | Pages write |
| `repository-config.ts` | `PATCH .../contents/_config.yml` | Contents write |
| `notion-sync.ts` | `POST .../workflows/{file}/dispatches`, run and artifact reads | Actions write, Contents read |
| `github-user-auth.ts` | `GET /user`, `GET /user/installations` | user-to-server identity only |

No organization, webhook, issue, pull request, package, or workflow-file
permission is requested or used. Repository access is scoped by the user at
install time. The Notion integration requests read access only
([`notion-integration-runbook.md`](notion-integration-runbook.md)).

**Findings:** none open. The install-and-authorize smoke test
(2026-09-02, runbook) confirmed the granted set is sufficient for every
provisioning step.

## 2. Secret and rotation review

**Verified:** the credential inventory in
[`security-data-flow.md`](security-data-flow.md) §1 is complete, and every
entry is a Cloudflare server-side secret or a write-through token that dies
with its request. The canary suite (`test/token-hygiene.test.ts`) is the
runtime enforcement.

Rotation procedures and their blast radius:

| Secret | Rotation | Consequence |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | Add a second key in App settings, deploy, remove the old one. GitHub Apps accept multiple keys, so this is zero-downtime | None |
| `GITHUB_CLIENT_SECRET` | Rotate in App settings, `wrangler secret put`. **This secret doubles as the OAuth-state HMAC key** (`src/index.ts`), so rotation invalidates every in-flight GitHub state and status session | In-flight onboarding restarts; dashboard users sign in again. Rotate when the funnel is idle |
| `NOTION_CLIENT_SECRET` | Same, with the same HMAC coupling for Notion state | Same |
| `CF_ANALYTICS_API_TOKEN` | Regenerate with Account Analytics read only, never write scopes | Alert checks fail closed (they return "not checked") until updated |
| `OBSERVABILITY_ALERT_WEBHOOK_URL` | Update the secret | None |

User tokens are not rotatable because they are never retained; revocation
happens at the provider and is covered by the disconnect steps on
`/leaving`.

**Findings:** the state-signing coupling above is the one deliberate
compromise, documented in security-data-flow §7 with its fix (a dedicated
signing secret) if it ever hurts. Acceptable for launch; no open critical or
high finding.

## 3. Threat-model review

Per threat, the control that answers it and where the control is enforced:

| Threat | Control | Enforced by |
| --- | --- | --- |
| Forged or replayed OAuth callbacks | Signed state payloads, single-use KV replay markers, purpose dispatch per leg, cookie-nonce double submit on the status leg | `src/signed-payload.ts`, `src/index.ts`, `src/status.ts`; `test/index.test.ts` |
| Provisioning abuse (volume, retries, suspended identities) | Per-account attempt limits, request-burst buckets on keyed address digests, identity-denial cooldown, global mutation budget, stage gates | `src/provisioning-throttle.ts`; `test/provisioning-throttle.test.ts`, `test/provisioning-load.test.ts` |
| Runaway provider mutations | Budget ceilings clamped inside GitHub's app-wide secondary limits; content-creating steps are the only budgeted mutations | `src/provisioning-throttle.ts` (`PROVISIONING_MUTATIONS_PER_MINUTE/HOUR`) |
| Secret leakage into logs, KV, queue, or responses | Self-redacting `Secret` type at mint and handoff points, closed telemetry field allowlist, redacting error serializer | `src/secret.ts`, `src/safe-serialize.ts`, `src/observability.ts`; the canary journeys in `test/token-hygiene.test.ts` |
| Malicious job record injection | Queue messages carry only `{ jobId }`; the KV record is the sole authority; ids are format-checked | `src/index.ts`, `src/provisioning-queue.ts` |
| Unauthorized repository takeover | Installation ownership proven from the App JWT and from the authenticated user's own installations; personal accounts only | `src/github-app-auth.ts`, `src/github-user-auth.ts` (`assertUsablePersonalInstallation`) |
| Content abuse via provisioned sites | Notion read-only integration; sites live in the user's repository where GitHub's own AUP enforcement applies; acceptable-use policy published | `/acceptable-use`, Notion runbook |

**Residual risks** (documented, accepted for a free service): trust in
Cloudflare's queue/KV/Workers platform; untyped KV casts protected by the
single-writer discipline; leaf-client behavior after a token unwrap, detected
only by the canary journeys. No open critical or high finding.

## 4. Backup and rollback review

**Code.** Cloudflare keeps deployed Worker versions; rollback is
`wrangler rollback` (or redeploying the prior revision from the Deploy
workflow). Before code rollback, stop the funnel with the kill switch
([`provisioning-admission-runbook.md`](provisioning-admission-runbook.md)):
paused jobs stay in KV and resume from their recorded step when the control
clears, and completed steps never re-run (each step is gated on the record's
own state).

**Data.** There is no database to back up. Every KV record is versioned,
carries a TTL, and is reconstructible: jobs re-drive by re-sending
`{ jobId }` to the queue; an unrecoverable job dead-letters with its record
retained 24 hours for triage. Queue redelivery is safe because every step is
idempotent by design (template reuse, Pages reuse, sync dispatch markers).

**User sites.** Provisioned repositories run their own Actions workflows and
are unaffected by any InkDrafts rollback. A bad template change is a git
revert on `inkdrafts/notiongit-template` and affects only future provisions.
A bad sync-engine change ships through the users' repositories at their own
pace.

**Verification:** the idempotency claims are pinned by
`test/provisioning-job.test.ts` and `test/repository-generation.test.ts`
(reuse branches), and the paused-job resume behavior by
`test/provisioning-throttle.test.ts`.

**Findings:** none. The 2026-09-05 production staleness finding in
[`launch-checklist.md`](launch-checklist.md) §B is a deploy-process item,
tracked there, not a backup gap.

## 5. Dependency and license audit

**Verified:** `bun run scripts/license-audit.ts` resolves every direct
dependency of the root package and the two spike workspaces from the
installed tree and asserts each license against a permissive allowlist (MIT,
ISC, BSD, Apache-2.0, MPL-2.0, 0BSD, BlueOak, Unlicense, CC-BY-4.0),
accepting `OR` dual-license expressions. Recorded run (2026-09-05): 10/10
inside the allowlist — `libsodium` and `libsodium-wrappers` (ISC),
`axe-core` (MPL-2.0), `jsdom`, `@types/node`, `typescript`,
`@cloudflare/workers-types`, `wrangler` (MIT OR Apache-2.0).

**Boundary:** runtime code depends only on the libsodium pair; everything
else is dev-time (tests, typecheck, deploy). Transitive build-time packages
(`esbuild`, `workerd`) are not audited here; versions are pinned through
`bun.lock`. No dependency executes in the browser.

**Findings:** none. Re-run the script after any dependency change; it exits
nonzero outside the allowlist so the audit cannot silently rot.
