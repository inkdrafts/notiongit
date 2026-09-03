# notiongit
Notion + Git deployment service: provisions a Notion-powered Jekyll site into a user's own GitHub Pages. Powers inkdrafts.com

## Development

Install dependencies and run the repository checks from the root with
[Bun](https://bun.sh):

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

The initial Cloudflare Workers sealed-box experiment is documented in
[`spikes/libsodium-workers/README.md`](spikes/libsodium-workers/README.md), and
the hosting decision is recorded in
[`docs/decisions/0001-sealed-box-on-workers.md`](docs/decisions/0001-sealed-box-on-workers.md).

The Worker entrypoint is [`src/index.ts`](src/index.ts). `GET /` serves the
public landing page ([`src/landing-page.ts`](src/landing-page.ts)): a
self-contained, server-rendered document with no client JavaScript and no
external requests (fonts, scripts, or images), so its core content and the
single `/connect/notion` call to action work with JavaScript disabled. It
explains what InkDrafts creates, owns, and costs; the real three-stage
onboarding flow and why each provider's permissions are requested; and
privacy/security notes and links to the three public repositories. It
deliberately never links `/connect/github` or the App install page — the
GitHub App stays unadvertised from inkdrafts.com until the M5 launch issue
(see [`docs/github-app-runbook.md`](docs/github-app-runbook.md)). It also
exposes
`GET /healthz`, starts Notion-first onboarding at `GET /connect/notion?job_id=...`,
and handles the signed Notion callback at `GET /auth/notion/callback`. The Notion
callback exchanges the code server-side and, while the access token is still
request-local, resolves the duplicated template root into the Pages and Posts
database IDs (see below); it returns only a redacted authorization summary. It
also starts the GitHub App
flow at `GET /connect/github?job_id=...`, whose signed callback
exchanges the OAuth code server-side, verifies that the authenticated personal
account owns the installation, selects a collision-safe repository destination,
and generates that repository from `inkdrafts/notiongit-template` — the only
part of provisioning that needs the short-lived OAuth token in memory. It then
persists a durable `ProvisioningJob` record and enqueues it on
`PROVISIONING_QUEUE`, responding `202` with only the GitHub identity and
repository destination known so far. Everything after that — verifying the
generated repository, enabling legacy GitHub Pages from `main:/`, dispatching
the generated repository's own Notion sync workflow and waiting for it to
complete, then waiting for the matching Pages build and confirming the public
site actually answers — runs as durable, independently retriable steps in the
provisioning queue consumer, implemented in
[`src/provisioning-job.ts`](src/provisioning-job.ts),
[`src/provisioning-steps.ts`](src/provisioning-steps.ts), and
[`src/provisioning-queue.ts`](src/provisioning-queue.ts). The job record
stores only GitHub identity, installation, destination, generated-repository
metadata, non-secret Pages status/URL metadata, and non-secret sync/deployment
progress (run id and URL, conclusion, commit sha, build id and status) in
`JOBS`; OAuth and installation tokens are never persisted or returned to
browser code — every queue step mints its own installation token from the
job's durable installation id (see
[`src/github-app-auth.ts`](src/github-app-auth.ts)) and discards it when the
step returns. See [`docs/architecture.md`](docs/architecture.md) for the full
job schema, locking, retry/dead-letter behavior, and sequence.

The sync dispatch and deploy-verification provider calls are implemented in
[`src/notion-sync.ts`](src/notion-sync.ts) and
[`src/site-deployment.ts`](src/site-deployment.ts). `workflow_dispatch` never
returns a run id, so the dispatched run is correlated by snapshotting the
workflow's run ids immediately before dispatch and adopting the first new
`workflow_dispatch` run created afterward; that correlation is persisted
before the queue step waits on it, so a retry resumes polling the same run
instead of dispatching a duplicate. Once the run completes, the queue waits
for the Pages build matching the resulting commit and then the public URL
itself, since a build finishing does not guarantee the CDN in front of it
already serves the new content. Workflow failure, Pages build failure,
polling timeout, and unreachable-URL propagation each surface as a distinct
step error, classified as retryable or terminal by
[`src/provisioning-queue.ts`](src/provisioning-queue.ts).

Template resolution is implemented in [`src/notion-template.ts`](src/notion-template.ts).
The duplicated root page is walked breadth-first through its paginated block
children (descending into sub-pages within a depth budget, since a user may
move the databases after duplication), and each `child_database` block — whose
block id *is* the database id — is fetched and matched against the Pages and
Posts schema fingerprints from
[`docs/notion-template.md`](docs/notion-template.md): required property names
*and* Notion property types, never titles, so renaming either database does
not break resolution. A freshly duplicated page can briefly serve empty or
partial content, so propagation-shaped outcomes (an empty root, or candidate
databases that still 404) are retried with bounded backoff — honoring Notion's
`Retry-After` — inside the callback request. Every other failure is distinct
and actionable: `notion_template_database_missing` (databases exist but one
role matches nothing), `notion_template_database_ambiguous` (a fingerprint
matched more than one database, or a database matched both — never guessed),
`notion_template_not_duplicated` (the authorization used manual page selection;
the programmatic-creation fallback of ADR 0002 §2 is future work),
`notion_template_root_unavailable`, `notion_template_root_empty`,
`notion_template_schema_invalid`, and `notion_template_unavailable`. A
successful resolution then validates every required property consumed by the
sync engine, checks its required select values (`Published` and all supported
Pages `Type` values), and checks optional fallback fields when they are
present. Missing fields, wrong types, and unsupported options are returned per
database with plain-language remediation. The normalized database IDs and
non-secret validated schema summary are persisted under
`notion:template-resolution:<job id>` in `JOBS`; `/connect/github` refuses to
start until that record exists and still validates. The access token is never
persisted, and page content (titles, rows, text) is never read.

`/connect/notion` accepts an optional `job_id` (or `jobId`) and generates one
when omitted. `/connect/github` requires the job id from a successful Notion
validation. Both signed states expire after ten minutes and are replay-tracked
in KV. Notion additionally binds the state to an HttpOnly, Secure, SameSite
cookie. Neither flow stores OAuth codes or user tokens.

Repository naming is deterministic. InkDrafts first tries the exact lowercase
`<login>.github.io` repository, which maps to `https://<login>.github.io` with
an empty Jekyll `baseurl`. If that name is occupied, it tries the project-site
sequence `<login>-inkdrafts`, `<login>-inkdrafts-2`, and so on, mapping each to
`https://<login>.github.io/<repository>` with `baseurl: /<repository>`.

Generation is implemented in [`src/repository-generation.ts`](src/repository-generation.ts),
and Pages reconciliation is implemented in [`src/github-pages.ts`](src/github-pages.ts).
Generation happens inside the callback while the short-lived user access token
is still in memory, because creating a repository from a template requires
user-to-server authentication; the call sets public visibility and the product
description `Notion-powered site published with InkDrafts`. That description is
also the idempotency marker: a retry that finds an owned non-fork repository
carrying it adopts that repository instead of creating a duplicate, and a `422`
name collision first checks whether the occupier is InkDrafts' own before
advancing to the next deterministic name. Timeout, rate limit, exhausted
names, and unavailability surface as distinct JSON errors from the callback,
each resumable by restarting the flow. Once GitHub returns the repository,
the queue's first step (`verify_repository`) verifies it with a freshly minted
installation token — polling with exponential backoff until `main` reports a
readable initial commit — so success also proves the App installation
received the repository.

Before a real deployment, replace the KV placeholder in `wrangler.toml` with
the namespace ID returned by Wrangler and create the provisioning queues named
in `wrangler.toml`, including each environment's dead-letter queue (for
example, `wrangler queues create notiongit-provisioning-dlq`). The staging and
production bindings are intentionally separate. See
[`docs/architecture.md`](docs/architecture.md) for environment setup, secret
names, and the deployment workflow.

The GitHub App settings, least-privilege permission matrix, callback URLs, and
credential rotation procedure are documented in
[`docs/github-app-runbook.md`](docs/github-app-runbook.md).

The read-only development-repository Pages acceptance check is opt-in:

```sh
GITHUB_PAGES_INTEGRATION_REPOSITORY=OWNER/REPO \
GITHUB_PAGES_INTEGRATION_TOKEN=... bun run test:pages-integration
```

It verifies that the repository reports `main:/` and legacy Pages without
changing it.

The read-only template-resolution acceptance check against a disposable
development workspace is opt-in the same way:

```sh
NOTION_TEMPLATE_INTEGRATION_TOKEN=secret_... \
NOTION_TEMPLATE_INTEGRATION_ROOT=<duplicated root page id> \
bun run test:notion-template-integration
```

It resolves the duplicated template root through the live Notion API and
asserts the Pages and Posts database IDs and schema fingerprints — it only
reads, and prints no IDs or token. Prepare the workspace by authorizing the
development connection and choosing "Duplicate template" (the duplicated root
id is the token response's `duplicated_template_id`), or by duplicating the
public template manually and sharing the copy with the integration.

The Notion OAuth template-duplication spike is documented in
[`spikes/notion-oauth-template/README.md`](spikes/notion-oauth-template/README.md), and
the Notion onboarding decision is recorded in
[`docs/decisions/0002-notion-onboarding.md`](docs/decisions/0002-notion-onboarding.md).
The production Notion connection and sanitized template build sheet are
documented in [`docs/notion-integration-runbook.md`](docs/notion-integration-runbook.md)
and [`docs/notion-template.md`](docs/notion-template.md).
