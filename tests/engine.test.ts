import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/defaults.js';
import { analyzeFile, computeFileBaseline } from '../src/engine.js';

const BAD = `export function deep(x: number, raw: unknown): any {
  const v = raw as unknown as number;
  if (x > 0) { if (x > 1) { if (x > 2) { if (x > 3) { if (x > 4) { if (x > 5) { return x; } } } } } }
  return v;
}`;

describe('engine', () => {
  it('aggregates violations across analyzers for a new file', async () => {
    const report = await analyzeFile('bad.ts', BAD, defaultConfig());
    expect(report.passed).toBe(false);
    const analyzers = new Set(report.violations.map((v) => v.analyzer));
    expect(analyzers.has('cognitive-complexity')).toBe(true);
    expect(analyzers.has('type-safety')).toBe(true);
  });

  it('captures a baseline that makes legacy code pass (delta, not absolute)', async () => {
    const baseline = computeFileBaseline('bad.ts', BAD);
    expect(baseline.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.metrics.cognitiveComplexity.max).toBe(21);
    expect(baseline.metrics.typeSafety.anyCount).toBe(1);
    expect(baseline.metrics.typeSafety.asUnknownAsCount).toBe(1);

    const report = await analyzeFile('bad.ts', BAD, defaultConfig(), baseline);
    expect(report.passed).toBe(true);
  });

  it('only runs implemented analyzers (no coverage/duplication crash)', async () => {
    // coverage + duplication are set-level analyzers; even when they appear in
    // preCommit.enabled, the per-file analyzeFile must skip them, not crash.
    const base = defaultConfig();
    const config = {
      ...base,
      preCommit: { ...base.preCommit, enabled: [...base.preCommit.enabled, 'coverage', 'duplication'] as typeof base.preCommit.enabled },
    };
    expect(config.preCommit.enabled).toContain('coverage');
    const report = await analyzeFile('clean.ts', 'export const x = 1;\n', config);
    expect(report.passed).toBe(true);
  });
});
