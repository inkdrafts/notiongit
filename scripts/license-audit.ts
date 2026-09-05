/**
 * Dependency license audit for the launch checklist (docs/launch-checklist.md).
 * Reads every direct dependency of the root package and the two spike
 * workspaces from the installed node_modules, asserts each license against a
 * permissive allowlist, and exits nonzero on anything outside it:
 *
 *   bun run scripts/license-audit.ts
 */
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC-BY-4.0',
]);

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const MANIFESTS = ['package.json', 'spikes/libsodium-workers/package.json', 'spikes/notion-oauth-template/package.json'];

const ROOT = new URL('..', import.meta.url).pathname;

function workspaceNames(manifest: Manifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
}

function insideAllowlist(expression: string): boolean {
  return expression.split(/\s+OR\s+/u).every((choice) => ALLOWED.has(choice));
}

function licenseOf(pkgName: string, workspace: string): { version: string; license: string } {
  const manifest = JSON.parse(readFileSync(`${ROOT}${workspace}/node_modules/${pkgName}/package.json`, 'utf8')) as Manifest;
  const license = manifest.license;
  const text = typeof license === 'string' ? license : Array.isArray(license) ? license.map((entry) => (typeof entry === 'string' ? entry : entry.type)).join(' OR ') : license?.type ?? 'UNKNOWN';
  return { version: manifest.version ?? '?', license: text };
}

const rows: { pkg: string; version: string; license: string; problem: string }[] = [];
let failures = 0;
for (const manifestPath of MANIFESTS) {
  const workspace = manifestPath.replace(/\/package\.json$/u, '');
  const manifest = JSON.parse(readFileSync(`${ROOT}${manifestPath}`, 'utf8')) as Manifest;
  for (const name of workspaceNames(manifest)) {
    let version = '?';
    let license = 'UNKNOWN';
    let problem = '';
    try {
      const found = licenseOf(name, workspace);
      version = found.version;
      license = found.license;
      if (!insideAllowlist(license)) problem = 'outside allowlist';
    } catch {
      try {
        const found = licenseOf(name, '.');
        version = found.version;
        license = found.license;
        if (!insideAllowlist(license)) problem = 'outside allowlist';
      } catch (error) {
        problem = `unreadable: ${(error as Error).message.split('\n')[0]}`;
      }
    }
    if (problem) failures += 1;
    rows.push({ pkg: name, version, license, problem });
    console.log(`${problem === '' ? 'OK  ' : 'FAIL'}\t${name}@${version}\t${license}\t${problem}`);
  }
}

console.error(`\n${rows.length - failures}/${rows.length} direct dependencies inside the allowlist`);
process.exit(failures === 0 ? 0 : 1);
