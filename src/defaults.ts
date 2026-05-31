import type { Config } from './types.js';

/** Built-in default config. Phase 2's config loader merges user `.quality-gate.json` over this. */
export function defaultConfig(): Config {
  return {
    thresholds: {
      cognitiveComplexity: 15,
      cyclomaticComplexity: 10,
      newAnyCount: 0,
      newTsIgnoreCount: 0,
      coverageDelta: 0,
      duplicationLines: 30,
    },
    ignore: [
      '**/*.test.{ts,tsx}',
      '**/__tests__/**',
      '**/*.stories.{ts,tsx}',
      '**/migrations/**',
      '**/generated/**',
    ],
    maxRefactorAttempts: 2,
    preCommit: {
      enabled: ['cognitive', 'cyclomatic', 'type-safety', 'coverage', 'duplication'],
      parallel: true,
      timeoutMs: 30000,
    },
    tsxOverrides: {
      cognitiveComplexity: 20,
      ignoreJsxExpressionContainerSimple: true,
    },
  };
}
