import { describe, expect, test } from 'bun:test';

import { LANDING_PAGE } from '../src/landing-page';

describe('landing page', () => {
  test('is a complete, English-language document with the expected title', () => {
    expect(LANDING_PAGE.startsWith('<!doctype html>')).toBe(true);
    expect(LANDING_PAGE).toContain('<html lang="en">');
    expect(LANDING_PAGE).toContain('<title>InkDrafts</title>');
  });

  test('has no client JavaScript and makes no external requests', () => {
    expect(LANDING_PAGE).not.toContain('<script');
    expect(LANDING_PAGE).not.toMatch(/\shref="https?:\/\/(?!github\.com|inkdrafts\.com)/u);
    expect(LANDING_PAGE).not.toMatch(/\ssrc="https?:\/\//u);
  });

  test('stays within a small performance budget', () => {
    expect(new TextEncoder().encode(LANDING_PAGE).byteLength).toBeLessThan(20_000);
  });

  test('exposes accessible landmarks and a single top-level heading', () => {
    expect(LANDING_PAGE).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(LANDING_PAGE).toContain('class="skip-link" href="#main-content"');
    expect(LANDING_PAGE).toContain('<main id="main-content">');
    expect(LANDING_PAGE).toContain('<header>');
    expect(LANDING_PAGE).toContain('<footer>');
    expect(LANDING_PAGE.match(/<h1[ >]/gu)).toHaveLength(1);
    expect(LANDING_PAGE.match(/<nav aria-label="/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  test('carries basic social-preview metadata', () => {
    expect(LANDING_PAGE).toContain('<meta name="description" content="');
    expect(LANDING_PAGE).toContain('<meta property="og:title"');
    expect(LANDING_PAGE).toContain('<meta property="og:description"');
    expect(LANDING_PAGE).toContain('<meta property="og:url" content="https://inkdrafts.com/">');
    expect(LANDING_PAGE).toContain('<meta name="twitter:card" content="summary">');
    expect(LANDING_PAGE).toContain('<link rel="canonical" href="https://inkdrafts.com/">');
  });

  test('explains what InkDrafts creates, owns, and costs', () => {
    expect(LANDING_PAGE).toContain('Creates</h3>');
    expect(LANDING_PAGE).toContain('Owns</h3>');
    expect(LANDING_PAGE).toContain('Costs</h3>');
    expect(LANDING_PAGE).toMatch(/GitHub Pages/u);
    expect(LANDING_PAGE).toMatch(/own|yours/iu);
  });

  test('shows the real three-stage flow, GitHub first', () => {
    expect(LANDING_PAGE).toContain('<h3>Connect GitHub</h3>');
    expect(LANDING_PAGE).toContain('<h3>Connect Notion</h3>');
    expect(LANDING_PAGE).toContain('<h3>Your site goes live</h3>');
    expect(LANDING_PAGE.indexOf('<h3>Connect GitHub</h3>')).toBeLessThan(LANDING_PAGE.indexOf('<h3>Connect Notion</h3>'));
  });

  test('has exactly one primary CTA, into /connect/github', () => {
    const ctaMatches = [...LANDING_PAGE.matchAll(/class="cta"[^>]*href="([^"]+)"/gu)];
    expect(ctaMatches).toHaveLength(1);
    expect(ctaMatches[0]?.[1]).toBe('/connect/github');
  });

  test('never links the unadvertised GitHub App install page directly', () => {
    expect(LANDING_PAGE).not.toContain('github.com/apps/inkdrafts');
  });

  test('links privacy/security and developer/open-source content', () => {
    expect(LANDING_PAGE).toContain('id="privacy-security"');
    expect(LANDING_PAGE).toContain('href="#privacy-security"');
    expect(LANDING_PAGE).toContain('id="open-source"');
    expect(LANDING_PAGE).toContain('href="#open-source"');
    expect(LANDING_PAGE).toContain('https://github.com/inkdrafts/notiongit"');
    expect(LANDING_PAGE).toContain('https://github.com/inkdrafts/notiongit-template"');
    expect(LANDING_PAGE).toContain('https://github.com/inkdrafts/notiongit-sync"');
  });

  test('does not promise unimplemented features', () => {
    const lower = LANDING_PAGE.toLowerCase();
    expect(lower).not.toContain('custom domain');
    expect(lower).not.toContain('instant');
    expect(lower).not.toContain('pricing');
  });
});
