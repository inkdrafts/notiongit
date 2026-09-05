/**
 * Kill-switch drill from the launch checklist (docs/launch-checklist.md §C)
 * and docs/provisioning-admission-runbook.md. Drives one provisioning
 * admission through the operator KV control — allow, kill, pause, resume —
 * against a live deployment and checks the audit records the runbook says
 * an operator will later rely on:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *   bun run scripts/drill-admission-control.ts <BASE_URL> <JOBS_KV_NAMESPACE_ID>
 *
 * The token needs Workers KV write on the namespace and is read from the
 * environment, never printed. Exits nonzero if any step fails.
 */

const BASE_URL = (process.argv[2] ?? '').replace(/\/$/u, '');
const NAMESPACE_ID = process.argv[3] ?? '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

const CONTROL_KEY = 'provisioning:admission:control';
const AUDIT_PREFIX = 'provisioning:admission:audit:';
const STAGE = 'github_connect';

if (!BASE_URL || !NAMESPACE_ID || !ACCOUNT_ID || !API_TOKEN) {
  console.error('usage: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun run scripts/drill-admission-control.ts <BASE_URL> <JOBS_KV_NAMESPACE_ID>');
  process.exit(2);
}

interface ControlRecord {
  version: 1;
  mode: 'active' | 'pause' | 'kill';
  pausedStages: string[];
  rejectedStages: string[];
  updatedAt: number;
  expiresAt: null;
}

function controlRecord(mode: ControlRecord['mode']): string {
  const record: ControlRecord = {
    version: 1,
    mode,
    pausedStages: [],
    rejectedStages: [],
    updatedAt: Date.now(),
    expiresAt: null,
  };
  return JSON.stringify(record);
}

const kvUrl = (key: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${encodeURIComponent(key)}`;

async function kvPut(key: string, value: string): Promise<void> {
  const response = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: new Headers({ Authorization: `Bearer ${API_TOKEN}` }),
    body: value,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`KV PUT ${key} failed with status ${response.status}`);
}

async function kvGet(key: string): Promise<string | null> {
  const response = await fetch(kvUrl(key), {
    headers: new Headers({ Authorization: `Bearer ${API_TOKEN}` }),
    signal: AbortSignal.timeout(20_000),
  });
  return response.status === 404 ? null : response.text();
}

async function connectGithub(jobId: string): Promise<{ status: number; location: string | null; body: string }> {
  const response = await fetch(`${BASE_URL}/connect/github?job_id=${encodeURIComponent(jobId)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, location: response.headers.get('location'), body: await response.text() };
}

/** KV is eventually consistent: the next request may still see the previous
 * control value, so every state change polls briefly instead of asserting
 * against one race-prone observation. */
async function waitFor(what: string, deadlineMs: number, probe: () => Promise<string | null>): Promise<string | null> {
  let observed: string | null = null;
  while (Date.now() < deadlineMs) {
    observed = await probe();
    if (observed !== null) return observed;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return observed;
}

const results: Array<{ ok: boolean; step: string; observed: string }> = [];

function record(ok: boolean, step: string, observed: string): void {
  results.push({ ok, step, observed });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${step}\t${observed}`);
}

function jobId(stage: string): string {
  return `drill-${stage}-${Date.now()}`;
}

async function expectRedirect(step: string, id: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { status, location } = await connectGithub(id);
    if (status === 302 && location !== null && new URL(location).host === 'github.com') {
      record(true, step, `302 to ${new URL(location).host}`);
      return;
    }
    if (Date.now() >= deadline) {
      record(false, step, `status ${status}, location ${location ?? 'none'}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function expectRefusal(step: string, id: string, code: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { status, body } = await connectGithub(id);
    if (status === 503 && body.includes(`Error code: <code>${code}</code>`)) {
      record(true, step, `503 with ${code}`);
      return;
    }
    if (Date.now() >= deadline) {
      record(false, step, `status ${status}, code ${body.match(/Error code: <code>([^<]+)/)?.[1] ?? 'none'}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function expectAudit(step: string, id: string, decision: string, reason: string): Promise<void> {
  const key = `${AUDIT_PREFIX}${id}:${STAGE}:${reason}`;
  const raw = await waitFor(step, Date.now() + 15_000, () => kvGet(key));
  if (raw === null) {
    record(false, step, `no audit record at ${key}`);
    return;
  }
  let audit: { version?: number; jobId?: string; stage?: string; decision?: string; reason?: string };
  try {
    audit = JSON.parse(raw);
  } catch {
    record(false, step, 'audit record is not JSON');
    return;
  }
  const matches = audit.version === 1 && audit.jobId === id && audit.stage === STAGE
    && audit.decision === decision && audit.reason === reason;
  record(matches, step, matches ? `${decision}/${reason} recorded` : `unexpected record ${raw.slice(0, 120)}`);
}

const killId = jobId('kill');
const pauseId = jobId('pause');
const resumeId = jobId('resume');

await expectRedirect('provisioning admits before the control is written', jobId('baseline'));
await kvPut(CONTROL_KEY, controlRecord('kill'));
await expectRefusal('kill control refuses new provisioning', killId, 'provisioning_rejected');
await expectAudit('kill refusal leaves an audit record', killId, 'reject', 'global_kill');
await kvPut(CONTROL_KEY, controlRecord('pause'));
await expectRefusal('pause control holds new provisioning', pauseId, 'provisioning_paused');
await expectAudit('pause holds leave an audit record', pauseId, 'pause', 'global_pause');
await kvPut(CONTROL_KEY, controlRecord('active'));
await expectRedirect('resume with an active control admits again', resumeId);

const failed = results.filter((result) => !result.ok).length;
console.error(`\n${results.length - failed}/${results.length} drill steps passed against ${BASE_URL}`);
process.exit(failed === 0 ? 0 : 1);
