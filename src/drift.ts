import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBaseline } from './baseline.js';
import { computeFileBaseline, hashContent } from './engine.js';
import type { FileBaseline } from './types.js';

export type DriftDirection = 'improved' | 'flat' | 'degraded';

export type DriftEntry = {
  file: string;
  baseline: FileBaseline;
  current: FileBaseline;
  deltas: {
    cognitiveMax: number;
    cyclomaticMax: number;
    anyCount: number;
    tsIgnoreCount: number;
  };
  direction: DriftDirection;
};

/**
 * Returns every baselined file whose working-tree content hash differs from the
 * snapshot, with the recomputed metrics + deltas. A file that exists in the
 * baseline but has been deleted from the working tree is silently skipped — we
 * can't measure what isn't there.
 *
 * Drift is purely content-based (sha256). A file with formatting-only changes
 * will surface here with `direction: 'flat'`. That's intentional: the baseline
 * tracks content hashes, so any edit invalidates the snapshot until refreshed.
 */
export function listDrift(cwd: string): DriftEntry[] {
  const baseline = loadBaseline(cwd);
  if (!baseline) return [];
  const out: DriftEntry[] = [];
  for (const [rel, fb] of Object.entries(baseline.files)) {
    const abs = resolve(cwd, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, 'utf8');
    if (hashContent(content) === fb.fileHash) continue;
    const current = computeFileBaseline(rel, content);
    const deltas = {
      cognitiveMax: current.metrics.cognitiveComplexity.max - fb.metrics.cognitiveComplexity.max,
      cyclomaticMax: current.metrics.cyclomaticComplexity.max - fb.metrics.cyclomaticComplexity.max,
      anyCount: current.metrics.typeSafety.anyCount - fb.metrics.typeSafety.anyCount,
      tsIgnoreCount: current.metrics.typeSafety.tsIgnoreCount - fb.metrics.typeSafety.tsIgnoreCount,
    };
    const sum = deltas.cognitiveMax + deltas.cyclomaticMax + deltas.anyCount + deltas.tsIgnoreCount;
    const direction: DriftDirection = sum > 0 ? 'degraded' : sum < 0 ? 'improved' : 'flat';
    out.push({ file: rel, baseline: fb, current, deltas, direction });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
