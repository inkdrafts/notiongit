import sodium from 'libsodium-wrappers';
import { enableRequestContextRandom, getRandomMetrics } from './libsodium-worker';

const SYNTHETIC_PUBLIC_KEY_B64 = 'RwHQhIhFH1RaQJ+1iuPlhYHKQKw/fxFGmM1x3qxzygE=';
const SYNTHETIC_PLAINTEXT = 'synthetic-actions-secret';

const initStartedAt = performance.now();
let initDurationMs: number | null = null;
let initializationCount = 0;

const readyPromise = sodium.ready.then(() => {
  initializationCount += 1;
  initDurationMs = performance.now() - initStartedAt;
});

async function sealSecret(secretPlaintext: string, repositoryPublicKeyB64: string): Promise<string> {
  await readyPromise;

  const publicKey = sodium.from_base64(
    repositoryPublicKeyB64,
    sodium.base64_variants.ORIGINAL,
  );
  const plaintext = sodium.from_string(secretPlaintext);
  const sealed = sodium.crypto_box_seal(plaintext, publicKey);

  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function runSpike() {
  enableRequestContextRandom();
  const readyAwaitStartedAt = performance.now();
  await readyPromise;
  const readyAwaitDurationMs = performance.now() - readyAwaitStartedAt;

  const sealStartedAt = performance.now();
  const ciphertext = await sealSecret(SYNTHETIC_PLAINTEXT, SYNTHETIC_PUBLIC_KEY_B64);
  const sealDurationMs = performance.now() - sealStartedAt;
  const ciphertextBytes = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
  const plaintextBytes = sodium.from_string(SYNTHETIC_PLAINTEXT);

  return {
    ok: ciphertextBytes.length === plaintextBytes.length + sodium.crypto_box_SEALBYTES,
    ciphertext,
    ciphertextLength: ciphertext.length,
    initializationCount,
    random: getRandomMetrics(),
    sodiumVersion: sodium.SODIUM_VERSION_STRING,
    timings: {
      moduleInitializationMs: initDurationMs,
      readyAwaitMs: readyAwaitDurationMs,
      sealMs: sealDurationMs,
    },
  };
}

export default {
  async fetch(): Promise<Response> {
    try {
      const result = await runSpike();
      return Response.json(result, {
        status: result.ok ? 200 : 500,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return Response.json(
        { ok: false, error: 'sealed-box experiment failed' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
} satisfies ExportedHandler;
