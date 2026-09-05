# Launch-gate rehearsal script

How to run the end-to-end rehearsal that gates launch (issue #25). A tester
who did not build the flow drives the product from the landing page to a
published Notion edit on a fresh GitHub account and a fresh Notion
workspace. The organizer prepares the accounts, watches, and records. The
committed report is written from
[`docs/rehearsal-report-template.md`](rehearsal-report-template.md).

Maintainer accounts hide the consent, naming, and first-run assumptions that
define the real non-developer experience, so every step below runs on
accounts with no prior InkDrafts state.

## Roles and rules

- The tester has not seen or built the onboarding flow. During the tester's
  run, nobody else touches the keyboard.
- The organizer records timestamps, screens, and observations. The tester
  thinks aloud; the organizer writes down every moment of confusion, even
  when the tester recovers alone.
- Each account has a named owner. Record who owns each account.
- Do not create the GitHub account by automation. GitHub terms forbid
  bot-created accounts, and the rehearsal must exercise a real signup.
- Credentials stay with the account owner. Never send a password or token to
  anyone, including in the report.
- Get the owner's permission before deleting any test repository or
  workspace.

## Before you start (organizer)

1. Confirm every prerequisite of issue #25 is merged into `main`: #8, #20,
   #21, #22, #23, #24, and #46.
2. Confirm the deployment under test runs that `main`. If unsure, deploy
   `main` first (see [`architecture.md`](architecture.md) for the deploy
   workflow), and record which environment you tested.
3. Open `/healthz` on the deployment and record that it answers.
4. Prepare one fresh GitHub personal account with no repositories, and one
   fresh Notion workspace with no content. The tester signs in to both in
   the browser before starting.
5. Give the tester the landing page URL and nothing else.

## What to record

- A UTC timestamp at every numbered step below.
- Every consent screen: which provider showed it, what permissions it named,
  and what the tester clicked.
- The repository name and site URL chosen in each run.
- The elapsed time from the first publish request to the live site
  answering, and the same for each later sync.
- Every error screen: what it said and what the tester did next.
- Accessibility and mobile observations (see the section below).

When you later write the report, replace every occurrence of a GitHub login
with `USER`, and leave out workspace names and Notion page content. Those
are personal data, and the committed report must not contain them.

## Run A: apex domain branch

The fresh account owns no repositories, so InkDrafts should name the
repository `USER.github.io` and publish at `https://USER.github.io`.

1. Open the landing page. It should read "Write in Notion. Publish a site
   you own." Record the time and the tester's first impression.
2. Choose "Connect GitHub to get started".
3. Approve the GitHub authorization, then install the InkDrafts GitHub App
   when GitHub asks. Record each screen GitHub showed and what it asked for.
4. Wait for the setup page. It should ask to connect Notion.
5. Choose "Connect Notion". When Notion asks for access, deny it. Record the
   error screen: its message and the action it offers. This is the
   rehearsal's one deliberate recoverable failure.
6. Follow the error screen's instruction. Reconnecting GitHub should be
   quick because the grant is remembered. Record whether it was.
7. Choose "Connect Notion" again. This time approve the authorization and
   duplicate the InkDrafts template when Notion offers it. Record each
   screen.
8. The setup page now runs the first sync and publish on its own. While it
   runs, refresh the page once. Record the step it shows after the refresh
   and that no error appears.
9. Wait for "Your site is live". Record the elapsed time since step 7. If
   the page says the site is not up yet, follow its link to re-check and
   record how long the wait was.
10. Open the site link. Confirm it answers and shows template content. Then
    open the repository link and record the repository name. It should be
    `USER.github.io`.

## Publish an edit (run A)

1. In Notion, change the text of the home page and set one Posts entry to
   Published. Record the time.
2. Open "your dashboard" from the success screen. Sign in with GitHub when
   it asks. The page should show the site's sync and publish state and the
   "Leaving InkDrafts" guidance.
3. Choose "Sync now". Wait for the run to finish, using the page's Refresh
   link or the run page on GitHub. Record the elapsed time.
4. Reload the live site. Both edits should appear. Record the result.

## Publish on the schedule (run A)

1. In Notion, make one more edit. Record the time. Do not press "Sync now".
2. Watch for the next scheduled run of `sync-notion.yml` in the repository's
   Actions tab. The workflow tries to run every 10 minutes, but GitHub delays
   scheduled runs under load and can take hours to fire one: a live site
   measured on 2026-09-05 delivered completed runs 3.5 to 4.6 hours apart.
   If no run has started after 30 minutes, choose "Run workflow" on that page
   to trigger one by hand, and record that the scheduled run was late.
3. Reload the live site once the run finishes. The edit should appear.
   Record the elapsed time and whether the scheduled run delivered it or the
   manual run did.

## Disconnect guidance (run A)

Run these last. They end the account's ability to sync, and restoring it
needs a fresh setup.

1. On the dashboard, read the "Leaving InkDrafts" card. Ask the tester to
   say in their own words what each of the three paths does. Record the
   restatements.
2. Revoke the InkDrafts connection in Notion (Settings, then Connections).
   Wait for the next scheduled run in the Actions tab, or choose "Run
   workflow" there if the scheduled run is late. It should fail on invalid
   credentials. Confirm the site itself still answers. Record all three
   observations.
3. Uninstall the InkDrafts GitHub App (GitHub Settings, then Applications,
   then Installed GitHub Apps). Open the dashboard again. It should say the
   InkDrafts App is no longer installed. Confirm the site still answers.
   Record both.

## Run B: project-site branch

A second fresh GitHub personal account proves the naming branch for
accounts whose apex name is taken. The Notion workspace from run A can be
reused; a new authorization duplicates the template again.

1. On the second account, create an empty public repository named
   `USER.github.io`. Any placeholder file inside is fine. This occupies the
   apex name and forces the project-site branch.
2. Run the flow exactly as in run A, without the deliberate failure, the
   disconnect checks, and the scheduled-sync wait.
3. Record the repository name. It should be `USER-inkdrafts`, and the site
   URL should be `https://USER.github.io/USER-inkdrafts`.
4. Click through the site's pages. Styles, links, and images must resolve
   under the subpath. A wrong Jekyll `baseurl` shows up as unstyled pages or
   broken links, so record exactly what you see.

## Accessibility and mobile observations

Run these during the waits in run A. The manual matrix in
[`accessibility.md`](accessibility.md) defines the full bar; record at
least these rows.

- Keyboard only. Unplug the mouse. Tab through every surface the tester
  visited: landing, GitHub and Notion consent, setup, the error screen, the
  success screen, and the dashboard. The skip link must appear first on
  Enter, and every action must be reachable.
- Screen reader, if the organizer has one. Stage changes on the setup page
  must be announced politely once each, and headings must outline the page.
- Reduced motion. Turn on the OS setting; the setup page's pulse animation
  must not run.
- Mobile. On a phone, open the landing page, sign in to the dashboard, press
  "Sync now", and read the live site. Record anything cramped, cut off, or
  unreachable.

## After the rehearsal

1. File one GitHub issue per launch-blocking finding, and one per
   follow-up. Record the links.
2. Copy `docs/rehearsal-report-template.md` to
   `docs/rehearsal-report-launch-gate.md`, fill every section, and apply the
   redaction rules.
3. A second maintainer reviews the committed report. The review confirms
   the gates and hunts for tokens, logins, workspace names, and private
   page content.
4. Link the report on issue #25. The issue closes only when every gate in
   the report passes.
