/**
 * HMAC-SHA256-over-base64url-JSON signed payloads with constant-time verify.
 *
 * One mechanism for every signed browser-roundtrip token the worker mints
 * (GitHub install state, and the status surface's session, authorize state,
 * and rerun form token). Each consumer owns its payload shape and the
 * acceptance rule its verifier enforces; a rule that demands an exact `k`
 * kind makes one kind's token unusable at another consumer, so a captured
 * signed string cannot be replayed across legs. The signing key is always a
 * server-only secret: it never appears in a payload, cookie, or token.
 */

const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid base64url');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

/** `<base64url(JSON payload)>.<base64url(HMAC)>`. */
export async function signSignedPayload(payload: unknown, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await hmacSign(encodedPayload, secret)}`;
}

/**
 * Verify the signature in constant time, parse the payload, and apply the
 * caller's acceptance rule. Null for a malformed encoding, a bad signature,
 * an unreadable payload, or a payload the rule rejects. The payload type is
 * the caller's declaration, backed by the rule it passed in.
 */
export async function verifySignedPayload<P>(
  encoded: string,
  secret: string,
  accepts: (payload: Record<string, unknown>) => boolean,
): Promise<P | null> {
  const parts = encoded.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const expectedSignature = await hmacSign(parts[0], secret);
    const expected = textEncoder.encode(expectedSignature);
    const actual = textEncoder.encode(parts[1]);
    if (expected.length !== actual.length) return null;

    // The equal-length check keeps a non-constant-time string comparison out
    // of the path; WebCrypto performs the real comparison.
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(parts[1]),
      textEncoder.encode(parts[0]),
    );
    if (!valid) return null;

    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    if (payload === null || typeof payload !== 'object' || !accepts(payload as Record<string, unknown>)) {
      return null;
    }
    return payload as P;
  } catch {
    return null;
  }
}

/** Every payload kind carries `exp` in epoch seconds and expires hard. */
export function payloadExpired(exp: unknown, nowSeconds: number): boolean {
  return typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= nowSeconds;
}
