// Capture a fresh GitHub OAuth code against a caller-supplied signed state.
// GitHub may re-prompt the consent interstitial; clicking Authorize once
// re-activates the grant (the callback it redirects to is a production URL
// whose state check rejects the code harmlessly), after which a redirect-only
// request issues an unconsumed code for local replay.
import { mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const STATE = process.argv[2]!;
const CLIENT_ID = process.argv[3] ?? 'Iv23liOBHu6mtSi3OU2y';
const REDIRECT = 'https://inkdrafts.com/auth/github/callback';
const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(STATE)}`;

const src = join(homedir(), '.config', 'google-chrome');
const dst = join(import.meta.dir, '.user-profile');
mkdirSync(join(dst, 'Default'), { recursive: true });
copyFileSync(join(src, 'Local State'), join(dst, 'Local State'));
copyFileSync(join(src, 'Default', 'Cookies'), join(dst, 'Default', 'Cookies'));

const context = await chromium.launchPersistentContext(dst, {
  channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 },
  args: ['--profile-directory=Default', '--password-store=basic'],
});
const res = await context.request.get(authUrl, { maxRedirects: 0 });
let location = res.headers().location ?? '';
if (!location.includes('code=')) {
  const page = await context.newPage();
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' });
  const button = page.getByRole('button', { name: /^authorize inkdrafts$|^authorize$/i }).first();
  if (!(await button.count())) throw new Error(`no Authorize button on ${page.url()}`);
  await Promise.all([page.waitForLoadState('load'), button.click()]);
  const res2 = await context.request.get(authUrl, { maxRedirects: 0 });
  location = res2.headers().location ?? '';
}
await context.close();
if (!location.includes('code=')) throw new Error('no code redirect even after consent click');
console.log(JSON.stringify({ code: new URL(location).searchParams.get('code') }));
