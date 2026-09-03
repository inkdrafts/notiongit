import sodium from 'libsodium-wrappers';

import { enableRequestContextRandom } from './libsodium-random';

export const ACTIONS_SECRET_NAMES = [
  'NOTION_TOKEN',
  'NOTION_PAGES_DATABASE_ID',
  'NOTION_POSTS_DATABASE_ID',
] as const;

export type ActionsSecretName = (typeof ACTIONS_SECRET_NAMES)[number];

/**
 * Ephemeral handoff between the Notion and GitHub provisioning tracks.
 *
 * This object must remain in memory for the duration of provisioning only. It
 * must never be put in KV, a Queue message, a log, an error, or a browser
 * response.
 */
export interface ActionsSecretsProvisioningPayload {
  readonly repositoryFullName: string;
  readonly secrets: Readonly<Record<ActionsSecretName, string>>;
}

export type GithubActionsSecretsPayload = ActionsSecretsProvisioningPayload;

export interface GithubActionsPublicKey {
  readonly keyId: string;
  readonly key: string;
}

export interface ActionsSecretsWriteResult {
  readonly repositoryFullName: string;
  readonly secretNames: readonly ActionsSecretName[];
}

export type GithubActionsSecretsErrorCode =
  | 'github_actions_public_key_unavailable'
  | 'github_actions_public_key_invalid'
  | 'github_actions_secret_write_failed';

export class GithubActionsSecretsError extends Error {
  readonly code: GithubActionsSecretsErrorCode;
  readonly status: number;

  constructor(code: GithubActionsSecretsErrorCode, status = 502) {
    super(code);
    this.name = 'GithubActionsSecretsError';
    this.code = code;
    this.status = status;
  }
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const PUBLIC_KEY_BYTES = 32;

function githubHeaders(authorization: string): Headers {
  return new Headers({
    Accept: 'application/vnd.github+json',
    Authorization: authorization,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

function repositoryPath(repositoryFullName: string): string {
  if (typeof repositoryFullName !== 'string') {
    throw new GithubActionsSecretsError('github_actions_public_key_invalid', 400);
  }

  const parts = repositoryFullName.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/u.test(part) || part === '.' || part === '..')
  ) {
    throw new GithubActionsSecretsError('github_actions_public_key_invalid', 400);
  }

  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function secretPath(repositoryFullName: string, secretName: ActionsSecretName): string {
  return `${repositoryPath(repositoryFullName)}/actions/secrets/${encodeURIComponent(secretName)}`;
}

function decodePublicKey(publicKey: string): Uint8Array {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKey)) {
    throw new GithubActionsSecretsError('github_actions_public_key_invalid', 502);
  }

  try {
    const decoded = Uint8Array.from(atob(publicKey), (character) => character.charCodeAt(0));
    if (decoded.length !== PUBLIC_KEY_BYTES) {
      throw new Error('wrong public key length');
    }
    return decoded;
  } catch {
    throw new GithubActionsSecretsError('github_actions_public_key_invalid', 502);
  }
}

function validKeyId(keyId: unknown): keyId is string {
  return typeof keyId === 'string' && /^[A-Za-z0-9_.-]{1,256}$/u.test(keyId);
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function providerFailure(status: number, code: GithubActionsSecretsErrorCode): GithubActionsSecretsError {
  return new GithubActionsSecretsError(code, status >= 400 && status < 600 ? status : 502);
}

/** Fetch the repository key used by GitHub's Actions Secrets API. */
export async function getGithubActionsPublicKey(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<GithubActionsPublicKey> {
  const path = repositoryPath(repositoryFullName);
  let response: Response;
  try {
    response = await fetcher(`${GITHUB_API}/repos/${path}/actions/secrets/public-key`, {
      headers: githubHeaders(`Bearer ${installationToken}`),
    });
  } catch {
    throw new GithubActionsSecretsError('github_actions_public_key_unavailable');
  }

  if (!response.ok) throw providerFailure(response.status, 'github_actions_public_key_unavailable');
  const body = await readJson<{ key_id?: unknown; key?: unknown }>(response);
  if (!body || !validKeyId(body.key_id) || typeof body.key !== 'string') {
    throw new GithubActionsSecretsError('github_actions_public_key_unavailable');
  }

  // Validate the key before returning it so an invalid provider response never
  // reaches the encryption path or is accidentally echoed in an error.
  decodePublicKey(body.key);
  return { keyId: body.key_id, key: body.key };
}

/**
 * Encrypt one Actions secret with GitHub's repository public key.
 *
 * The readiness switch is deliberately before the await: it ensures the
 * Workers adapter uses request-context WebCrypto randomness for application
 * data, while its fixed startup value is limited to the disposable self-test.
 */
export async function sealGithubActionsSecret(
  secretPlaintext: string,
  repositoryPublicKey: string,
): Promise<string> {
  enableRequestContextRandom();
  const publicKey = decodePublicKey(repositoryPublicKey);
  let plaintext: Uint8Array | undefined;
  let sealed: Uint8Array | undefined;

  try {
    await sodium.ready;
    plaintext = sodium.from_string(secretPlaintext);
    sealed = sodium.crypto_box_seal(plaintext, publicKey);
    return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new GithubActionsSecretsError('github_actions_public_key_invalid');
  } finally {
    plaintext?.fill(0);
    sealed?.fill(0);
    publicKey.fill(0);
  }
}

function validatePayload(payload: ActionsSecretsProvisioningPayload): void {
  if (!payload || typeof payload !== 'object' || !payload.secrets || typeof payload.secrets !== 'object') {
    throw new GithubActionsSecretsError('github_actions_secret_write_failed', 400);
  }
  repositoryPath(payload.repositoryFullName);
  for (const name of ACTIONS_SECRET_NAMES) {
    if (typeof payload.secrets[name] !== 'string') {
      throw new GithubActionsSecretsError('github_actions_secret_write_failed', 400);
    }
  }
}

/**
 * Create or replace all three deployment-owned Actions secrets.
 *
 * GitHub's PUT endpoint is idempotent: a retry after a partial failure updates
 * existing names and creates only the missing names. Values are encrypted one
 * at a time so temporary plaintext/ciphertext buffers can be wiped promptly.
 */
export async function writeGithubActionsSecrets(
  installationToken: string,
  payload: ActionsSecretsProvisioningPayload,
  fetcher: typeof fetch = fetch,
): Promise<ActionsSecretsWriteResult> {
  validatePayload(payload);
  const publicKey = await getGithubActionsPublicKey(
    installationToken,
    payload.repositoryFullName,
    fetcher,
  );

  for (const name of ACTIONS_SECRET_NAMES) {
    let encryptedValue = '';
    try {
      encryptedValue = await sealGithubActionsSecret(payload.secrets[name], publicKey.key);
      const headers = githubHeaders(`Bearer ${installationToken}`);
      headers.set('Content-Type', 'application/json');
      const response = await fetcher(
        `${GITHUB_API}/repos/${secretPath(payload.repositoryFullName, name)}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ encrypted_value: encryptedValue, key_id: publicKey.keyId }),
        },
      );
      if (!response.ok) throw providerFailure(response.status, 'github_actions_secret_write_failed');
    } catch (error) {
      if (error instanceof GithubActionsSecretsError) throw error;
      throw new GithubActionsSecretsError('github_actions_secret_write_failed');
    } finally {
      encryptedValue = '';
    }
  }

  return {
    repositoryFullName: payload.repositoryFullName,
    secretNames: [...ACTIONS_SECRET_NAMES],
  };
}

export const getActionsPublicKey = getGithubActionsPublicKey;
export const sealActionsSecret = sealGithubActionsSecret;
export const sealSecret = sealGithubActionsSecret;
export const writeActionsSecrets = writeGithubActionsSecrets;
