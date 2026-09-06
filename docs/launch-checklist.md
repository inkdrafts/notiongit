# Launch checklist

The launch gate for the public onboarding (issue #28). The InkDrafts GitHub
App and onboarding are only advertised after every row below carries evidence
and an explicit status, and after the owner has approved the launch and rollback
steps (solo-maintenance amendment, issue #28). A row is PASS with evidence, PENDING with the procedure that
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
bun run scripts/drill-admission-control.ts <staging URL> <staging JOBS namespace id>
git diff --check
```

The drills need Cloudflare credentials from the environment; each script
header states exactly which.

## A. Policies published and reachable before consent

| Item | Evidence | Status |
| --- | --- | --- |
| Privacy policy, Terms of Service, security/data-handling, acceptable use, support, and leaving pages are published by the Worker | `test/policy-pages.test.ts`, `bun run scripts/launch-gate.ts` | PASS |
| Every policy is linked from a consent-adjacent surface: the landing page links all six before the CTA, the Notion consent handoff links the privacy policy, the dashboard's leaving card links the leaving page, and the error page links support | `test/policy-pages.test.ts` (one reachability test per surface) | PASS |
| Policy claims match real retention and token behavior | Retention numbers are computed from `PROVISIONING_JOB_TTL_SECONDS` and `STATUS_SESSION_TTL_SECONDS` in `src/policy-pages.ts`; platform figures (operational logs kept at most three days on the free tier, no aggregates) are pinned by test and documented in [`observability.md`](observability.md#retention) | PASS |
| Policies meet the accessibility bar | axe scan of all six documents in `test/a11y.test.ts` | PASS |
| No policy claims certification or perfect security | `test/policy-pages.test.ts` ("no policy claims certification or perfect security") | PASS |
| Owner decisions the pages cannot invent are confirmed: the operator or legal entity behind InkDrafts for the Terms page, governing-law wording, and a content-report path | Owner defaults approved on [issue #88](https://github.com/inkdrafts/notiongit/issues/88) (2026-09-05): the Terms page names InkDrafts as a free open-source project maintained by @leandro-llosa with no legal entity behind it, governing law is the laws of the United States with no venue named, users must be at least 13, and violations are reported through GitHub issues on the public repository with no email published. Implemented in `src/policy-pages.ts` and pinned by `test/policy-pages.test.ts`; a professional counsel read is optional for this free, non-commercial profile per the owner's recorded posture on the issue | PASS |

## B. URL, branding, and callback verification

`bun run scripts/launch-gate.ts` checks what is publicly reachable. Recorded
runs (2026-09-05):

| Run | Result | Reading |
| --- | --- | --- |
| Against current code served locally | 13/14. The one failure is the callback route answering 500 with the error page, which is what an unconfigured environment returns; a deployed Worker with its secrets returns 400 for the same request | The code under review passes every URL check it can answer |
| Against production (`notiongit.notiongit.workers.dev`), 2026-09-05 after the deploy below | 14/14 — the first full-green production run. Until this deploy, production ran the 2026-09-01 foundation deploy and scored 5/14 | Production serves current code; what remains is the custom domain and the provider callback re-registration |
| Against staging (`notiongit-staging.notiongit.workers.dev`), 2026-09-05 | 14/14, including the callback-route check the local run cannot answer | Current `main` passes every URL check when the environment carries its secrets. The staging deploy ran the same configuration shape `wrangler.toml` has since the 2026-09-05 free-tier decision |

| Item | Evidence | Status |
| --- | --- | --- |
| InkDrafts GitHub App is public and resolvable at its install URL | launch-gate run: `https://github.com/apps/inkdrafts` answers 200 (ADR 0003 made the App public; the launch moment is advertising it, not a visibility change) | PASS |
| The three technical repositories are public | launch-gate run: notiongit, notiongit-template, notiongit-sync all answer 200 | PASS |
| OAuth callback URLs registered at GitHub and Notion match the final production domain | Owner registered `https://inkdrafts.com/auth/github/callback` on the GitHub App and `https://inkdrafts.com/auth/notion/callback` on the Notion integration, 2026-09-05, keeping the workers.dev URLs as fallbacks. Caveat from the first real install attempt ([#92](https://github.com/inkdrafts/notiongit/issues/92)): on the GitHub App, `https://inkdrafts.com/auth/github/callback` must be the **first** entry in the Callback URL list — GitHub's post-install redirect lands on the first entry, and a staging-first order fails state verification with `github_state_invalid` | PASS (one dashboard check pending: confirm the entry order) |
| Provider branding (App name, description, homepage) reads correctly on the install page | Homepage on `https://github.com/apps/inkdrafts` links `https://inkdrafts.com/` (verified 2026-09-05); owner set it during the callback registration | PASS |

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
| Incident drill: kill switch exercised in staging | `bun run scripts/drill-admission-control.ts` against staging, 2026-09-05: 6/6 steps. Baseline admits (302 to github.com); `kill` refuses with 503 `provisioning_rejected` and writes a `global_kill` audit record; `pause` holds with 503 `provisioning_paused` and a `global_pause` audit record; resume with `active` admits again | PASS |
| Incident drill: alert path exercised | **Waived 2026-09-05, owner decision**: the Analytics Engine dataset, its alert check, and the drill were removed from the codebase so the project runs entirely on the Cloudflare free tier. Incident triage uses free Workers Logs and the dead-letter queue ([`observability.md`](observability.md)); the design survives in ADR 0004 and git history if it is ever wanted again | WAIVED |

## D. Provider and funnel verification

| Item | Evidence | Status |
| --- | --- | --- |
| Rate-limit budgets inside GitHub's app-wide secondary limits | `wrangler.toml`: 30 mutations/min and 240/hour configured against GitHub's ~80/min and ~500/hour (GitHub's documented secondary rate limits, docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api); `provisioningThrottleConfig` clamps operator values to ceilings inside those bounds; `test/provisioning-throttle.test.ts` pins the clamps | PASS |
| Abuse admission controls active | `PROVISIONING_CONTROL_MODE=active` in every environment; per-account, burst, and identity-cooldown limits configured; `test/provisioning-throttle.test.ts` | PASS |
| Observability events, alerts, and dashboards operational | [`observability.md`](observability.md) | PASS for event logging (Workers Logs, 3-day retention); alerting is WAIVED per §C |
| Fresh-account rehearsal evidence exists | The script and report template exist ([`rehearsal-script.md`](rehearsal-script.md)), but issue #25 was closed on the committable half only: **the live rehearsal has not run**. Run it per the script and commit the redacted report as `docs/rehearsal-report-launch-gate.md` | PENDING |
| No open launch-blocking issues | Sweep open issues labeled `launch-blocker` (or all open issues) at approval time | PENDING |

## E. Production environment and DNS

| Item | Evidence | Status |
| --- | --- | --- |
| Deploy merged `main` to production | Deployed 2026-09-05 from the `remove-analytics-engine` tree (version `c6c14632`, redeployed as `dd4fe5ce` with the observability block pinned) and again from the `fix/github-state-expiry-and-https` tree (version `7dcfaf6d`, the #92 fix) with the account's Cloudflare identity; no paid plan involved since the Analytics Engine bindings are gone. The repository deploy secrets are still unset, so the manual Deploy workflow cannot run until `gh secret set` supplies them | PASS |
| `inkdrafts.com` serves the Worker | Owner attached the custom domain 2026-09-05; `https://inkdrafts.com/healthz` answers `{"ok":true}` and the landing serves | PASS |
| Plaintext HTTP is redirected to HTTPS | The Worker answers any `http://` request with a 301 to the same https URL, ahead of every route (`http://inkdrafts.com/healthz` → 301, verified 2026-09-05). This does not depend on the zone's Always Use HTTPS toggle, which deploy automation cannot set; enabling that toggle remains optional belt-and-suspenders | PASS |
| Full launch-gate run is green against the final production domain | `bun run scripts/launch-gate.ts https://inkdrafts.com`: **14/14** on 2026-09-05 | PASS |
| Production OAuth/install/provisioning smoke test | Repeat a real onboarding on a fresh account per [`rehearsal-script.md`](rehearsal-script.md) run A, after the deploy and DNS rows | PENDING |

## F. Launch decision

| Item | Evidence | Status |
| --- | --- | --- |
| The owner approves launch and rollback steps (solo-maintenance amendment recorded on issue #28; the fresh-eyes tester from #87 carries the independent review) | Names and dates recorded in the launch report on this issue; approval happens only when every row above is PASS or WAIVED | PENDING |
| Direct install / onboarding link published without Marketplace listing | The landing page CTA already goes through `/connect/github`; the launch step is announcing the onboarding URL. Marketplace listing stays out of scope | PENDING |
| Post-launch monitoring and rollback plan in force | [`post-launch.md`](post-launch.md) | PASS (plan committed; monitoring enablement rows inside it are PENDING) |
| Post-launch smoke test succeeds after the App goes live | One fresh-account onboarding within 24 hours of launch, recorded on this issue | PENDING |

## Waivers

None. When a waiver is granted, record the item, the reason, why it is not
critical, and the two approving maintainers here.
