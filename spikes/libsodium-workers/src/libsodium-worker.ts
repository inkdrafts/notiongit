import rawFactory from 'libsodium-raw';
import sodiumWasm from './libsodium.wasm';

type ReceiveInstance = (
  instance: WebAssembly.Instance,
  module: WebAssembly.Module,
) => void;

let secureRandomEnabled = false;
let bootstrapRandomCalls = 0;
let requestRandomCalls = 0;

function getRandomValue(): number {
  if (!secureRandomEnabled) {
    bootstrapRandomCalls += 1;
    return 0x6d2b_79f5;
  }

  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  requestRandomCalls += 1;
  return value[0] >>> 0;
}

export default function createWorkerCompatibleLibsodium(
  options: Record<string, unknown> = {},
) {
  return rawFactory({
    ...options,
    getRandomValue,
    instantiateWasm(imports: WebAssembly.Imports, receiveInstance: ReceiveInstance) {
      const instance = new WebAssembly.Instance(sodiumWasm, imports);
      receiveInstance(instance, sodiumWasm);
      return instance.exports;
    },
  });
}

export function enableRequestContextRandom(): void {
  secureRandomEnabled = true;
}

export function getRandomMetrics() {
  return { bootstrapRandomCalls, requestRandomCalls };
}
