# Progress surface

After a user authorizes both providers, provisioning runs in the background
and the user watches it on the progress surface: a page at `/progress` whose
inline script (the only client JavaScript in the project) re-fetches
`/progress/status` every 5s — backing off to 60s when nothing changes,
pausing while the tab is hidden, and stopping at terminal statuses — plus two
JSON endpoints, `/progress/status` (the projection the page renders from)
and `/progress/site-check` (a one-shot reachability probe for a succeeded
site). Without JavaScript the page still renders with a manual reload link.
The job id in the URL is the bearer capability.

Locally no ProvisioningJob can exist — creating one requires the real GitHub
and Notion callbacks — so this feature proves the surface's contracts for
absent, malformed, and unknown ids; the known-job render is proven on a real
deployment by the [site setup](./site-setup.md) driver and was last proven on
production on 2026-09-06 (an `awaiting_notion → active → succeeded` run
whose succeeded page shows the live site link).

## Sub-features

- `progress-status-missing` answers a well-formed unknown `job_id` with HTTP
  200 and a `"status":"missing"` projection that offers the restart URL.
- `progress-status-malformed` answers an id outside
  `[A-Za-z0-9_-]{1,128}` with HTTP 400 `invalid_job_id`.
- `progress-page-missing` renders the missing-job page for an unknown id with
  HTTP 404 (same content, different status than the JSON endpoint).
- `progress-site-check-gated` answers `site-check` for any job that is not
  succeeded with HTTP 404 `{"error":"not_found"}` and performs no probe.
- `progress-status-lifecycle` — the projection's full status set is
  `missing`, `awaiting_notion` (GitHub done, waiting for the Notion
  consent), `active` (queued to the provisioning queue; carries
  `pollAfterSeconds`), `succeeded`, and `failed` (the `dead_letter` terminal
  state reports as failed too).
- `progress-page-known` renders a real job as a seven-stage checklist —
  Connect GitHub, Create your repository, Connect Notion, Prepare site
  settings, Enable publishing, Copy your content, Publish your site — with
  Done/In progress/Waiting words, then links the live site on success;
  proven on staging/production, recorded as a skip locally.

## How to get to it (user POV)

- The OAuth callbacks redirect the user to `/progress?job_id=...`; the link
  is the only capability a user needs.
- The page updates itself while the setup runs ("You can leave this page
  open"); a succeeded job gains an explicit `?check=1` retry link that runs
  the one-shot site probe.

## Driving it with curl and the Playwright driver

Preconditions:

- The verification instance passes the doctor (`../SKILL.md`).
- `$BASE` is `https://127.0.0.1:$PORT` (launched with `--local-protocol
  https`; curl needs `-k`).
- `$ID` is a well-formed id the instance has never seen, e.g.
  `verify-missing-$(date +%s)`.

- **JSON projection for an unknown job.** Run
  `curl -sk -w "\n%{http_code}\n" "$BASE/progress/status?job_id=$ID"`.
  Expect HTTP `200` and JSON whose `progress.status` is `"missing"`, whose
  `progress.restartUrl` is `"/connect/github"`, and whose message reads
  `We could not find a site setup in progress for this link.`
- **Malformed id is refused.** Run
  `curl -sk -w "\n%{http_code}\n" "$BASE/progress/status?job_id=bad/id"`.
  Expect HTTP `400` and `{"error":"invalid_job_id"}`.
- **Page for an unknown job.** Run
  `curl -sk -o "$ART_DIR/progress/missing-page.html" -w "%{http_code}\n" "$BASE/progress?job_id=$ID"`.
  Expect HTTP `404` with an HTML page whose copy presents the job as gone —
  the same page a bookmark of an expired job gets.
- **Site check stays gated.** Run
  `curl -sk -w "\n%{http_code}\n" "$BASE/progress/site-check?job_id=$ID"`.
  Expect HTTP `404` and `{"error":"not_found"}`. This must be quick: the
  gate means no probe ran.
- **Browser drive.** The driver's `progress-missing` check loads the
  unknown-job page in real Chrome, asserts the 404 status, the rendered
  missing-job copy, and the 400 on a malformed `/progress/status` id, saving
  `e2e/progress/progress-missing.png`.
- **Proof.** Save the bodies and status lines under `progress/`. The
  unknown-id projection, the 404 page, and the gated probe together are the
  observable state of the surface without a real job.

## Gotchas

- The two endpoints disagree on failure status **by design**: JSON status is
  200-with-`missing` (it feeds the page's render), the page itself is 404,
  and `site-check` is 404-JSON. Assert each against its own contract, not
  against each other.
- `missing` is the correct local result for any id — including one minted by
  `connect/github` earlier in the same run (the durable job row appears only
  after the real GitHub callback).
- `?check=1` on the page only probes a **succeeded** job; with no job it
  renders the same missing page without probing. Do not use it to prove
  reachability locally.
- The probed URL in a real site check comes from the job record, never from
  the request — a changed `job_id` cannot redirect the probe.
- The page is **not** static: it embeds a snapshot and polls the status
  endpoint every 5s from JavaScript (backing off to 60s, pausing when
  hidden, stopping when terminal). A screenshot taken right after load can
  lag the projection by one poll — prefer the JSON endpoints for assertions.
- The known-job render's stage list doubles as the real onboarding order:
  the repository is created (or reused) **during the GitHub callback**, so
  "Create your repository" can read Done while the user is still on the
  Notion leg.
