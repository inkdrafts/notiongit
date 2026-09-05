# Launch checklist

The launch gate for the public onboarding (issue #28). The InkDrafts GitHub
App and onboarding are only advertised after every row below carries evidence
and an explicit status, and after two maintainers have approved the launch and
rollback steps. A row is PASS with evidence, PENDING with the procedure that
completes it, or WAIVED with a written, non-critical reason. No launch with
an open critical or high security finding.

Re-run the automated evidence any time:

```sh
bun test
bun run typecheck
bun run build
bun run scripts/launch-gate.ts                       # against production
bun run scripts/launch-gate.ts http://127.0.0.1:8787 # against a deployment
bun run scripts/license-audit.ts
git diff --check
```

## A. Policies published and reachable before consent

| Item | Evidence | Status |
| --- | --- | --- |
| Privacy policy, Terms of Service, security/data-handling, acceptable use, support, and leaving pages are published by the Worker | `test/policy-pages.test.ts`, `bun run scripts/launch-gate.ts` | PASS |
| Every policy is linked from the landing page before the consent CTA, from the Notion consent handoff, from the dashboard, and from the error page | `test/policy-pages.test.ts` ("links every policy before the consent CTA", "the Notion consent handoff links the privacy policy") | PASS |
| Policy claims match real retention and token behavior | Retention numbers are computed from `PROVISIONING_JOB_TTL_SECONDS` and `STATUS_SESSION_TTL_SECONDS` in `src/policy-pages.ts`; platform figures (three months of aggregates, at most seven days of logs) are pinned by test and documented in [`observability.md`](observability.md#retention) | PASS |
| Policies meet the accessibility bar | axe scan of all six documents in `test/a11y.test.ts` | PASS |
| No policy claims certification or perfect security | `test/policy-pages.test.ts` ("no policy claims certification or perfect security") | PASS |

## B. URL, branding, and callback verification

`bun run scripts/launch-gate.ts` checks what is publicly reachable. Recorded
runs (2026-09-05):

| Run | Result | Reading |
| --- | --- | --- |
| Against current code served locally | 13/14. The one failure is the callback route answering 500 with the error page, which is what an unconfigured environment returns; a deployed Worker with its secrets returns 400 for the same request | The code under review passes every URL check it can answer |
| Against production (`notiongit.notiongit.workers.dev`) | 5/14. healthz, the public App, and the three repositories pass. The landing page, policies, and callback checks fail because production runs the 2026-09-01 foundation deploy and has not received any code since | **Production is stale.** Deploy merged `main` (with this PR) before any launch step, then re-run for the full 14/14 |

| Item | Evidence | Status |
| --- | --- | --- |
| InkDrafts GitHub App is public and resolvable at its install URL | launch-gate run: `https://github.com/apps/inkdrafts` answers 200 (ADR 0003 made the App public; the launch moment is advertising it, not a visibility change) | PASS |
| The three technical repositories are public | launch-gate run: notiongit, notiongit-template, notiongit-sync all answer 200 | PASS |
| OAuth callback URLs registered at GitHub and Notion match the final production domain | Recheck in the GitHub App settings and the Notion integration settings after the DNS row in E lands. Current registrations point at the workers.dev origin | PENDING |
| Provider branding (App name, description, homepage) reads correctly on the install page | Manual check of `https://github.com/apps/inkdrafts` after deploy | PENDING |

## C. Final reviews

The five reviews live in [`launch-gate-reviews.md`](launch-gate-reviews.md),
each with its evidence. The dependency/license audit is automated:

| Item | Evidence | Status |
| --- | --- | --- |
| Least-privilege review of App and integration permissions | Reviews doc §1 | PASS |
| Secret and rotation review | Reviews doc §2 | PASS |
| Dependency and license audit | `bun run scripts/license-audit.ts`: 10/10 direct dependencies inside the permissive allowlist (ISC, MIT, MPL-2.0, MIT OR Apache-2.0) | PASS |
| Threat-model review | Reviews doc §3 | PASS |
| Backup and rollback review | Reviews doc §4 | PASS |
| Incident drill: kill switch exercised in staging | [`provisioning-admission-runbook.md`](provisioning-admission-runbook.md) is the drill script; run it against staging and record the observed pause, refusal, and resume | PENDING |
| Incident drill: alert path exercised | [`observability.md`](observability.md#manual-verification-follow-up) §Manual verification follow-up is the drill script; verify the SQL row shape, fire a synthetic threshold, and record the webhook delivery | PENDING |

## D. Provider and funnel verification

| Item | Evidence | Status |
| --- | --- | --- |
| Rate-limit budgets inside GitHub's app-wide secondary limits | `wrangler.toml`: 30 mutations/min and 240/hour configured against GitHub's ~80/min and ~500/hour; `provisioningThrottleConfig` clamps operator values to ceilings inside those bounds; `test/provisioning-throttle.test.ts` pins the clamps | PASS |
| Abuse admission controls active | `PROVISIONING_CONTROL_MODE=active` in every environment; per-account, burst, and identity-cooldown limits configured; `test/provisioning-throttle.test.ts` | PASS |
| Observability events, alerts, and dashboards operational | [`observability.md`](observability.md) | PASS for the event sinks and queries; alerting is PENDING on the drill in §C |
| Fresh-account rehearsal evidence exists | The script and report template exist ([`rehearsal-script.md`](rehearsal-script.md)), but issue #25 was closed on the committable half only: **the live rehearsal has not run**. Run it per the script and commit the redacted report as `docs/rehearsal-report-launch-gate.md` | PENDING |
| No open launch-blocking issues | Sweep open issues labeled `launch-blocker` (or all open issues) at approval time | PENDING |

## E. Production environment and DNS

| Item | Evidence | Status |
| --- | --- | --- |
| Deploy merged `main` to production | `bun run build` dry-run passes; the manual Deploy workflow needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, which are **not yet set** (`gh secret set`, never commit them) | PENDING |
| `inkdrafts.com` serves the Worker | Custom-domain routing is configured in the Cloudflare dashboard, not in `wrangler.toml`; after DNS, `https://inkdrafts.com/healthz` must answer. Until then production is `https://notiongit.notiongit.workers.dev` | PENDING |
| Full launch-gate run is green against the final production domain | `bun run scripts/launch-gate.ts https://inkdrafts.com` (or the workers.dev origin if launch precedes DNS) after the deploy row passes | PENDING |
| Production OAuth/install/provisioning smoke test | Repeat a real onboarding on a fresh account per [`rehearsal-script.md`](rehearsal-script.md) run A, after the deploy and DNS rows | PENDING |

## F. Launch decision

| Item | Evidence | Status |
| --- | --- | --- |
| Two authorized maintainers approve launch and rollback steps | Names and dates recorded in the launch report on this issue; approval happens only when every row above is PASS or WAIVED | PENDING |
| Direct install / onboarding link published without Marketplace listing | The landing page CTA already goes through `/connect/github`; the launch step is announcing the onboarding URL. Marketplace listing stays out of scope | PENDING |
| Post-launch monitoring and rollback plan in force | [`post-launch.md`](post-launch.md) | PASS (plan committed; monitoring enablement rows inside it are PENDING) |
| Post-launch smoke test succeeds after the App goes live | One fresh-account onboarding within 24 hours of launch, recorded on this issue | PENDING |

## Waivers

None. When a waiver is granted, record the item, the reason, why it is not
critical, and the two approving maintainers here.
