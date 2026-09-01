# notiongit
Notion + Git deployment service: provisions a Notion-powered Jekyll site into a user's own GitHub Pages. Powers inkdrafts.com

## Development

Install dependencies and run the repository checks from the root with
[Bun](https://bun.sh):

```sh
bun install
bun run test
bun run deploy:dry-run
```

The initial Cloudflare Workers sealed-box experiment is documented in
[`spikes/libsodium-workers/README.md`](spikes/libsodium-workers/README.md), and
the hosting decision is recorded in
[`docs/decisions/0001-sealed-box-on-workers.md`](docs/decisions/0001-sealed-box-on-workers.md).

The Notion OAuth template-duplication spike is documented in
[`spikes/notion-oauth-template/README.md`](spikes/notion-oauth-template/README.md), and
the Notion onboarding decision is recorded in
[`docs/decisions/0002-notion-onboarding.md`](docs/decisions/0002-notion-onboarding.md).
