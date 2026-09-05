/**
 * Automated accessibility gate: every representative page state is scanned
 * with axe-core inside jsdom and must report zero serious or critical
 * violations. Layout-dependent checks (notably color contrast) resolve as
 * "incomplete" rather than violations without a real layout engine, so the
 * manual matrix in docs/accessibility.md covers those in a real browser.
 *
 * The canary scan proves the gate can fail: a document with planted
 * structural violations must be reported, so a future harness regression
 * cannot silently scan nothing.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

import { LANDING_PAGE } from '../src/landing-page';

const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// jsdom's "not implemented" notices (pseudo-element styles, canvas) are
// expected here and must not pollute the test output.
const silentConsole = new VirtualConsole();

interface AxeNode {
  readonly target: readonly string[];
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}

/** Runs axe against a full document and returns only its violations. */
function runAxe(documentHtml: string): Promise<readonly AxeViolation[]> {
  const { window } = new JSDOM(documentHtml, { pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: silentConsole });
  // jsdom has no layout engine, so hit-testing has no real answer; an empty
  // result degrades the dependent checks to "incomplete" instead of crashing.
  (window.document as unknown as { elementsFromPoint: () => unknown[] }).elementsFromPoint = () => [];
  window.eval(axeSource);
  const axe = window.eval('axe') as {
    run: (context: Document, options: object, callback: (error: Error | null, results: { violations: AxeViolation[] }) => void) => void;
  };
  return new Promise((resolve, reject) => {
    axe.run(window.document, { resultTypes: ['violations'] }, (error, results) => {
      if (error) reject(error);
      else resolve(results.violations);
      window.close();
    });
  });
}

function seriousOrCritical(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
}

/** Empty when clean; otherwise one line per violation so a CI failure names
 * the rule, its impact, and the selectors it hit. */
function violationReport(violations: readonly AxeViolation[]): string {
  return violations
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.help} at ${violation.nodes.map((node) => node.target.join(' ')).join('; ')}`)
    .join('\n');
}

async function expectAccessible(documentHtml: string): Promise<void> {
  const serious = seriousOrCritical(await runAxe(documentHtml));
  expect(violationReport(serious)).toBe('');
}

const CANARY = `<!doctype html>
<html>
<head><title>canary</title></head>
<body>
<img src="logo.png">
<input type="text">
<button></button>
</body>
</html>`;

describe('accessibility suite', () => {
  test('the scanner reports planted structural violations', async () => {
    const serious = seriousOrCritical(await runAxe(CANARY));
    const rules = new Set(serious.map((violation) => violation.id));
    expect(rules.has('image-alt')).toBe(true);
    expect(rules.has('label')).toBe(true);
    expect(rules.has('button-name')).toBe(true);
  });

  test('landing page has no serious or critical violations', async () => {
    await expectAccessible(LANDING_PAGE);
  });
});
