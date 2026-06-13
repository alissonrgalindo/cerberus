export type FileType = 'ts' | 'tsx' | 'mts' | 'cts';

export type AnalyzerInput = {
  filePath: string;
  fileContent: string;
  fileBaseline?: FileBaseline;
  config: Config;
  fileType: FileType;
};

export type AnalyzerResult = {
  passed: boolean;
  violations: Violation[];
  metrics: Record<string, number>;
};

export type ViolationSeverity = 'security' | 'quality';

export type Violation = {
  analyzer: string;
  location: string;
  current: number;
  threshold: number;
  baseline?: number;
  delta?: number;
  suggestion: string;
  /** 'security' violations can never be bypassed, skipped, or doom-looped through. Default: 'quality'. */
  severity?: ViolationSeverity;
};

export type AnalyzerName =
  | 'cognitive'
  | 'cyclomatic'
  | 'type-safety'
  | 'coverage'
  | 'duplication'
  | 'transaction-required'
  | 'revalidate-required'
  | 'n-plus-one-query'
  | 'migration-safety'
  | 'silent-catch'
  | 'hallucinated-import'
  | 'shallow-module'
  | 'function-length'
  | 'parameter-count'
  | 'secret-in-diff'
  | 'injection'
  | 'new-dependency';

/**
 * Analyzers whose violations are security-tier: they are never let through by
 * the anti-doom-loop, never skipped by [skip-quality], and survive
 * QUALITY_GATE_BYPASS (the bypass downgrades the gate to security-only
 * instead of disabling it).
 */
export const SECURITY_ANALYZERS: ReadonlySet<string> = new Set([
  'secret-in-diff',
  'migration-safety',
  'injection',
  'new-dependency',
]);

export function isSecurityViolation(v: Violation): boolean {
  return v.severity === 'security' || SECURITY_ANALYZERS.has(v.analyzer);
}

export type Config = {
  thresholds: {
    cognitiveComplexity: number;
    cyclomaticComplexity: number;
    newAnyCount: number;
    newTsIgnoreCount: number;
    coverageDelta: number;
    duplicationLines: number;
    functionLength: number;
    parameterCount: number;
  };
  ignore: string[];
  maxRefactorAttempts: number;
  preCommit: {
    enabled: AnalyzerName[];
    parallel: boolean;
    timeoutMs: number;
  };
  tsxOverrides: {
    cognitiveComplexity: number;
    ignoreJsxExpressionContainerSimple: boolean;
  };
};

export type FileBaseline = {
  fileHash: string;
  metrics: {
    cognitiveComplexity: { max: number; perFunction: Record<string, number> };
    cyclomaticComplexity: { max: number; perFunction: Record<string, number> };
    typeSafety: { anyCount: number; tsIgnoreCount: number; asUnknownAsCount: number };
    coverage: { percent: number };
    /** Optional — added in v1.1; absent on older baselines (treat missing as 0). */
    functionLength?: { max: number; perFunction: Record<string, number> };
    /** Optional — added in v1.1; absent on older baselines (treat missing as 0). */
    parameterCount?: { max: number; perFunction: Record<string, number> };
  };
};

export type Baseline = {
  version: 1;
  generatedAt: string;
  files: Record<string, FileBaseline>;
};

/** Per-symbol measurement shared by analyzers and the baseline builder. */
export type FunctionScore = { name: string; line: number; score: number };

/** A violation attributed to a specific file by a set-level analyzer (coverage/duplication). */
export type SetViolation = { file: string; violation: Violation };

/** Stable baseline key for a measured function: bare name when named, name:line when anonymous. */
export function baselineKey(fn: FunctionScore): string {
  return fn.name === '<anonymous>' ? `${fn.name}:${fn.line}` : fn.name;
}

/** Detects the FileType from a path extension. Defaults to 'ts'. */
export function fileTypeFromPath(filePath: string): FileType {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.mts')) return 'mts';
  if (filePath.endsWith('.cts')) return 'cts';
  return 'ts';
}
