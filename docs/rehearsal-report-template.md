# Launch-gate rehearsal report

Fill one copy per rehearsal from
[`docs/rehearsal-report-template.md`](rehearsal-report-template.md). Copy
this file to `docs/rehearsal-report-launch-gate.md`, fill every section, and
apply the redaction rules from the script before committing. Replace every
GitHub login with `USER`, and leave out tokens, workspace names, and Notion
page content.

## Rehearsal facts

- Date:
- Environment tested (production or preview URL):
- Deployment revision, if known:
- Tester (the person who drove the flow; did not build it):
- Organizer (the person who recorded):
- Account owners:
- Script version (commit that the report was written from):

## Gates

A gate passes only on direct observation during the rehearsal. The
rehearsal, and with it issue #25, closes only when every gate passes.

| # | Gate | Result | Evidence |
| --- | --- | --- | --- |
| G1 | A fresh tester reached a live site without developer intervention | | Timeline rows |
| G2 | The tester published a Notion edit with "Sync now" and saw it live, without developer intervention | | Elapsed time and site check |
| G3 | A scheduled sync published a further edit with no manual step | | Actions tab and site check |
| G4 | One recoverable failure was recovered by the tester following the on-screen copy alone | | Error screen record |
| G5 | Refreshing during provisioning returned the current step without an error | | Refresh record |
| G6 | Both naming branches passed: `USER.github.io` and `USER-inkdrafts`, styles and links included | | Repository and site URLs |
| G7 | The disconnect guidance was present, restated correctly by the tester, and matched observed behavior | | Restatements and revocation checks |
| G8 | Every launch-blocking finding is fixed or has a filed, linked issue; no unexplained workaround remains | | Findings table |
| G9 | This report contains no tokens, personal identifiers, or private content | | Redaction checklist |

## Timeline

UTC for every row.

| Time | Step | Observed |
| --- | --- | --- |
| | | |

## Consent inventory

One row per screen the provider showed.

| Provider | Screen and what it asked | Tester action |
| --- | --- | --- |
| | | |

## Confusion and errors

One row per moment, including recovered ones.

| Step | What happened | How it resolved | Finding link |
| --- | --- | --- | --- |
| | | | |

## Accessibility and mobile

One bullet per row of the manual matrix in
[`accessibility.md`](accessibility.md), plus anything the mobile pass
surfaced. Write "not run" where a row was skipped, and say why.

## Findings

| Finding | Severity (launch-blocking, follow-up, note) | Issue link |
| --- | --- | --- |
| | | |

## Redaction checklist

- No tokens, passwords, or client secrets.
- No GitHub logins; every URL and repository name uses `USER`.
- No Notion workspace names.
- No Notion page titles, row content, or text from the tester's edits.
- Screenshots excluded, or redacted to the same standard.

Reviewed by (second maintainer):
