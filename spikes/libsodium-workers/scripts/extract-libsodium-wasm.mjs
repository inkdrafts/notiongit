import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL(
  '../node_modules/libsodium/dist/modules-esm/libsodium.mjs',
  import.meta.url,
);
const outputUrl = new URL('../src/libsodium.wasm', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const match = source.match(/\}\)\("([A-Za-z0-9+/=]+)"\),A\(\(await/);

if (!match) {
  throw new Error('Unable to locate the embedded libsodium Wasm payload');
}

const wasm = Buffer.from(match[1], 'base64');
if (!WebAssembly.validate(wasm)) {
  throw new Error('Extracted libsodium payload is not valid Wasm');
}

await writeFile(outputUrl, wasm);
console.log(`Wrote ${wasm.length} bytes to ${outputUrl.pathname}`);
