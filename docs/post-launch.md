# Post-launch monitoring and rollback plan

What runs after the launch gate opens, who looks at what, and what to do when
a signal fires. The launch decision rows live in
[`launch-checklist.md`](launch-checklist.md) §F; this document is the plan
those rows put in force.

## Daily posture, first two weeks

1. **Funnel health.** Run the funnel query
   ([`observability.md`](observability.md#dashboard-queries), "Dead letters"
   section): `consent_started` through `job_succeeded` and
   `job_dead_lettered` over 24 hours. The number that matters is the gap
   between jobs queued and jobs succeeded plus dead-lettered.
2. **Dead letters.** Any `job_dead_lettered` is one user whose site never
   published. Triage per [`observability.md`](observability.md#incident-triage)
   §Incident triage, step by step, starting from the `jobId`.
3. **Alerts.** None. The Analytics Engine alert path was removed with the
   2026-09-05 free-tier decision; triage starts from Workers Logs and the
   dead-letter queue ([`observability.md`](observability.md)).
4. **Provider status.** GitHub and Notion incidents masquerade as funnel
   failures. Check provider status pages before changing anything
   (admission-runbook "Roll back safely", step 3).

## Enablement

These steps happen at launch; each is pending in the checklist until done:

- [ ] Deploy merged `main` to production (#86) and confirm the funnel's
      `job_queued` through `job_succeeded` lines reach Workers Logs.

## Rollback ladder

Escalate one rung at a time; de-escalate in reverse.

1. **One stage misbehaving.** Pause that stage with an `active` control and
   `pausedStages` (admission runbook). New work refuses at that stage; queued
   work parks before its next provider call.
2. **Funnel-wide problem.** `pause` everything. Queued jobs resume from their
   recorded step when cleared; nothing re-runs.
3. **Provider harm or active abuse.** `kill`. Every provisioning stage
   refuses before minting a token or calling a provider. Deployed sites are
   unaffected because their syncs run in the users' own repositories.
4. **Bad deploy.** `wrangler rollback` to the previous Worker version. KV
   records are versioned and step-gated, so a rolled-back Worker resumes
   cleanly against records written by a newer one (schema version field on
   every record).
5. **Data poisoning (compromised control record).** Delete
   `provisioning:admission:control` and set `PROVISIONING_CONTROL_MODE` in
   `wrangler.toml` to hold the default across KV loss (runbook "Resume
   provisioning").

Never, at any rung, delete user repositories or revoke user tokens from the
operator side; disconnect is the user's action, documented on `/leaving`.

## First-incident checklist

1. Kill or pause per the ladder above.
2. Triage from a `jobId` (observability §Incident triage); if an alert
   started it, convert the alert to job ids first (Workers Logs filter).
3. Note the admission audit records for the window
   (`provisioning:admission:audit:*`, seven-day retention).
4. File or update a GitHub issue with the funnel numbers and the timeline;
   redact per the rehearsal report's rules (no logins, no workspace names).
5. When providers are healthy again, clear the control and verify one paused
   job advances from its recorded step before declaring recovery.

## Standing review

After the first two weeks, drop to weekly: the funnel query, dead-letter
triage, and a skim of the admission audit records. Re-run
`bun run scripts/launch-gate.ts` after any change to routes or the policy
pages, and `bun run scripts/license-audit.ts` after any dependency change.
