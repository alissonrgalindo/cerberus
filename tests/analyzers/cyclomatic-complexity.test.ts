import { describe, expect, it } from 'vitest';
import { analyzeCyclomatic } from '../../src/analyzers/cyclomatic-complexity.js';
import { baselineWith, inputFor, inputFromSource } from '../helpers.js';

describe('cyclomatic-complexity analyzer', () => {
  it('passes a trivial file', async () => {
    const result = await analyzeCyclomatic(inputFor('simple.ts'));
    expect(result.passed).toBe(true);
  });

  it('computes McCabe complexity as 1 + decision points', async () => {
    // 2 ifs + 1 && + 1 ternary = 4 decisions -> complexity 5
    const src = `export function f(a: number, b: number) {
  if (a > 0 && b > 0) {
    return a;
  }
  if (b < 0) {
    return b;
  }
  return a > b ? a : b;
}`;
    const result = await analyzeCyclomatic(inputFromSource('inline.ts', src));
    expect(result.metrics.cyclomaticComplexityMax).toBe(5);
    expect(result.passed).toBe(true);
  });

  it('flags a function over the threshold', async () => {
    const ifs = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return '${i}';`).join('\n');
    const src = `export function classify(x: number): string {\n${ifs}\n  return 'none';\n}`;
    const result = await analyzeCyclomatic(inputFromSource('branchy.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].location).toMatch(/^classify:/);
    expect(result.violations[0].current).toBe(13);
    expect(result.violations[0].threshold).toBe(10);
  });

  it('counts nested functions independently', async () => {
    const src = `export function outer(xs: number[]) {
  return xs.map((x) => (x > 0 ? x : -x));
}`;
    const result = await analyzeCyclomatic(inputFromSource('nested.ts', src));
    // outer has 0 decisions (complexity 1); the arrow has 1 ternary (complexity 2)
    expect(result.metrics.cyclomaticComplexityMax).toBe(2);
    expect(result.passed).toBe(true);
  });

  it('respects baseline over absolute threshold', async () => {
    const ifs = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return '${i}';`).join('\n');
    const src = `export function classify(x: number): string {\n${ifs}\n  return 'none';\n}`;
    const ok = await analyzeCyclomatic(
      inputFromSource('branchy.ts', src, { baseline: baselineWith({ cyclomaticPerFunction: { classify: 13 } }) }),
    );
    expect(ok.passed).toBe(true);
  });
});
