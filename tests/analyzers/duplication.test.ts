import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeDuplication } from '../../src/analyzers/duplication.js';
import { defaultConfig } from '../../src/defaults.js';

const BLOCK = `export function ${'NAME'}(items: number[]): number {
  let total = 0;
  for (const item of items) {
    if (item > 0) {
      total += item * 2;
      total += item * 3;
      total += item * 4;
    }
  }
  return total;
}
`;

function configWith(duplicationLines: number) {
  const c = defaultConfig();
  c.thresholds.duplicationLines = duplicationLines;
  return c;
}

describe('duplication analyzer (jscpd)', () => {
  it('flags a copy-pasted block across two files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-dup-'));
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, BLOCK.replace('NAME', 'processA'));
    writeFileSync(b, BLOCK.replace('NAME', 'processB'));

    const violations = analyzeDuplication([a, b], dir, configWith(5));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].violation.analyzer).toBe('duplication');
    expect(violations[0].violation.current).toBeGreaterThanOrEqual(5);
  });

  it('does not flag distinct files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-dup-'));
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'export const add = (x: number, y: number) => x + y;\n');
    writeFileSync(b, 'export const greet = (name: string) => `hi ${name}`;\n');

    expect(analyzeDuplication([a, b], dir, configWith(5))).toHaveLength(0);
  });

  it('returns nothing for an empty file set', () => {
    expect(analyzeDuplication([], process.cwd(), configWith(5))).toHaveLength(0);
  });
});
