import { describe, expect, it } from 'vitest';
import { analyzeSilentCatch } from '../../src/analyzers/silent-catch.js';
import { baselineWith, inputFromSource } from '../helpers.js';

describe('silent-catch analyzer', () => {
  it('passes when there are no try/catch blocks', async () => {
    const src = `export function f(x: number) { return x + 1; }`;
    const result = await analyzeSilentCatch(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
    expect(result.metrics.silentCatchCount).toBe(0);
  });

  it('flags an empty catch block', async () => {
    const src = `export async function load() {
  try { await fetch('/x'); } catch (e) {}
}`;
    const result = await analyzeSilentCatch(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].suggestion).toMatch(/swallows the error/);
  });

  it('flags a catch that only calls console.log', async () => {
    const src = `export async function load() {
  try { await fetch('/x'); } catch (e) { console.log(e); }
}`;
    const result = await analyzeSilentCatch(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/only logs to console/);
  });

  it('grandfathers silent catches already captured in the baseline (legacy not blocked)', async () => {
    const src = `export async function load() {
  try { await a(); } catch (e) {}
  try { await b(); } catch (e) {}
}`;
    const result = await analyzeSilentCatch(
      inputFromSource('legacy.ts', src, { baseline: baselineWith({ silentCatch: { count: 2 } }) }),
    );
    expect(result.passed).toBe(true);
    expect(result.metrics.silentCatchCount).toBe(2);
  });

  it('flags a silent catch added beyond the baseline count', async () => {
    const src = `export async function load() {
  try { await a(); } catch (e) {}
  try { await b(); } catch (e) {}
  try { await c(); } catch (e) {}
}`;
    const result = await analyzeSilentCatch(
      inputFromSource('legacy.ts', src, { baseline: baselineWith({ silentCatch: { count: 2 } }) }),
    );
    expect(result.passed).toBe(false);
  });

  it('passes when the catch rethrows', async () => {
    const src = `export async function load() {
  try { await fetch('/x'); } catch (e) { console.log(e); throw e; }
}`;
    const result = await analyzeSilentCatch(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes when the catch reports to a non-console handler', async () => {
    const src = `import { reportError } from 'sentry';
export async function load() {
  try { await fetch('/x'); } catch (e) { reportError(e); }
}`;
    const result = await analyzeSilentCatch(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });
});
