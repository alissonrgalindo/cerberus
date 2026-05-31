import { describe, expect, it } from 'vitest';
import { analyzeCognitive } from '../../src/analyzers/cognitive-complexity.js';
import { baselineWith, inputFor } from '../helpers.js';

describe('cognitive-complexity analyzer', () => {
  it('passes a trivial file', async () => {
    const result = await analyzeCognitive(inputFor('simple.ts'));
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('flags a deeply nested function over the .ts threshold', async () => {
    const result = await analyzeCognitive(inputFor('complex.ts'));
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v.analyzer).toBe('cognitive-complexity');
    expect(v.location).toMatch(/^deeplyNested:/);
    expect(v.current).toBe(21);
    expect(v.threshold).toBe(15);
  });

  it('uses the higher tsx threshold for .tsx files', async () => {
    // jsx-simple scores 16: passes at tsx threshold 20...
    const pass = await analyzeCognitive(inputFor('jsx-simple.tsx'));
    expect(pass.passed).toBe(true);
    // ...but the SAME fixture fails when the tsx threshold is lowered to 15.
    const fail = await analyzeCognitive(
      inputFor('jsx-simple.tsx', { tsxOverrides: { cognitiveComplexity: 15 } }),
    );
    expect(fail.passed).toBe(false);
    expect(fail.violations[0].current).toBe(16);
    expect(fail.violations[0].threshold).toBe(15);
  });

  it('flags a tsx component that exceeds even the tsx threshold', async () => {
    const result = await analyzeCognitive(inputFor('jsx-complex.tsx'));
    expect(result.passed).toBe(false);
    expect(result.violations[0].current).toBe(25);
    expect(result.violations[0].threshold).toBe(20);
  });

  it('does not flag legacy complexity that did not get worse than baseline', async () => {
    const result = await analyzeCognitive(
      inputFor('complex.ts', { baseline: baselineWith({ cognitivePerFunction: { deeplyNested: 21 } }) }),
    );
    expect(result.passed).toBe(true);
  });

  it('flags a regression beyond baseline even when threshold is unchanged', async () => {
    const result = await analyzeCognitive(
      inputFor('complex.ts', { baseline: baselineWith({ cognitivePerFunction: { deeplyNested: 18 } }) }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].baseline).toBe(18);
    expect(result.violations[0].delta).toBe(3);
  });
});
