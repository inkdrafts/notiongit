# Libsodium sealed boxes on Cloudflare Workers

This experiment encrypts the known plaintext `synthetic-actions-secret` using a
fixed synthetic 32-byte Curve25519 public key encoded in the same standard
base64 form returned by GitHub's Actions Secrets API. No real credential or
user data is used.

## Local verification

From the repository root, using [Bun](https://bun.sh):

```sh
bun install
bun run test
bun run deploy:dry-run
```

`bun run test` type-checks with `tsc`, then launches `wrangler dev` on an
unused local port via `bun test`, makes two requests to the Worker running in
`workerd`, confirms that the ciphertexts differ, and opens both sealed boxes
in a Node-compatible test harness with the matching synthetic private key.

## Non-production Worker smoke test

Upload to a temporary Cloudflare preview account when no authenticated test
account is available:

```sh
cd spikes/libsodium-workers
bunx wrangler deploy --temporary
bun run smoke -- https://<temporary-preview-host>
```

For an authenticated test account, deploy the same configuration only to a
dedicated non-production Worker and pass its URL to `bun run smoke`. The smoke
script prints timings and counters but omits ciphertext, plaintext, and key
material.

## Updating libsodium

The Workers runtime requires a statically imported Wasm module. After changing
the pinned `libsodium-wrappers` version, keep the explicit `libsodium`
dependency version in sync with the version `libsodium-wrappers` requires
(Bun only symlinks declared dependencies into `node_modules`, so an
undeclared transitive `libsodium` breaks the `wrangler.toml` module alias).
Then regenerate the matching binary and repeat every local and remote check:

```sh
bun run wasm:extract
```

See the ADR for why the adapter also supplies deterministic randomness only to
libsodium's disposable startup self-test, then switches to request-context
WebCrypto before any application encryption.
