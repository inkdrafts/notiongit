import { describe, expect, test } from 'bun:test';

import {
  accountLeaseKey,
  acquireProvisioningStart,
  consumeGlobalMutationBudget,
  loadProvisioningJob,
  provisioningThrottleConfig,
  releaseProvisioningLeaseIfOwned,
  ProvisioningGateRefusedError,
  saveProvisioningJob,
  createProvisioningJob,
  processProvisioningMessage,
  type ProvisioningQueueEnv,
} from '../src/index';
import type { GeneratedRepositoryIdentity } from '../src/repository-generation';

/**
 * Synthetic, fully deterministic load: M accounts x K onboarding jobs are
 * driven through the same gates production uses — the sync start gate and
 * per-generate budget from `finishGithubCallback`, then every queue step —
 * over one MemoryKV, a schedule-aware queue, a counting fake fetcher, and an
 * explicit clock. The clock only ever advances to a scheduled delivery, so
 * a gate that redelivers immediately (a busy loop) shows up as a hang or as
 * a zero-delay delivery, never as passed assertions.
 */

const ACCOUNTS = 4;
const JOBS_PER_ACCOUNT = 3;
const BASE_MS = 1_704_000_000_000;
const MAX_EVENTS = 20_000;

class MemoryKV {
  private values = new Map<string, string>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/** Records every send with the delay it was scheduled to carry. */
class ScheduledQueue {
  readonly sent: Array<{ jobId: string; delaySeconds: number | null }> = [];

  async send(message: { jobId: string }, options?: { delaySeconds?: number }): Promise<void> {
    this.sent.push({ jobId: message.jobId, delaySeconds: options?.delaySeconds ?? null });
  }

  async sendBatch(): Promise<void> {
    throw new Error('ScheduledQueue.sendBatch is not used by this project');
  }
}

function seededRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface GatedMutation {
  kind: 'generate' | 'patch_config' | 'configure_pages' | 'dispatch_sync';
  atMs: number;
}

let throwawayPrivateKey: Promise<string> | undefined;

function generateThrowawayPrivateKey(): Promise<string> {
  throwawayPrivateKey ??= (async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let base64 = '';
    for (const byte of der) base64 += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(base64)}\n-----END PRIVATE KEY-----`;
  })();
  return throwawayPrivateKey;
}

function encoded(content: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(content)));
}

describe('provisioning throttle under load', () => {
  test(`drives ${ACCOUNTS} accounts x ${JOBS_PER_ACCOUNT} jobs to terminal status under a tiny budget, never exceeding it`, async () => {
    const kv = new MemoryKV();
    const queue = new ScheduledQueue();
    const env: ProvisioningQueueEnv = {
      JOBS: kv as unknown as KVNamespace,
      PROVISIONING_QUEUE: queue as unknown as Queue<{ jobId: string }>,
      GITHUB_APP_ID: '4798518',
      GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
      PROVISIONING_MUTATIONS_PER_MINUTE: '4',
      PROVISIONING_MUTATIONS_PER_HOUR: '100',
    };
    const config = provisioningThrottleConfig(env);
    const rng = seededRng(101);

    let clock = BASE_MS;
    const now = () => clock;
    const gatedMutations: GatedMutation[] = [];

    const accounts = Array.from({ length: ACCOUNTS }, (_, account) => ({
      accountId: 42 + account,
      installationId: 100 + account,
      login: `user${account}`,
    }));

    const pagesConfigured = new Set<string>();
    const dispatchedRuns = new Map<string, number[]>();

    /** Handles every endpoint for every account; counts each content-creating
     * call at the instant it fires. */
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      // The raw string, not request.url: URL normalization appends "/" to an
      // apex site URL, and the site fetch below compares exact addresses.
      const url = String(input);
      const account = accounts.find((candidate) => url.includes(`/installations/${candidate.installationId}/`) || url.includes(`/${candidate.login}/`) || url.startsWith(`https://${candidate.login}.github.io`));
      if (!account) throw new Error(`unexpected URL: ${url}`);
      const repository = `https://api.github.com/repos/${account.login}/${account.login}.github.io`;

      if (url.endsWith('/access_tokens')) return Response.json({ token: `tok-${account.accountId}` });
      if (url.startsWith(`${repository}/contents/_config.yml`) && request.method === 'GET') {
        return Response.json({
          type: 'file',
          encoding: 'base64',
          content: encoded('title: "InkDrafts"\nurl: ""\nbaseurl: ""\n'),
          sha: 'config-sha',
        });
      }
      if (request.method === 'PUT' && url.startsWith(`${repository}/contents/_config.yml`)) {
        gatedMutations.push({ kind: 'patch_config', atMs: now() });
        return Response.json({ content: { sha: 'patched-sha' }, commit: { sha: 'patched-commit' } });
      }
      if (url === `${repository}/pages` && request.method === 'POST') {
        gatedMutations.push({ kind: 'configure_pages', atMs: now() });
        // An account whose site already exists answers 409; the handler then
        // reads the current site and finds it compatible.
        if (pagesConfigured.has(account.login)) return new Response(null, { status: 409 });
        pagesConfigured.add(account.login);
        return Response.json({
          status: 'built',
          url: `${repository}/pages`,
          html_url: `https://${account.login}.github.io`,
          build_type: 'legacy',
          source: { branch: 'main', path: '/' },
        }, { status: 201 });
      }
      if (url === `${repository}/pages` && request.method === 'GET') {
        return Response.json({
          status: 'built',
          url: `${repository}/pages`,
          html_url: `https://${account.login}.github.io`,
          build_type: 'legacy',
          source: { branch: 'main', path: '/' },
        });
      }
      if (url.endsWith('/sync-notion.yml/dispatches') && request.method === 'POST') {
        gatedMutations.push({ kind: 'dispatch_sync', atMs: now() });
        const ids = dispatchedRuns.get(account.login) ?? [];
        ids.push(555 + ids.length);
        dispatchedRuns.set(account.login, ids);
        return new Response(null, { status: 204 });
      }
      if (url.includes('/actions/workflows/sync-notion.yml/runs?')) {
        return Response.json({
          workflow_runs: (dispatchedRuns.get(account.login) ?? []).map((id) => ({
            id,
            html_url: `${repository}/actions/runs/${id}`,
            status: 'completed',
            conclusion: null,
            event: 'workflow_dispatch',
            created_at: new Date(now() - 1_000).toISOString(),
          })),
        });
      }
      const runMatch = url.match(/\/actions\/runs\/(\d+)$/);
      if (runMatch) {
        const id = Number(runMatch[1]);
        if (!(dispatchedRuns.get(account.login) ?? []).includes(id)) {
          return Response.json({ message: 'Not Found' }, { status: 404 });
        }
        return Response.json({
          id,
          html_url: `${repository}/actions/runs/${id}`,
          status: 'completed',
          conclusion: 'success',
        });
      }
      if (url === `${repository}/commits/main`) {
        return Response.json({ sha: 'head-sha', commit: { tree: { sha: 'head-tree-sha' } } });
      }
      if (url === repository) {
        return Response.json({ id: account.installationId, full_name: `${account.login}/${account.login}.github.io`, default_branch: 'main', fork: false });
      }
      if (url === `${repository}/pages/builds/latest`) {
        return Response.json({ url: `${repository}/pages/builds/999`, status: 'built', commit: 'head-sha' });
      }
      if (url === `https://${account.login}.github.io`) {
        return new Response('<!doctype html>', { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const generated: GeneratedRepositoryIdentity = {
      id: 1,
      fullName: '',
      name: '',
      htmlUrl: '',
      defaultBranch: 'main',
      templateFullName: 'inkdrafts/notiongit-template',
      templateHeadSha: null,
      templateHeadTreeSha: null,
      headSha: null,
      headTreeSha: null,
      reused: false,
    };

    interface Start { accountId: number; installationId: number; login: string; jobId: string; deliverAt: number }
    interface Delivery { jobId: string; deliverAt: number }
    const starts: Start[] = [];
    const deliveries: Delivery[] = [];
    const jobIds: string[] = [];

    for (const account of accounts) {
      for (let job = 0; job < JOBS_PER_ACCOUNT; job += 1) {
        const jobId = `job-${account.accountId}-${job}`;
        jobIds.push(jobId);
        starts.push({ ...account, jobId, deliverAt: BASE_MS });
      }
    }

    let events = 0;
    while ((starts.length > 0 || deliveries.length > 0) && events < MAX_EVENTS) {
      events += 1;
      starts.sort((a, b) => a.deliverAt - b.deliverAt);
      deliveries.sort((a, b) => a.deliverAt - b.deliverAt);
      const nextStart = starts[0];
      const nextDelivery = deliveries[0];
      if (nextDelivery && (!nextStart || nextDelivery.deliverAt <= nextStart.deliverAt)) {
        clock = Math.max(clock, nextDelivery.deliverAt);
        deliveries.shift();
        const before = queue.sent.length;
        const outcome = await processProvisioningMessage(nextDelivery.jobId, env, {
          fetcher,
          now,
          sleep: async () => {},
          rng,
        });
        if (outcome.outcome === 'retry') {
          expect(outcome.delaySeconds).toBeGreaterThanOrEqual(1);
          deliveries.push({ jobId: nextDelivery.jobId, deliverAt: clock + outcome.delaySeconds * 1000 });
        }
        // Fresh continuation messages re-enter the schedule at the delay the
        // consumer attached — gate waits carry one, successful-step
        // continuations advance immediately because they made progress.
        for (const sent of queue.sent.slice(before)) {
          const delaySeconds = sent.delaySeconds;
          expect(delaySeconds === null || delaySeconds >= 1).toBe(true);
          deliveries.push({ jobId: sent.jobId, deliverAt: clock + (delaySeconds ?? 0) * 1000 });
        }
      } else {
        // The sync start path, exactly as finishGithubCallback runs it.
        clock = Math.max(clock, nextStart.deliverAt);
        starts.shift();
        const decision = await acquireProvisioningStart(kv as unknown as KVNamespace, {
          accountId: nextStart.accountId,
          jobId: nextStart.jobId,
        }, config, now());
        if (!decision.granted) {
          expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          starts.push({ ...nextStart, deliverAt: clock + decision.retryAfterSeconds * 1000 });
          continue;
        }
        const generatedIdentity = {
          ...generated,
          fullName: `${nextStart.login}/${nextStart.login}.github.io`,
          name: `${nextStart.login}.github.io`,
          htmlUrl: `https://github.com/${nextStart.login}/${nextStart.login}.github.io`,
        };
        try {
          // beforeCreate: budget is consumed per real generate POST, before it fires.
          const budget = await consumeGlobalMutationBudget(kv as unknown as KVNamespace, config, now(), rng);
          if (!budget.admitted) {
            throw new ProvisioningGateRefusedError({
              granted: false,
              reason: budget.reason,
              retryAfterSeconds: budget.delaySeconds,
            });
          }
          gatedMutations.push({ kind: 'generate', atMs: now() });
          const job = createProvisioningJob({
            jobId: nextStart.jobId,
            installationId: nextStart.installationId,
            identity: { id: nextStart.accountId, login: nextStart.login, accountType: 'User' },
            repository: {
              name: `${nextStart.login}.github.io`,
              url: `https://${nextStart.login}.github.io`,
              baseurl: '',
              kind: 'apex',
            },
            generatedRepository: generatedIdentity,
            now: now(),
          });
          await saveProvisioningJob(kv as unknown as KVNamespace, job);
        } catch (error) {
          if (error instanceof ProvisioningGateRefusedError) {
            // The callback's finally: nothing was enqueued, so the lease is
            // released and the start is retried later.
            await releaseProvisioningLeaseIfOwned(kv as unknown as KVNamespace, nextStart.accountId, nextStart.jobId);
            expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            starts.push({ ...nextStart, deliverAt: clock + error.retryAfterSeconds * 1000 });
            continue;
          }
          throw error;
        }
        deliveries.push({ jobId: nextStart.jobId, deliverAt: clock });
      }
    }

    expect(events).toBeLessThan(MAX_EVENTS);
    expect(starts).toEqual([]);
    expect(deliveries).toEqual([]);

    // Every job reached a terminal status, and no terminal or step record
    // blames the throttle.
    for (const jobId of jobIds) {
      const job = await loadProvisioningJob(kv as unknown as KVNamespace, jobId);
      expect(job, jobId).not.toBeNull();
      expect(job!.status, jobId).toBe('succeeded');
      for (const step of Object.values(job!.steps)) {
        expect(step.lastError?.code).not.toBe('github_provisioning_superseded');
        expect(step.lastError?.code).not.toBe('provisioning_step_failed');
      }
    }
    for (const account of accounts) {
      expect(await kv.get(accountLeaseKey(account.accountId))).toBeNull();
    }

    // The KV-honest bound, observed: every fixed window's gated mutations
    // stayed within the configured budgets.
    const perMinute = new Map<number, number>();
    const perHour = new Map<number, number>();
    for (const mutation of gatedMutations) {
      const minute = Math.floor(mutation.atMs / 60_000);
      const hour = Math.floor(mutation.atMs / 3_600_000);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }
    expect(gatedMutations.length).toBeGreaterThan(config.mutationsPerMinute);
    for (const count of perMinute.values()) expect(count).toBeLessThanOrEqual(config.mutationsPerMinute);
    for (const count of perHour.values()) expect(count).toBeLessThanOrEqual(config.mutationsPerHour);
  });
});
