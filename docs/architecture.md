# Architecture

The Worker is deliberately a thin foundation. HTTP handlers translate requests
into application operations; provider clients will contain Notion and GitHub
API code; job orchestration will make provisioning resumable and idempotent;
storage will own KV records; and the UI will contain browser-facing HTML and
assets. These boundaries keep provider details out of routing and keep secrets
server-only.

## Environments and secrets

`wrangler.toml` has separate `staging` and `production` KV and Queue bindings.
Create the namespaces and queues before deploying, then replace the placeholder
KV IDs. Local development uses Wrangler's local binding emulators.

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

## Deployment

Run `bun run build` for the dry-run check. The manual Deploy workflow accepts a
staging or production environment and requires the repository's Cloudflare API
token and account ID secrets. Production DNS and OAuth are intentionally outside
this foundation issue.
