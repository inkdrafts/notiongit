/**
 * Capture a fresh, UNCONSUMED GitHub OAuth code for manual callback replay.
 *
 * Mints a signed state from the deployment's /connect/github, then drives the
 * real authorize page with the copied user session while DNS-blocking the
 * deployment host, so GitHub's redirect to the callback fails in-browser and
 * the worker never consumes the code. Prints JSON to stdout:
 *   { state, code, callbackUrl }
 *
 * Usage:
 *   bun run capture-code.ts <BASE>
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'https://inkdrafts.com';
const CLIENT_ID = process.argv[3] ?? 'Iv23liOBHu6mtSi3OU2y';
const ART_DIR = `.zcode/skills/verify-notiongit/artifacts/capture-${Date.now()}`;
mkdirSync(ART_DIR, { recursive: true });

const host = new URL(BASE).host;

function buildUserProfile(): string {
  const src = join(homedir(), '.config', 'google-chrome');
  const dst = join(import.meta.dir, '.user-profile');
  mkdirSync(join(dst, 'Default'), { recursive: true });
  copyFileSync(join(src, 'Local State'), join(dst, 'Local State'));
  copyFileSync(join(src, 'Default', 'Cookies'), join(dst, 'Default', 'Cookies'));
  return dst;
}

const stateRes = await fetch(`${BASE}/connect/github`, { redirect: 'manual' });
const location = stateRes.headers.get('location') ?? '';
if (!location.includes('state=')) throw new Error(`/connect/github answered ${stateRes.status} without a redirect`);
const signed = new URL(location).searchParams.get('state')!;

const context = await chromium.launchPersistentContext(buildUserProfile(), {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: ['--profile-directory=Default', '--password-store=basic'],
});

// The app authorization is already granted, so the authorize endpoint answers
// 302 with a fresh code in the Location header. Firing it through the
// context's request client (which shares the session cookies) with redirects
// disabled issues the code WITHOUT the callback ever being followed — the
// worker never consumes it and the code stays valid for manual replay.
const authRes = await context.request.get(
  `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(`${BASE}/auth/github/callback`)}&state=${encodeURIComponent(signed)}`,
  { maxRedirects: 0 },
);
const callbackUrl = authRes.headers().location ?? '';
if (!callbackUrl.includes('code=')) {
  await context.close();
  throw new Error(`authorize answered ${authRes.status()} without a code redirect (authorization may be revoked)`);
}
await context.close();

const url = new URL(callbackUrl);
const code = url.searchParams.get('code');
if (!code) throw new Error(`no code in callback URL: ${callbackUrl.slice(0, 120)}`);
const result = { state: url.searchParams.get('state') ?? signed, code, callbackUrl };
writeFileSync(join(ART_DIR, 'captured.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
