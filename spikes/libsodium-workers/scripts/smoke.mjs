import assert from 'node:assert/strict';

const url = process.argv[2] ?? process.env.WORKER_URL;
if (!url) {
  throw new Error('Usage: bun run smoke -- https://<preview-host>');
}

async function readExperiment() {
  const response = await fetch(url, { redirect: 'error' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.initializationCount, 1);
  assert.ok(result.random.requestRandomCalls > 0);
  return result;
}

const first = await readExperiment();
const second = await readExperiment();
assert.notEqual(first.ciphertext, second.ciphertext);
assert.ok(second.random.requestRandomCalls > first.random.requestRandomCalls);

console.log(
  JSON.stringify(
    {
      ciphertextLength: first.ciphertextLength,
      initializationCount: second.initializationCount,
      random: second.random,
      sodiumVersion: first.sodiumVersion,
      firstTimings: first.timings,
      secondTimings: second.timings,
    },
    null,
    2,
  ),
);
