# ADR 0001: Use libsodium sealed boxes on Cloudflare Workers

- Status: Accepted
- Date: 2026-08-31 MDT (2026-09-01 UTC verification)
- Decision: Continue with Cloudflare Workers

## Context

GitHub requires clients to encrypt Actions secret values with a libsodium
sealed box (`crypto_box_seal`) using the repository public key. WebCrypto does
not expose this construction. The onboarding backend therefore needs a proven
server-side implementation before the rest of provisioning is built.

Cloudflare Workers supports statically imported WebAssembly modules, but for
security it rejects `WebAssembly.compile()` and
`WebAssembly.instantiate(buffer, ...)`. It also rejects random generation in
module-global scope because that operation has no request context. Those two
constraints make a direct `import sodium from "libsodium-wrappers"` fail even
though the cryptographic primitives themselves are compatible with Workers.

## Decision

Continue with Cloudflare Workers and pin `libsodium-wrappers` 0.8.4, which uses
libsodium 0.8.4 and reports `SODIUM_VERSION_STRING` 1.0.22.

Use the standard ESM wrapper with a Workers adapter that:

1. statically imports the exact Wasm payload bundled with the pinned libsodium
   package;
2. supplies that precompiled `WebAssembly.Module` through Emscripten's
   `instantiateWasm` hook, avoiding forbidden runtime compilation;
3. supplies a fixed value only to libsodium-wrappers' disposable startup
   self-test; and
4. switches the same random-source indirection to
   `crypto.getRandomValues()` at the start of the request, before awaiting
   readiness or encrypting application data.

The fixed bootstrap source never encrypts application data and no key produced
by the startup self-test is retained. The experiment exposes separate bootstrap
and request random-call counters; the tests require request calls to increase
for every sealed box.

## Evidence

Environment and dependency versions:

- Node.js 26.8.1
- Wrangler 4.127.1
- workerd 1.20260828.1
- `libsodium-wrappers` 0.8.4 / libsodium 1.0.22
- compatibility date 2026-08-31

Static artifact:

- extracted Wasm size: 221,811 bytes
- SHA-256: `36ee2d34e4b659a2dc41ffc6871b934974b1dc88626c42e3e020b593415d89e7`
- dry-run upload: 686.66 KiB uncompressed, 250.80 KiB gzip
- no Worker bindings or secrets

Local Wrangler/workerd test:

- the Worker started successfully;
- two encryptions of the 24-byte known plaintext produced different
  ciphertexts;
- both 72-byte sealed boxes (96 base64 characters) opened to the original
  plaintext in the Node harness;
- initialization count remained 1 across requests;
- bootstrap random calls remained 72 and request random calls increased by 32
  for each encryption;
- sampled local timings reported module initialization 0 ms, ready wait 0 ms,
  and sealing 0-1 ms.

Non-production Cloudflare smoke test:

- `wrangler deploy --temporary` uploaded to an ephemeral preview Worker;
- Wrangler reported a Worker startup time of 27 ms;
- after brief `workers.dev` route propagation, two edge requests succeeded;
- ciphertexts differed, initialization count remained 1, and request random
  calls increased between requests;
- sampled runtime timings reported 0 ms at the runtime timer's granularity.

Wrangler's 27 ms startup measurement is the useful cold-start signal. The
in-Worker `performance.now()` values are retained as a regression signal, but
their zero values are too coarse to interpret as literal zero-cost work.

## Rejected approaches and failure modes

- Direct ESM import: libsodium embeds bytes and calls
  `WebAssembly.instantiate(buffer, ...)`, which workerd rejects with “Wasm code
  generation disallowed by embedder.”
- CommonJS/pure-JavaScript fallback: its environment probe fails to find secure
  randomness reliably after Wrangler bundling and is not a stable package API.
- Starting the normal wrapper in global scope with WebCrypto: the wrapper's
  startup self-test requests random values globally, which Workers rejects.
- WebCrypto alone: it has no sealed-box construction compatible with GitHub.

Operational failure modes that remain:

- a libsodium upgrade can change the embedded Wasm payload or Emscripten hook;
- calling encryption before enabling request-context randomness would be a
  security defect;
- an invalid or non-32-byte GitHub public key must fail provisioning safely;
- an isolate can be evicted at any time, so initialization must remain
  idempotent and cached only as an optimization;
- Workers bundle/startup limits can change and must be rechecked on upgrades.

## Consequences and required follow-up

- Keep the version exact and regenerate the Wasm with `bun run wasm:extract`
  only when intentionally upgrading. Verify its hash and rerun local and edge
  tests in the same change. Keep the explicit `libsodium` dependency version
  in the spike's `package.json` in sync with the version
  `libsodium-wrappers` requires, since Bun only symlinks declared
  dependencies into `node_modules` and the `wrangler.toml` module alias
  resolves `libsodium` by path.
- Move the adapter and `sealSecret` into the server-only provisioning layer;
  never include them in browser bundles.
- Validate GitHub's decoded public key length before encryption and return a
  retry-safe provisioning error without logging plaintext, keys, or tokens.
- Await one module-scoped readiness promise per isolate, but keep provisioning
  steps idempotent because isolates and queue deliveries can restart.
- Zero temporary plaintext byte arrays where practical after GitHub accepts the
  encrypted value. Never persist user access tokens.
- Keep a non-production edge smoke test in the release checklist, including
  bundle size, startup time, initialization count, and non-determinism.

## References

- [Cloudflare Workers WebAssembly guidance](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)
- [Cloudflare Workers JavaScript restrictions](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)
- [GitHub secret encryption guidance](https://docs.github.com/en/rest/guides/encrypting-secrets-for-the-rest-api)
- [Libsodium sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes)
