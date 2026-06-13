import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Baseline } from './types.js';

export const BASELINE_FILE = '.quality-gate-baseline.json';

export function loadBaseline(cwd: string): Baseline | null {
  const path = join(cwd, BASELINE_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
  } catch (err) {
    throw new Error(`Invalid ${BASELINE_FILE}: ${(err as Error).message}`);
  }
}

export function saveBaseline(cwd: string, baseline: Baseline): void {
  // Stable key order keeps the file diff-friendly and minimizes merge
  // conflicts when several branches re-baseline different files.
  const sortedFiles: Baseline['files'] = {};
  for (const key of Object.keys(baseline.files).sort()) {
    sortedFiles[key] = baseline.files[key];
  }
  const sorted: Baseline = { ...baseline, files: sortedFiles };
  writeFileSync(join(cwd, BASELINE_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}
