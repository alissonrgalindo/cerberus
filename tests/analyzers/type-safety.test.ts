import { describe, expect, it } from 'vitest';
import { analyzeTypeSafety } from '../../src/analyzers/type-safety.js';
import { baselineWith, inputFor } from '../helpers.js';

describe('type-safety analyzer', () => {
  it('passes a clean file', async () => {
    const result = await analyzeTypeSafety(inputFor('simple.ts'));
    expect(result.passed).toBe(true);
  });

  it('flags new `any` usages in a new file (no baseline)', async () => {
    const result = await analyzeTypeSafety(inputFor('with-any.ts'));
    expect(result.passed).toBe(false);
    const v = result.violations.find((x) => x.suggestion.includes('`any`'));
    expect(v?.current).toBe(3);
    expect(v?.delta).toBe(3);
    expect(result.metrics.anyCount).toBe(3);
  });

  it('does not flag pre-existing `any` already in baseline', async () => {
    const result = await analyzeTypeSafety(
      inputFor('with-any.ts', { baseline: baselineWith({ typeSafety: { anyCount: 3 } }) }),
    );
    expect(result.passed).toBe(true);
  });

  it('flags only the delta over baseline', async () => {
    const result = await analyzeTypeSafety(
      inputFor('with-any.ts', { baseline: baselineWith({ typeSafety: { anyCount: 1 } }) }),
    );
    expect(result.passed).toBe(false);
    const v = result.violations.find((x) => x.suggestion.includes('`any`'));
    expect(v?.delta).toBe(2);
  });

  it('flags @ts-ignore / @ts-expect-error directives', async () => {
    const result = await analyzeTypeSafety(inputFor('with-suppression.ts'));
    expect(result.passed).toBe(false);
    const v = result.violations.find((x) => x.suggestion.includes('ts-ignore'));
    expect(v?.current).toBe(2);
  });

  it('flags `as unknown as` double casts', async () => {
    const result = await analyzeTypeSafety(inputFor('with-unknown-cast.ts'));
    expect(result.passed).toBe(false);
    expect(result.metrics.asUnknownAsCount).toBe(1);
  });

  it('does not match `any` inside string literals (AST, not regex)', async () => {
    // simple.ts has no `any`; a string containing the word must not trip the scan.
    const result = await analyzeTypeSafety(
      inputFor('simple.ts'),
    );
    expect(result.metrics.anyCount).toBe(0);
  });
});
