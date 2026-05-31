import { execaSync } from 'execa';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { toPosix } from '../files.js';
import type { Config, SetViolation, Violation } from '../types.js';

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const DTS_EXT = /\.d\.ts$/;

/**
 * Resolves the jscpd bin. jscpd's `exports` hides ./package.json, so we resolve
 * its main entry and walk up to the package root (the dir whose package.json is jscpd).
 */
function jscpdBin(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve('jscpd'));
  for (let i = 0; i < 6; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'jscpd') {
          return join(dir, 'bin', 'jscpd');
        }
      } catch {
        // keep walking up
      }
    }
    dir = dirname(dir);
  }
  throw new Error('jscpd binary not found');
}

type JscpdDuplicate = {
  lines?: number;
  firstFile?: { name?: string; start?: number };
  secondFile?: { name?: string; start?: number };
};

/**
 * Runs jscpd over the staged files only (never a global scan) and reports
 * copy-paste blocks at or above the configured line threshold. Best-effort:
 * any failure returns no violations rather than blocking the commit.
 */
export function analyzeDuplication(files: string[], cwd: string, config: Config): SetViolation[] {
  const tsFiles = files.filter((f) => TS_EXT.test(f) && !DTS_EXT.test(f));
  if (tsFiles.length === 0) return [];

  const minLines = config.thresholds.duplicationLines;
  const outDir = mkdtempSync(join(tmpdir(), 'qg-jscpd-'));
  try {
    execaSync(
      'node',
      [
        jscpdBin(),
        '--silent',
        '--reporters', 'json',
        '--output', outDir,
        '--min-lines', String(minLines),
        '--mode', 'strict',
        '--absolute',
        ...tsFiles,
      ],
      { cwd, reject: false, timeout: 30_000 },
    );

    const report = JSON.parse(readFileSync(join(outDir, 'jscpd-report.json'), 'utf8')) as {
      duplicates?: JscpdDuplicate[];
    };

    const out: SetViolation[] = [];
    for (const dup of report.duplicates ?? []) {
      const lines = dup.lines ?? 0;
      if (lines < minLines) continue;
      const firstRel = dup.firstFile?.name ? toPosix(relative(cwd, dup.firstFile.name)) : '?';
      const secondRel = dup.secondFile?.name ? toPosix(relative(cwd, dup.secondFile.name)) : '?';
      const violation: Violation = {
        analyzer: 'duplication',
        location: `${firstRel}:${dup.firstFile?.start ?? '?'}`,
        current: lines,
        threshold: minLines,
        suggestion: `${lines} duplicated lines shared with ${secondRel}. Extract the block into a shared helper.`,
      };
      out.push({ file: firstRel, violation });
    }
    return out;
  } catch {
    return [];
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
