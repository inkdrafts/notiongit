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

The Worker entrypoint is [`src/index.ts`](src/index.ts). It currently exposes
`GET /healthz` and wires the `JOBS` KV namespace and `PROVISIONING_QUEUE` Queue
bindings. OAuth and provisioning routes will be added in subsequent issues.

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
