/**
 * Automated half of the launch checklist (docs/launch-checklist.md): the
 * checks a URL can answer without credentials. Run against any deployment,
 * staging or production:
 *
 *   bun run scripts/launch-gate.ts [BASE_URL]
 *
 * Exits nonzero if any check fails, so the checklist's "verify public
 * policy/callback URLs" row is a command, not a memory exercise. The drills,
 * the smoke test, and the two-person approval stay manual; this script only
 * proves what is publicly reachable.
 */
import { POLICY_PATHS } from '../src/policy-pages';

const BASE_URL = process.argv[2] ?? 'https://notiongit.notiongit.workers.dev';

interface Check {
  readonly name: string;
  readonly run: () => Promise<string | null>;
}

function trim(url: string): string {
  return `${BASE_URL.replace(/\/$/u, '')}${url}`;
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.text() };
}

const CHECKS: readonly Check[] = [
  {
    name: 'healthz answers ok',
    run: async () => {
      const { status, body } = await fetchText(trim('/healthz'));
      return status === 200 && body.includes('"ok":true') ? null : `status ${status}, body ${body.slice(0, 80)}`;
    },
  },
  {
    name: 'landing page serves and carries the consent CTA',
    run: async () => {
      const { status, body } = await fetchText(trim('/'));
      return status === 200 && body.includes('href="/connect/github"')
        ? null
        : `status ${status}, CTA ${body.includes('/connect/github') ? 'present' : 'missing'}`;
    },
  },
  {
    name: 'landing page links every policy page',
    run: async () => {
      const { status, body } = await fetchText(trim('/'));
      if (status !== 200) return `status ${status}`;
      const missing = POLICY_PATHS.filter((path) => !body.includes(`href="${path}"`));
      return missing.length === 0 ? null : `missing ${missing.join(', ')}`;
    },
  },
  ...POLICY_PATHS.map((path): Check => ({
    name: `policy page ${path} serves`,
    run: async () => {
      const { status, body } = await fetchText(trim(path));
      const shaped = body.includes('<h1') && body.includes('Skip to content') && !body.includes('<script');
      return status === 200 && shaped ? null : `status ${status}, shaped ${shaped}`;
    },
  })),
  {
    name: 'GitHub callback route is wired (rejects a stateless request)',
    run: async () => {
      const { status, body } = await fetchText(trim('/auth/github/callback'));
      return status === 400 && body.includes('We could not complete this step')
        ? null
        : `status ${status}, error page ${body.includes('We could not complete this step') ? 'present' : 'missing'}`;
    },
  },
  {
    name: 'InkDrafts GitHub App is public at its install URL',
    run: async () => {
      const response = await fetch('https://github.com/apps/inkdrafts', { signal: AbortSignal.timeout(20_000) });
      return response.status === 200 ? null : `status ${response.status}`;
    },
  },
  ...['notiongit', 'notiongit-template', 'notiongit-sync'].map((repo): Check => ({
    name: `public repository inkdrafts/${repo} is reachable`,
    run: async () => {
      const response = await fetch(`https://github.com/inkdrafts/${repo}`, { signal: AbortSignal.timeout(20_000) });
      return response.status === 200 ? null : `status ${response.status}`;
    },
  })),
];

const results: { name: string; outcome: string }[] = [];
let failures = 0;
for (const check of CHECKS) {
  let outcome: string;
  try {
    outcome = (await check.run()) ?? 'pass';
  } catch (error) {
    outcome = `threw ${(error as Error).name}: ${(error as Error).message}`;
  }
  if (outcome !== 'pass') failures += 1;
  results.push({ name: check.name, outcome });
  console.log(`${outcome === 'pass' ? 'PASS' : 'FAIL'}\t${check.name}\t${outcome === 'pass' ? '' : outcome}`);
}

console.error(`\n${CHECKS.length - failures}/${CHECKS.length} checks passed against ${BASE_URL}`);
process.exit(failures === 0 ? 0 : 1);
