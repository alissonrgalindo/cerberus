import { createHash } from 'node:crypto';
import { analyzeCognitive, measureCognitive } from './analyzers/cognitive-complexity.js';
import { analyzeCyclomatic, measureCyclomatic } from './analyzers/cyclomatic-complexity.js';
import { analyzeFunctionShape, measureFunctionShapes } from './analyzers/function-shape.js';
import { analyzeHallucinatedImport } from './analyzers/hallucinated-import.js';
import { analyzeInjection } from './analyzers/injection.js';
import {
  analyzePyHallucinatedImport,
  analyzePyInjection,
  analyzePySilentCatch,
} from './analyzers/python.js';
import { analyzeNPlusOneQuery } from './analyzers/n-plus-one-query.js';
import { analyzeRevalidateRequired } from './analyzers/revalidate-required.js';
import { analyzeShallowModule } from './analyzers/shallow-module.js';
import { analyzeSilentCatch, measureSilentCatch } from './analyzers/silent-catch.js';
import { analyzeTransactionRequired } from './analyzers/transaction-required.js';
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

/** Analyzers implemented so far (coverage + duplication + migration-safety + secret-in-diff run set-level). */
export const IMPLEMENTED_ANALYZERS = [
  'cognitive',
  'cyclomatic',
  'type-safety',
  'transaction-required',
  'revalidate-required',
  'n-plus-one-query',
  'silent-catch',
  'hallucinated-import',
  'shallow-module',
  'function-length',
  'parameter-count',
  'injection',
] as const;

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
  if (enabled.has('transaction-required')) results.push(await analyzeTransactionRequired(input));
  if (enabled.has('revalidate-required')) results.push(await analyzeRevalidateRequired(input));
  if (enabled.has('n-plus-one-query')) results.push(await analyzeNPlusOneQuery(input));
  if (enabled.has('silent-catch')) results.push(await analyzeSilentCatch(input));
  if (enabled.has('hallucinated-import')) results.push(await analyzeHallucinatedImport(input));
  if (enabled.has('shallow-module')) results.push(await analyzeShallowModule(input));
  if (enabled.has('injection')) results.push(await analyzeInjection(input));
  // function-length and parameter-count share one analyzer pass (same AST walk).
  if (enabled.has('function-length') || enabled.has('parameter-count')) {
    const result = await analyzeFunctionShape(input);
    // Filter to only the violations whose analyzer is actually enabled.
    const filtered: AnalyzerResult = {
      passed: true,
      violations: result.violations.filter((v) =>
        v.analyzer === 'function-length' ? enabled.has('function-length') : enabled.has('parameter-count'),
      ),
      metrics: result.metrics,
    };
    filtered.passed = filtered.violations.length === 0;
    results.push(filtered);
  }

  const violations = results.flatMap((r) => r.violations);
  const metrics = Object.assign({}, ...results.map((r) => r.metrics));
  return { file: filePath, passed: violations.length === 0, violations, metrics };
}

/**
 * Python counterpart of analyzeFile. v1 runs the presence-based analyzers
 * (silent-catch, injection, hallucinated-import) — same analyzer names as the
 * TS versions, so config/severity/reporting are shared. No baseline metrics yet.
 */
export async function analyzePythonFile(
  filePath: string,
  fileContent: string,
  config: Config,
): Promise<FileReport> {
  const input: AnalyzerInput = {
    filePath,
    fileContent,
    config,
    fileType: 'ts', // unused by the Python analyzers; satisfies AnalyzerInput
  };
  const enabled = new Set(config.preCommit.enabled);

  const results: AnalyzerResult[] = [];
  if (enabled.has('silent-catch')) results.push(await analyzePySilentCatch(input));
  if (enabled.has('injection')) results.push(await analyzePyInjection(input));
  if (enabled.has('hallucinated-import')) results.push(await analyzePyHallucinatedImport(input));

  const violations = results.flatMap((r) => r.violations);
  const metrics = Object.assign({}, ...results.map((r) => r.metrics));
  return { file: filePath, passed: violations.length === 0, violations, metrics };
}

/** Captures raw metrics for a file (no thresholds) to snapshot into the baseline. */
export function computeFileBaseline(filePath: string, fileContent: string): FileBaseline {
  const cognitive = measureCognitive(filePath, fileContent);
  const cyclomatic = measureCyclomatic(filePath, fileContent);
  const typeSafety = measureTypeSafety(filePath, fileContent);
  const shapes = measureFunctionShapes(filePath, fileContent);

  const cognitivePer: Record<string, number> = {};
  for (const fn of cognitive) cognitivePer[baselineKey(fn)] = fn.score;
  const cyclomaticPer: Record<string, number> = {};
  for (const fn of cyclomatic) cyclomaticPer[baselineKey(fn)] = fn.score;

  const lengthPer: Record<string, number> = {};
  const paramPer: Record<string, number> = {};
  let maxLen = 0;
  let maxParams = 0;
  for (const s of shapes) {
    const key = s.name === '<anonymous>' ? `${s.name}:${s.line}` : s.name;
    lengthPer[key] = s.bodyLines;
    paramPer[key] = s.paramCount;
    if (s.bodyLines > maxLen) maxLen = s.bodyLines;
    if (s.paramCount > maxParams) maxParams = s.paramCount;
  }

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
      functionLength: { max: maxLen, perFunction: lengthPer },
      parameterCount: { max: maxParams, perFunction: paramPer },
      silentCatch: { count: measureSilentCatch(filePath, fileContent) },
    },
  };
}
