import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../src/defaults.js';
import {
  fileTypeFromPath,
  type AnalyzerInput,
  type Config,
  type FileBaseline,
  type FileType,
} from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

type InputOverrides = {
  thresholds?: Partial<Config['thresholds']>;
  tsxOverrides?: Partial<Config['tsxOverrides']>;
  fileType?: FileType;
  baseline?: FileBaseline;
};

/** Builds an AnalyzerInput from a fixture file, with optional config/baseline overrides. */
export function inputFor(fixture: string, o: InputOverrides = {}): AnalyzerInput {
  const filePath = join(FIXTURES, fixture);
  const fileContent = readFileSync(filePath, 'utf8');
  const base = defaultConfig();
  const config: Config = {
    ...base,
    thresholds: { ...base.thresholds, ...o.thresholds },
    tsxOverrides: { ...base.tsxOverrides, ...o.tsxOverrides },
  };
  return {
    filePath,
    fileContent,
    fileType: o.fileType ?? fileTypeFromPath(filePath),
    config,
    fileBaseline: o.baseline,
  };
}

/** Builds an AnalyzerInput from an inline source string (for precise unit assertions). */
export function inputFromSource(
  filePath: string,
  fileContent: string,
  o: InputOverrides = {},
): AnalyzerInput {
  const base = defaultConfig();
  return {
    filePath,
    fileContent,
    fileType: o.fileType ?? fileTypeFromPath(filePath),
    config: {
      ...base,
      thresholds: { ...base.thresholds, ...o.thresholds },
      tsxOverrides: { ...base.tsxOverrides, ...o.tsxOverrides },
    },
    fileBaseline: o.baseline,
  };
}

/** Builds a FileBaseline, defaulting every metric to 0 unless overridden. */
export function baselineWith(partial: {
  cognitivePerFunction?: Record<string, number>;
  cyclomaticPerFunction?: Record<string, number>;
  typeSafety?: Partial<FileBaseline['metrics']['typeSafety']>;
  functionLengthPerFunction?: Record<string, number>;
  parameterCountPerFunction?: Record<string, number>;
  silentCatch?: { count: number };
  shallowModule?: { count: number };
  cognitiveMax?: number;
  cyclomaticMax?: number;
  functionLengthMax?: number;
  parameterCountMax?: number;
}): FileBaseline {
  return {
    fileHash: 'test',
    metrics: {
      cognitiveComplexity: {
        max: partial.cognitiveMax ?? 0,
        perFunction: partial.cognitivePerFunction ?? {},
      },
      cyclomaticComplexity: {
        max: partial.cyclomaticMax ?? 0,
        perFunction: partial.cyclomaticPerFunction ?? {},
      },
      typeSafety: {
        anyCount: 0,
        tsIgnoreCount: 0,
        asUnknownAsCount: 0,
        ...partial.typeSafety,
      },
      coverage: { percent: 0 },
      functionLength: {
        max: partial.functionLengthMax ?? 0,
        perFunction: partial.functionLengthPerFunction ?? {},
      },
      parameterCount: {
        max: partial.parameterCountMax ?? 0,
        perFunction: partial.parameterCountPerFunction ?? {},
      },
      silentCatch: partial.silentCatch ?? { count: 0 },
      shallowModule: partial.shallowModule ?? { count: 0 },
    },
  };
}
