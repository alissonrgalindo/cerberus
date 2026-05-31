import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareCoverage,
  hasVitest,
  parseCoverageSummary,
} from '../../src/analyzers/coverage-delta.js';
import { defaultConfig } from '../../src/defaults.js';
import type { Baseline } from '../../src/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qg-cov-'));
}

function baselineWithCoverage(rel: string, percent: number): Baseline {
  return {
    version: 1,
    generatedAt: 'x',
    files: {
      [rel]: {
        fileHash: 'h',
        metrics: {
          cognitiveComplexity: { max: 0, perFunction: {} },
          cyclomaticComplexity: { max: 0, perFunction: {} },
          typeSafety: { anyCount: 0, tsIgnoreCount: 0, asUnknownAsCount: 0 },
          coverage: { percent },
        },
      },
    },
  };
}

describe('coverage-delta', () => {
  it('detects vitest via config file', () => {
    const dir = tempDir();
    expect(hasVitest(dir)).toBe(false);
    writeFileSync(join(dir, 'vitest.config.ts'), 'export default {};');
    expect(hasVitest(dir)).toBe(true);
  });

  it('detects vitest via package.json devDependencies', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    expect(hasVitest(dir)).toBe(true);
  });

  it('parses a json-summary into per-file line percentages', () => {
    const dir = tempDir();
    const summary = {
      total: { lines: { pct: 80 } },
      [join(dir, 'src/a.ts')]: { lines: { pct: 75 } },
      [join(dir, 'src/b.ts')]: { lines: { pct: 100 } },
    };
    const path = join(dir, 'summary.json');
    writeFileSync(path, JSON.stringify(summary));
    const map = parseCoverageSummary(path, dir);
    expect(map.get('src/a.ts')).toBe(75);
    expect(map.get('src/b.ts')).toBe(100);
    expect(map.has('total')).toBe(false);
  });

  it('flags a coverage drop below baseline', () => {
    const current = new Map([['src/a.ts', 80]]);
    const out = compareCoverage(current, baselineWithCoverage('src/a.ts', 90), ['src/a.ts'], defaultConfig());
    expect(out).toHaveLength(1);
    expect(out[0].violation.analyzer).toBe('coverage');
    expect(out[0].violation.baseline).toBe(90);
    expect(out[0].violation.current).toBe(80);
  });

  it('does not flag when coverage held or improved', () => {
    const current = new Map([['src/a.ts', 95]]);
    expect(compareCoverage(current, baselineWithCoverage('src/a.ts', 90), ['src/a.ts'], defaultConfig())).toHaveLength(0);
  });

  it('does not flag files without a meaningful baseline (0/absent)', () => {
    const current = new Map([['src/a.ts', 10]]);
    expect(compareCoverage(current, baselineWithCoverage('src/a.ts', 0), ['src/a.ts'], defaultConfig())).toHaveLength(0);
    expect(compareCoverage(current, null, ['src/a.ts'], defaultConfig())).toHaveLength(0);
  });
});
