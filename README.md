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

The Worker entrypoint is [`src/index.ts`](src/index.ts). It exposes
`GET /healthz`, starts the GitHub App flow at `GET /connect/github?job_id=...`,
and handles the signed callback at `GET /auth/github/callback`. The callback
exchanges the OAuth code server-side, verifies that the authenticated personal
account owns the installation, and stores only GitHub identity and installation
metadata in `JOBS`; OAuth and installation tokens are never persisted or
returned to browser code. It also wires the `PROVISIONING_QUEUE` Queue binding.

`/connect/github` accepts an optional `job_id` (or `jobId`) and generates one
when omitted. The signed state expires after ten minutes and is marked consumed
after a successful callback, so a callback URL cannot be reused for a second
authorization.

Before a real deployment, replace the KV placeholder in `wrangler.toml` with
the namespace ID returned by Wrangler and create the provisioning queues. The
staging and production bindings are intentionally separate. See
[`docs/architecture.md`](docs/architecture.md) for environment setup, secret
names, and the deployment workflow.

The GitHub App settings, least-privilege permission matrix, callback URLs, and
credential rotation procedure are documented in
[`docs/github-app-runbook.md`](docs/github-app-runbook.md).

The Notion OAuth template-duplication spike is documented in
[`spikes/notion-oauth-template/README.md`](spikes/notion-oauth-template/README.md), and
the Notion onboarding decision is recorded in
[`docs/decisions/0002-notion-onboarding.md`](docs/decisions/0002-notion-onboarding.md).
The production Notion connection and sanitized template build sheet are
documented in [`docs/notion-integration-runbook.md`](docs/notion-integration-runbook.md)
and [`docs/notion-template.md`](docs/notion-template.md).
