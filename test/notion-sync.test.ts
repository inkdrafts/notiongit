import { describe, expect, test } from 'bun:test';

import {
  awaitNotionSyncRun,
  correlateDispatchedSyncRun,
  dispatchAndCorrelateNotionSync,
  dispatchNotionSyncWorkflow,
  GithubSyncError,
  latestDispatchedSyncRun,
  latestSyncRunSummary,
  listWorkflowRunIds,
  SYNC_WORKFLOW_FILE,
} from '../src/notion-sync';

const REPOSITORY = 'alice/alice.github.io';
const INSTALLATION_TOKEN = 'installation-token';
const RUNS_URL = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${SYNC_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`;
const DISPATCH_URL = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${SYNC_WORKFLOW_FILE}/dispatches`;
const ARTIFACTS_URL = `https://api.github.com/repos/${REPOSITORY}/actions/runs/555/artifacts?name=notiongit-run-summary&per_page=1`;
const ARCHIVE_URL = `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/9/zip`;

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 555,
    html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'commit-sha',
    created_at: new Date().toISOString(),
    event: 'workflow_dispatch',
    ...overrides,
  };
}

async function zipSummary(text: string, method: 0 | 8): Promise<ArrayBuffer> {
  const name = new TextEncoder().encode('run-summary.json');
  const plain = new TextEncoder().encode(text);
  const data = method === 0
    ? plain
    : new Uint8Array(await new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer());
  const local = new Uint8Array(30 + name.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(8, method, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, plain.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, method, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, plain.length, true);
  centralView.setUint16(28, name.length, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);
  const zip = new Uint8Array(local.length + central.length + end.length);
  zip.set(local);
  zip.set(central, local.length);
  zip.set(end, local.length + central.length);
  return zip.buffer;
}

describe('dispatchNotionSyncWorkflow', () => {
  test('dispatches on main with safe default bulk-delete behavior', async () => {
    const requests: Request[] = [];
    await dispatchNotionSyncWorkflow(INSTALLATION_TOKEN, REPOSITORY, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return response(204);
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(DISPATCH_URL);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(await requests[0].json()).toEqual({ ref: 'main', inputs: { allow_bulk_delete: 'false' } });
  });

  test('reports rate limits and unavailability distinctly', async () => {
    await expect(dispatchNotionSyncWorkflow(INSTALLATION_TOKEN, REPOSITORY, async () =>
      response(403, {}, { 'retry-after': '30' }))).rejects.toMatchObject({
      code: 'github_sync_rate_limited',
      status: 429,
      retryAfterSeconds: 30,
    });

    await expect(dispatchNotionSyncWorkflow(INSTALLATION_TOKEN, REPOSITORY, async () =>
      response(404))).rejects.toMatchObject({ code: 'github_sync_dispatch_unavailable' });

    await expect(dispatchNotionSyncWorkflow(INSTALLATION_TOKEN, REPOSITORY, async () =>
      response(500))).rejects.toMatchObject({ code: 'github_sync_unavailable' });
  });
});

describe('listWorkflowRunIds', () => {
  test('snapshots current run ids for correlation', async () => {
    const ids = await listWorkflowRunIds(INSTALLATION_TOKEN, REPOSITORY, async (input) => {
      expect(String(input)).toBe(RUNS_URL);
      return response(200, { workflow_runs: [run({ id: 1 }), run({ id: 2 })] });
    });
    expect(ids).toEqual(new Set([1, 2]));
  });
});

describe('latestDispatchedSyncRun', () => {
  const LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${SYNC_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=1`;

  test('returns the newest dispatched run with its timestamps', async () => {
    const identity = await latestDispatchedSyncRun(INSTALLATION_TOKEN, REPOSITORY, async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(LATEST_URL);
      expect(request.headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      return response(200, {
        workflow_runs: [run({ created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:05:00Z' })],
      });
    });
    expect(identity).toEqual({
      runId: 555,
      htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555',
      status: 'completed',
      conclusion: 'success',
      headSha: 'commit-sha',
      createdAtMs: Date.parse('2026-09-01T10:00:00Z'),
      updatedAtMs: Date.parse('2026-09-01T10:05:00Z'),
    });
  });

  test('null means the read succeeded and no run exists', async () => {
    await expect(latestDispatchedSyncRun(INSTALLATION_TOKEN, REPOSITORY, async () => response(200, { workflow_runs: [] })))
      .resolves.toBeNull();
  });

  test('a failed read throws so never-ran stays distinguishable from cannot-tell', async () => {
    await expect(latestDispatchedSyncRun(INSTALLATION_TOKEN, REPOSITORY, async () => response(500)))
      .rejects.toMatchObject({ code: 'github_sync_unavailable', status: 502 });
  });

  test('skips an unusable run shape instead of returning it', async () => {
    await expect(latestDispatchedSyncRun(INSTALLATION_TOKEN, REPOSITORY, async () =>
      response(200, { workflow_runs: [{ id: 'nope' }] }))).resolves.toBeNull();
  });
});

describe('latestSyncRunSummary', () => {
  const payload = JSON.stringify({ schema_version: 1, result: 'no_op', code: 'missing_credentials' });

  test('reads the named run artifact and unzips its summary', async () => {
    const requests: Request[] = [];
    const summary = await latestSyncRunSummary(INSTALLATION_TOKEN, REPOSITORY, 555, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === ARTIFACTS_URL) return response(200, { artifacts: [{ id: 9, name: 'notiongit-run-summary', expired: false }] });
      expect(request.url).toBe(ARCHIVE_URL);
      return new Response(await zipSummary(payload, 8), { status: 200 });
    });
    expect(summary).toBe(payload);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  test('falls back when the artifact is absent, expired, or unreadable', async () => {
    await expect(latestSyncRunSummary(INSTALLATION_TOKEN, REPOSITORY, 555, async () =>
      response(200, { artifacts: [] }))).resolves.toBeNull();
    await expect(latestSyncRunSummary(INSTALLATION_TOKEN, REPOSITORY, 555, async () =>
      response(200, { artifacts: [{ id: 9, name: 'notiongit-run-summary', expired: true }] }))).resolves.toBeNull();
    await expect(latestSyncRunSummary(INSTALLATION_TOKEN, REPOSITORY, 555, async (input) =>
      String(input).includes('/artifacts?')
        ? response(200, { artifacts: [{ id: 9, name: 'notiongit-run-summary', expired: false }] })
        : new Response('not a zip', { status: 200 }))).resolves.toBeNull();
  });
});

describe('correlateDispatchedSyncRun', () => {
  test('finds the first run created after dispatch that was not already known', async () => {
    let calls = 0;
    const identity = await correlateDispatchedSyncRun(
      INSTALLATION_TOKEN,
      REPOSITORY,
      new Set([1, 2]),
      Date.now(),
      {
        fetcher: async () => {
          calls += 1;
          return calls < 2
            ? response(200, { workflow_runs: [run({ id: 1 })] })
            : response(200, { workflow_runs: [run({ id: 3 }), run({ id: 1 })] });
        },
        sleep: async () => {},
      },
    );
    expect(identity.runId).toBe(3);
    expect(calls).toBe(2);
  });

  test('ignores a run older than the dispatch even when its id is new', async () => {
    const dispatchedAtMs = Date.now();
    await expect(correlateDispatchedSyncRun(
      INSTALLATION_TOKEN,
      REPOSITORY,
      new Set(),
      dispatchedAtMs,
      {
        maxAttempts: 2,
        fetcher: async () => response(200, {
          workflow_runs: [run({ id: 9, created_at: new Date(dispatchedAtMs - 60_000).toISOString() })],
        }),
        sleep: async () => {},
      },
    )).rejects.toMatchObject({ code: 'github_sync_correlate_timeout', status: 504 });
  });

  test('times out when no matching run ever appears', async () => {
    const delays: number[] = [];
    await expect(correlateDispatchedSyncRun(
      INSTALLATION_TOKEN,
      REPOSITORY,
      new Set([1]),
      Date.now(),
      {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 40,
        fetcher: async () => response(200, { workflow_runs: [run({ id: 1 })] }),
        sleep: async (ms) => delays.push(ms),
      },
    )).rejects.toMatchObject({ code: 'github_sync_correlate_timeout', status: 504 });
    expect(delays).toEqual([10, 20]);
  });
});

describe('dispatchAndCorrelateNotionSync', () => {
  test('never dispatches twice: snapshot excludes pre-existing runs from correlation', async () => {
    let dispatched = false;
    const identity = await dispatchAndCorrelateNotionSync(INSTALLATION_TOKEN, REPOSITORY, {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === 'POST') {
          dispatched = true;
          return response(204);
        }
        return response(200, {
          workflow_runs: dispatched ? [run({ id: 42 }), run({ id: 1 })] : [run({ id: 1 })],
        });
      },
      sleep: async () => {},
    });
    expect(identity.runId).toBe(42);
  });
});

describe('awaitNotionSyncRun', () => {
  test('polls until the run completes', async () => {
    let calls = 0;
    const delays: number[] = [];
    const identity = await awaitNotionSyncRun(INSTALLATION_TOKEN, REPOSITORY, 555, {
      initialDelayMs: 5,
      maxDelayMs: 20,
      fetcher: async () => {
        calls += 1;
        return calls < 3 ? response(200, run({ status: 'in_progress', conclusion: null })) : response(200, run());
      },
      sleep: async (ms) => delays.push(ms),
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([5, 10]);
    expect(identity).toMatchObject({ runId: 555, conclusion: 'success' });
  });

  test('reports a completed run with a failing conclusion distinctly', async () => {
    await expect(awaitNotionSyncRun(INSTALLATION_TOKEN, REPOSITORY, 555, {
      fetcher: async () => response(200, run({ conclusion: 'failure' })),
    })).rejects.toMatchObject({ code: 'github_sync_run_failed', status: 502 });
  });

  test('times out a run that never completes', async () => {
    await expect(awaitNotionSyncRun(INSTALLATION_TOKEN, REPOSITORY, 555, {
      maxAttempts: 2,
      initialDelayMs: 1,
      fetcher: async () => response(200, run({ status: 'in_progress', conclusion: null })),
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'github_sync_run_timeout', status: 504 });
  });

  test('does not retry a permission failure', async () => {
    let calls = 0;
    await expect(awaitNotionSyncRun(INSTALLATION_TOKEN, REPOSITORY, 555, {
      fetcher: async () => {
        calls += 1;
        return response(403);
      },
      sleep: async () => {
        throw new Error('must not sleep after a non-retryable failure');
      },
    })).rejects.toBeInstanceOf(GithubSyncError);
    expect(calls).toBe(1);
  });
});
