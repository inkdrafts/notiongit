import rawFactory from 'libsodium-raw';
import sodiumWasm from './libsodium.wasm';
import { getLibsodiumRandomValue } from './libsodium-random';

type ReceiveInstance = (
  instance: WebAssembly.Instance,
  module: WebAssembly.Module,
) => void;

export default function createWorkerCompatibleLibsodium(
  options: Record<string, unknown> = {},
) {
  return rawFactory({
    ...options,
    getRandomValue: getLibsodiumRandomValue,
    instantiateWasm(imports: WebAssembly.Imports, receiveInstance: ReceiveInstance) {
      const instance = new WebAssembly.Instance(sodiumWasm, imports);
      receiveInstance(instance, sodiumWasm);
      return instance.exports;
    },
  });
}
