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

export type Violation = {
  analyzer: string;
  location: string;
  current: number;
  threshold: number;
  baseline?: number;
  delta?: number;
  suggestion: string;
};

export type Config = {
  thresholds: {
    cognitiveComplexity: number;
    cyclomaticComplexity: number;
    newAnyCount: number;
    newTsIgnoreCount: number;
    coverageDelta: number;
    duplicationLines: number;
  };
  ignore: string[];
  maxRefactorAttempts: number;
  preCommit: {
    enabled: Array<'cognitive' | 'cyclomatic' | 'type-safety' | 'coverage' | 'duplication'>;
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
  };
};

/** Detects the FileType from a path extension. Defaults to 'ts'. */
export function fileTypeFromPath(filePath: string): FileType {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.mts')) return 'mts';
  if (filePath.endsWith('.cts')) return 'cts';
  return 'ts';
}
