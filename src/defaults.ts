import type { Config } from './types.js';

/** Built-in default config. The config loader merges user `.cerberus.json` over this. */
export function defaultConfig(): Config {
  return {
    thresholds: {
      cognitiveComplexity: 15,
      cyclomaticComplexity: 10,
      newAnyCount: 0,
      newTsIgnoreCount: 0,
      coverageDelta: 0,
      duplicationLines: 30,
      functionLength: 80,
      parameterCount: 4,
    },
    ignore: [
      '**/*.test.{ts,tsx}',
      '**/__tests__/**',
      '**/*.stories.{ts,tsx}',
      '**/migrations/**',
      '**/generated/**',
    ],
    // Non-source binary / design artifacts skipped by every tier (quality AND
    // security). Extension globs only — `makeBinaryAssetMatcher` rejects
    // anything that isn't a concrete extension so this can't become a `**/*`
    // hole. The user config UNIONs onto this (adds; never replaces).
    binaryAssets: [
      // Design files (Pencil / .pen — committed as large JSON or binary).
      '**/*.pen',
      // Images.
      '**/*.{png,jpg,jpeg,gif,webp,svg,ico,bmp,avif,tiff}',
      // Fonts.
      '**/*.{woff,woff2,ttf,otf,eot}',
      // Media.
      '**/*.{mp4,mov,webm,mp3,wav,ogg,m4a}',
      // Archives.
      '**/*.{zip,tar,gz,tgz,bz2,rar,7z}',
      // Documents / other binaries.
      '**/*.{pdf,psd,sketch,fig}',
    ],
    maxRefactorAttempts: 2,
    preCommit: {
      enabled: [
        'cognitive',
        'cyclomatic',
        'type-safety',
        // 'coverage' is opt-in: it spawns a vitest run, too heavy for a default
        // pre-commit hook. Add it to preCommit.enabled when you want it.
        'duplication',
        'transaction-required',
        'revalidate-required',
        'n-plus-one-query',
        'migration-safety',
        'silent-catch',
        'hallucinated-import',
        'shallow-module',
        'function-length',
        'parameter-count',
        'secret-in-diff',
        'injection',
        'new-dependency',
      ],
      parallel: true,
      timeoutMs: 30000,
    },
    tsxOverrides: {
      cognitiveComplexity: 20,
      ignoreJsxExpressionContainerSimple: true,
    },
  };
}
