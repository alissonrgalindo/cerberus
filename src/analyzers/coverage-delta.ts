import { execaSync } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toPosix } from '../files.js';
import type { Baseline, Config, SetViolation } from '../types.js';

const VITEST_CONFIGS = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vite.config.ts',
  'vite.config.js',
];

/** Detects whether the project uses vitest (config file or package.json dependency). */
export function hasVitest(cwd: string): boolean {
  if (VITEST_CONFIGS.some((f) => existsSync(join(cwd, f)))) return true;
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Boolean(pkg.dependencies?.vitest || pkg.devDependencies?.vitest);
    } catch {
      return false;
    }
  }
  return false;
}

/** Parses an istanbul json-summary into a map of relative path -> lines.pct. */
export function parseCoverageSummary(summaryPath: string, cwd: string): Map<string, number> {
  const map = new Map<string, number>();
  const json = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, { lines?: { pct?: number } }>;
  for (const [abs, data] of Object.entries(json)) {
    if (abs === 'total') continue;
    const pct = data?.lines?.pct;
    if (typeof pct === 'number') map.set(toPosix(relative(cwd, abs)), pct);
  }
  return map;
}

/**
 * Pure comparison: flags a file whose coverage dropped below its baseline
 * (minus the allowed delta). Files without a meaningful baseline (0/absent)
 * are never flagged — we only guard against regressions, not absence.
 */
export function compareCoverage(
  currentByFile: Map<string, number>,
  baseline: Baseline | null,
  relFiles: string[],
  config: Config,
): SetViolation[] {
  const out: SetViolation[] = [];
  const allowedDrop = config.thresholds.coverageDelta;
  for (const rel of relFiles) {
    const current = currentByFile.get(rel);
    if (current === undefined) continue;
    const base = baseline?.files[rel]?.metrics.coverage.percent ?? 0;
    if (base <= 0) continue;
    if (current < base - allowedDrop) {
      out.push({
        file: rel,
        violation: {
          analyzer: 'coverage',
          location: rel,
          current: Math.round(current),
          threshold: Math.round(base - allowedDrop),
          baseline: Math.round(base),
          delta: Math.round(current - base),
          suggestion: `Coverage dropped from ${base.toFixed(1)}% to ${current.toFixed(1)}%. Add tests for the new code paths.`,
        },
      });
    }
  }
  return out;
}

export type CoverageOutcome = { violations: SetViolation[]; skipped: boolean; reason?: string };

/**
 * Runs vitest coverage over changed files and compares against the baseline.
 * Best-effort: missing vitest, timeout, or any error skips the analyzer
 * (never fails the gate). Timeout from config.preCommit.timeoutMs.
 */
export async function analyzeCoverage(
  relFiles: string[],
  cwd: string,
  baseline: Baseline | null,
  config: Config,
): Promise<CoverageOutcome> {
  if (!hasVitest(cwd)) return { violations: [], skipped: true, reason: 'no vitest config detected' };
  try {
    execaSync(
      'npx',
      ['vitest', 'run', '--coverage', '--coverage.reporter=json-summary', '--changed=HEAD'],
      { cwd, reject: false, timeout: config.preCommit.timeoutMs, stdio: 'ignore' },
    );
    const summary = join(cwd, 'coverage', 'coverage-summary.json');
    if (!existsSync(summary)) return { violations: [], skipped: true, reason: 'no coverage summary produced' };
    const current = parseCoverageSummary(summary, cwd);
    return { violations: compareCoverage(current, baseline, relFiles, config), skipped: false };
  } catch (err) {
    return { violations: [], skipped: true, reason: `coverage skipped: ${(err as Error).message}` };
  }
}
