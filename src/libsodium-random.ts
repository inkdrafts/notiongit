/**
 * Randomness indirection used by the Workers-compatible libsodium adapter.
 *
 * libsodium-wrappers performs a disposable startup self-test while the module
 * is evaluated. Workers cannot use request-scoped randomness at that time, so
 * the adapter uses a fixed value only for that self-test. Provisioning enables
 * WebCrypto randomness before any application data is encrypted.
 */

let requestContextRandomEnabled = false;

export function getLibsodiumRandomValue(): number {
  if (!requestContextRandomEnabled) return 0x6d2b_79f5;

  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] >>> 0;
}

export function enableRequestContextRandom(): void {
  requestContextRandomEnabled = true;
}
