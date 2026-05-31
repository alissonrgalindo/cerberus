import { createHash } from 'node:crypto';
import { analyzeCognitive, measureCognitive } from './analyzers/cognitive-complexity.js';
import { analyzeCyclomatic, measureCyclomatic } from './analyzers/cyclomatic-complexity.js';
import { analyzeTypeSafety, measureTypeSafety } from './analyzers/type-safety.js';
import {
  baselineKey,
  fileTypeFromPath,
  type AnalyzerInput,
  type AnalyzerResult,
  type Config,
  type FileBaseline,
  type FunctionScore,
  type Violation,
} from './types.js';

/** Analyzers implemented so far (coverage + duplication land in Phase 4). */
export const IMPLEMENTED_ANALYZERS = ['cognitive', 'cyclomatic', 'type-safety'] as const;

export type FileReport = {
  file: string;
  passed: boolean;
  violations: Violation[];
  metrics: Record<string, number>;
};

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function maxScore(scores: FunctionScore[]): number {
  return scores.reduce((m, s) => Math.max(m, s.score), 0);
}

/** Runs every enabled+implemented analyzer over one file and aggregates the violations. */
export async function analyzeFile(
  filePath: string,
  fileContent: string,
  config: Config,
  fileBaseline?: FileBaseline,
): Promise<FileReport> {
  const input: AnalyzerInput = {
    filePath,
    fileContent,
    config,
    fileBaseline,
    fileType: fileTypeFromPath(filePath),
  };
  const enabled = new Set(
    config.preCommit.enabled.filter((a) => (IMPLEMENTED_ANALYZERS as readonly string[]).includes(a)),
  );

  const results: AnalyzerResult[] = [];
  if (enabled.has('cognitive')) results.push(await analyzeCognitive(input));
  if (enabled.has('cyclomatic')) results.push(await analyzeCyclomatic(input));
  if (enabled.has('type-safety')) results.push(await analyzeTypeSafety(input));

  const violations = results.flatMap((r) => r.violations);
  const metrics = Object.assign({}, ...results.map((r) => r.metrics));
  return { file: filePath, passed: violations.length === 0, violations, metrics };
}

/** Captures raw metrics for a file (no thresholds) to snapshot into the baseline. */
export function computeFileBaseline(filePath: string, fileContent: string): FileBaseline {
  const cognitive = measureCognitive(filePath, fileContent);
  const cyclomatic = measureCyclomatic(filePath, fileContent);
  const typeSafety = measureTypeSafety(filePath, fileContent);

  const cognitivePer: Record<string, number> = {};
  for (const fn of cognitive) cognitivePer[baselineKey(fn)] = fn.score;
  const cyclomaticPer: Record<string, number> = {};
  for (const fn of cyclomatic) cyclomaticPer[baselineKey(fn)] = fn.score;

  return {
    fileHash: hashContent(fileContent),
    metrics: {
      cognitiveComplexity: { max: maxScore(cognitive), perFunction: cognitivePer },
      cyclomaticComplexity: { max: maxScore(cyclomatic), perFunction: cyclomaticPer },
      typeSafety: {
        anyCount: typeSafety.anyCount,
        tsIgnoreCount: typeSafety.tsIgnoreCount,
        asUnknownAsCount: typeSafety.asUnknownAsCount,
      },
      coverage: { percent: 0 },
    },
  };
}
