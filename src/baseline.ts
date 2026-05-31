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
  writeFileSync(join(cwd, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
}
