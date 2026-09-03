import { describe, expect, test } from 'bun:test';
import sodium from 'libsodium-wrappers';

import {
  ACTIONS_SECRET_NAMES,
  GithubActionsSecretsError,
  sealGithubActionsSecret,
  writeGithubActionsSecrets,
  type ActionsSecretsProvisioningPayload,
} from '../src/actions-secrets';

const REPOSITORY = 'alice/alice.github.io';
const INSTALLATION_TOKEN = 'installation-token';
const SECRET_VALUES = {
  NOTION_TOKEN: 'notion-token-fixture',
  NOTION_PAGES_DATABASE_ID: 'pages-database-fixture',
  NOTION_POSTS_DATABASE_ID: 'posts-database-fixture',
} as const;
const PUBLIC_KEY = 'RwHQhIhFH1RaQJ+1iuPlhYHKQKw/fxFGmM1x3qxzygE=';

const payload: ActionsSecretsProvisioningPayload = {
  repositoryFullName: REPOSITORY,
  secrets: SECRET_VALUES,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function publicKeyResponse(): Response {
  return jsonResponse(200, { key_id: 'actions-key-1', key: PUBLIC_KEY });
}

describe('GitHub Actions secrets', () => {
  test('encrypts and writes all three secrets with the installation token', async () => {
    const requests: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/actions/secrets/public-key')) return publicKeyResponse();
      return new Response(null, { status: requests.length === 2 ? 201 : 204 });
    };

    const result = await writeGithubActionsSecrets(INSTALLATION_TOKEN, payload, fetcher);

    expect(result).toEqual({
      repositoryFullName: REPOSITORY,
      secretNames: [...ACTIONS_SECRET_NAMES],
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.headers.get('authorization') === `Bearer ${INSTALLATION_TOKEN}`)).toBe(true);
    expect(requests.slice(1).map((request) => request.method)).toEqual(['PUT', 'PUT', 'PUT']);

    await sodium.ready;
    const keypair = sodium.crypto_box_seed_keypair(
      Uint8Array.from({ length: 32 }, (_, index) => index),
    );
    expect(sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL)).toBe(PUBLIC_KEY);
    // The fixture key is only used to establish that the public key was the
    // one sent to GitHub; decrypt each ciphertext to prove the sealed-box path.
    for (let index = 0; index < ACTIONS_SECRET_NAMES.length; index += 1) {
      const body = await requests[index + 1].json() as { encrypted_value: string; key_id: string };
      expect(body.key_id).toBe('actions-key-1');
      expect(body.encrypted_value).not.toContain(SECRET_VALUES[ACTIONS_SECRET_NAMES[index]]);
      const opened = sodium.crypto_box_seal_open(
        sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
        keypair.publicKey,
        keypair.privateKey,
      );
      expect(sodium.to_string(opened)).toBe(SECRET_VALUES[ACTIONS_SECRET_NAMES[index]]);
    }
  });

  test('retries are safe because every PUT is an overwrite-or-create operation', async () => {
    const methods: string[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      methods.push(request.method);
      if (request.url.endsWith('/actions/secrets/public-key')) return publicKeyResponse();
      return new Response(null, { status: 204 });
    };

    await writeGithubActionsSecrets(INSTALLATION_TOKEN, payload, fetcher);
    await writeGithubActionsSecrets(INSTALLATION_TOKEN, payload, fetcher);

    expect(methods).toEqual(['GET', 'PUT', 'PUT', 'PUT', 'GET', 'PUT', 'PUT', 'PUT']);
  });

  test('redacts provider failures and thrown exceptions', async () => {
    const leakedValue = SECRET_VALUES.NOTION_TOKEN;
    const providerFailure = await writeGithubActionsSecrets(INSTALLATION_TOKEN, payload, async () =>
      jsonResponse(500, { message: leakedValue }),
    ).catch((error: unknown) => error);
    expect(providerFailure).toBeInstanceOf(GithubActionsSecretsError);
    expect(String(providerFailure)).not.toContain(leakedValue);
    expect((providerFailure as GithubActionsSecretsError).code).toBe('github_actions_public_key_unavailable');

    const thrownFailure = await writeGithubActionsSecrets(INSTALLATION_TOKEN, payload, async () => {
      throw new Error(`network failure: ${leakedValue}`);
    }).catch((error: unknown) => error);
    expect(thrownFailure).toBeInstanceOf(GithubActionsSecretsError);
    expect(String(thrownFailure)).not.toContain(leakedValue);

    let calls = 0;
    const writeFailure = await writeGithubActionsSecrets(INSTALLATION_TOKEN, payload, async (input, init) => {
      calls += 1;
      const request = new Request(input, init);
      if (request.method === 'GET') return publicKeyResponse();
      return jsonResponse(500, { message: leakedValue });
    }).catch((error: unknown) => error);
    expect(calls).toBe(2);
    expect(writeFailure).toBeInstanceOf(GithubActionsSecretsError);
    expect(String(writeFailure)).not.toContain(leakedValue);
    expect((writeFailure as GithubActionsSecretsError).code).toBe('github_actions_secret_write_failed');
  });

  test('rejects malformed repository keys without sending a secret', async () => {
    await expect(sealGithubActionsSecret('synthetic-secret', 'not-a-key'))
      .rejects.toMatchObject({ code: 'github_actions_public_key_invalid' });
  });
});
