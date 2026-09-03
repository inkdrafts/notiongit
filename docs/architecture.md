# Architecture

The Worker is deliberately a thin foundation. HTTP handlers translate requests
into application operations; provider clients will contain Notion and GitHub
API code; job orchestration will make provisioning resumable and idempotent;
storage will own KV records; and the UI will contain browser-facing HTML and
assets. These boundaries keep provider details out of routing and keep secrets
server-only.

## Environments and secrets

`wrangler.toml` has separate `staging` and `production` KV and Queue bindings.
Both are created and deployed (2026-09-01) under Cloudflare account
`58fbcc5baba3339f96fe72fe81f5ee6f` (account ID is non-secret configuration,
like the App ID below; never commit an API token), workers.dev subdomain
`notiongit`:

| Environment | Worker name | URL |
| --- | --- | --- |
| staging | `notiongit-staging` | `https://notiongit-staging.notiongit.workers.dev` |
| production | `notiongit` | `https://notiongit.notiongit.workers.dev` |

Each has served `GET /healthz` successfully. Local development uses
Wrangler's local binding emulators instead of these live resources.

The manual Deploy GitHub Action workflow additionally needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, which
are **not yet set** — set them with `gh secret set` (never paste the token
into a commit, issue, or chat) before relying on that workflow; deploying
locally with an authenticated `wrangler` CLI, as done here, does not need
them.

Set secrets with Wrangler; values are never committed or placed in browser code:

```sh
wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging
wrangler secret put GITHUB_CLIENT_ID --env staging
wrangler secret put GITHUB_CLIENT_SECRET --env staging
wrangler secret put NOTION_CLIENT_ID --env staging
wrangler secret put NOTION_CLIENT_SECRET --env staging
```

Repeat for `production`. `.dev.vars.example` contains placeholders only; copy it
to `.dev.vars` for local work if a future handler needs the names.

The GitHub App registration, permission matrix, callback URLs, non-secret App
identity variables, and rotation procedure are maintained in the
[`GitHub App runbook`](github-app-runbook.md). `GITHUB_APP_ID` and
`GITHUB_APP_SLUG` are configuration values; the App private key and OAuth
client secret remain Cloudflare secrets.

The Notion public connection settings, template schema, API-version pin, and
credential rotation procedure are maintained in the
[`Notion integration runbook`](notion-integration-runbook.md) and its
[`sanitized template build sheet`](notion-template.md).

## GitHub Pages provisioning

After the generated repository's `main` commit is readable through the App
installation, the Worker calls the Pages API with `build_type: legacy` and
`source: { branch: main, path: / }`. A `409` is treated as an idempotent
existing-site result: the current site is inspected and updated only when its
source or explicit build type is incompatible. Provider 404, validation,
permission, and rate-limit failures are surfaced as distinct job errors;
network and 5xx failures use a bounded retry. KV stores only Pages status,
URLs, and the desired source metadata.

## Deployment

Run `bun run build` for the dry-run check. The manual Deploy workflow accepts a
staging or production environment and requires the repository's Cloudflare API
token and account ID secrets. Production DNS and OAuth are intentionally outside
this foundation issue.
