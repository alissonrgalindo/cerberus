import { getSourceOutput } from 'cognitive-complexity-ts';
import {
  baselineKey,
  type AnalyzerInput,
  type AnalyzerResult,
  type FunctionScore,
  type Violation,
} from '../types.js';

/** Subset of the cognitive-complexity-ts JSON shape we depend on. */
type CctsNode = {
  kind: string;
  name?: string;
  line?: number;
  column?: number;
  score: number;
  inner?: CctsNode[];
};

/**
 * Recursively flattens the ccts tree into one entry per scored symbol.
 * Each function/method carries its OWN cognitive score (Sonar-style); nested
 * functions are reported separately so we can threshold each independently.
 */
function flattenScores(nodes: CctsNode[] | undefined, out: FunctionScore[]): void {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.kind !== 'file') {
      out.push({
        name: node.name && node.name.length > 0 ? node.name : '<anonymous>',
        line: node.line ?? 0,
        score: node.score ?? 0,
      });
    }
    flattenScores(node.inner, out);
  }
}

/** Raw measurement (no thresholds) — shared with the baseline builder. */
export function measureCognitive(filePath: string, fileContent: string): FunctionScore[] {
  const report = getSourceOutput(fileContent, filePath) as unknown as CctsNode;
  const flat: FunctionScore[] = [];
  flattenScores(report.inner, flat);
  return flat;
}

/**
 * Cognitive complexity analyzer — thin wrapper over cognitive-complexity-ts.
 * The library already discounts JSX expression containers reasonably, so the
 * only TSX adjustment we make is a separate (higher) threshold via tsxOverrides.
 */
export async function analyzeCognitive(input: AnalyzerInput): Promise<AnalyzerResult> {
  const flat = measureCognitive(input.filePath, input.fileContent);

  const threshold =
    input.fileType === 'tsx'
      ? input.config.tsxOverrides.cognitiveComplexity
      : input.config.thresholds.cognitiveComplexity;

  const perFunctionBaseline = input.fileBaseline?.metrics.cognitiveComplexity.perFunction;
  const violations: Violation[] = [];

  for (const fn of flat) {
    // Existing function uses its own baseline as the floor; an unknown function
    // (new file or new symbol) is held to the absolute threshold.
    const baseline = perFunctionBaseline?.[fn.name] ?? perFunctionBaseline?.[baselineKey(fn)] ?? threshold;
    // Violation only if it both exceeds the threshold AND got worse than baseline.
    if (fn.score > threshold && fn.score > baseline) {
      violations.push({
        analyzer: 'cognitive-complexity',
        location: `${fn.name}:${fn.line}`,
        current: fn.score,
        threshold,
        baseline: perFunctionBaseline ? baseline : undefined,
        delta: perFunctionBaseline ? fn.score - baseline : undefined,
        suggestion: `Function "${fn.name}" has cognitive complexity ${fn.score} (limit ${threshold}). Extract guard clauses and nested branches into helpers.`,
      });
    }
  }

  const max = flat.reduce((m, f) => Math.max(m, f.score), 0);
  return {
    passed: violations.length === 0,
    violations,
    metrics: { cognitiveComplexityMax: max },
  };
}
