import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import sodium from 'libsodium-wrappers';

const SYNTHETIC_PLAINTEXT = 'synthetic-actions-secret';
const SYNTHETIC_PUBLIC_KEY_B64 = 'RwHQhIhFH1RaQJ+1iuPlhYHKQKw/fxFGmM1x3qxzygE=';
const SYNTHETIC_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function startWorker() {
  const port = await availablePort();
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(
    npx,
    [
      '--no-install',
      'wrangler',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--show-interactive-dev-session=false',
      '--log-level=error',
    ],
    { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready:\n${output}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return { child, output: () => output, url };
    } catch {
      // The local socket is expected to reject connections during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill('SIGTERM');
  throw new Error(`Wrangler did not become ready:\n${output}`);
}

async function stopWorker(child) {
  if (child.exitCode === null) child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
}

async function readExperiment(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

test('sealed boxes round-trip and remain non-deterministic in local workerd', async (t) => {
  const worker = await startWorker();
  t.after(async () => stopWorker(worker.child));

  const first = await readExperiment(worker.url);
  const second = await readExperiment(worker.url);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.initializationCount, 1);
  assert.equal(second.initializationCount, 1);
  assert.ok(first.random.bootstrapRandomCalls > 0);
  assert.ok(first.random.requestRandomCalls > 0);
  assert.ok(second.random.requestRandomCalls > first.random.requestRandomCalls);
  assert.equal(first.timings.moduleInitializationMs, second.timings.moduleInitializationMs);
  assert.ok(first.timings.moduleInitializationMs >= 0);
  assert.ok(first.timings.sealMs >= 0);

  await sodium.ready;
  const keypair = sodium.crypto_box_seed_keypair(SYNTHETIC_SEED);
  const publicKeyB64 = sodium.to_base64(
    keypair.publicKey,
    sodium.base64_variants.ORIGINAL,
  );
  assert.equal(publicKeyB64, SYNTHETIC_PUBLIC_KEY_B64);

  const privateKeyB64 = sodium.to_base64(
    keypair.privateKey,
    sodium.base64_variants.ORIGINAL,
  );
  for (const ciphertext of [first.ciphertext, second.ciphertext]) {
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(SYNTHETIC_PUBLIC_KEY_B64, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(privateKeyB64, sodium.base64_variants.ORIGINAL),
    );
    assert.equal(sodium.to_string(opened), SYNTHETIC_PLAINTEXT);
  }

  t.diagnostic(
    JSON.stringify({
      ciphertextLength: first.ciphertextLength,
      initializationCount: second.initializationCount,
      random: second.random,
      sodiumVersion: first.sodiumVersion,
      firstTimings: first.timings,
      secondTimings: second.timings,
    }),
  );
});
