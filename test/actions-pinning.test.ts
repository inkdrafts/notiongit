import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');

interface UseRef {
  value: string;
  line: string;
}

function usesWithLines(text: string): UseRef[] {
  const refs: UseRef[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const match = /uses:\s*['"]?([^\s'"]+)/u.exec(line);
    if (match) refs.push({ value: match[1], line });
  }
  return refs;
}

describe('workflow action pinning', () => {
  test('pins every third-party action to a full commit SHA with a version comment', () => {
    const uses = readdirSync(WORKFLOWS_DIR)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort()
      .flatMap((file) =>
        usesWithLines(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')).map((ref) => ({ file, ref })),
      );
    expect(uses.length).toBeGreaterThan(0);

    const violations = uses.flatMap(({ file, ref }): string[] => {
      if (ref.value.startsWith('./')) return [];
      const path = relative(REPO_ROOT, join(WORKFLOWS_DIR, file));
      if (!/@[0-9a-f]{40}$/u.test(ref.value)) {
        return [`${path}: '${ref.value}' does not end in @ + 40 hex chars`];
      }
      const after = ref.line.slice(ref.line.indexOf(ref.value) + ref.value.length);
      if (!/#\s*v?\d+(\.\d+)+/u.test(after)) {
        return [`${path}: '${ref.value}' has no '# vX.Y.Z' version comment after the SHA`];
      }
      return [];
    });
    expect(violations).toEqual([]);
  });
});
