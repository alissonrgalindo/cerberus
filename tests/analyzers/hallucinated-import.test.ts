import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeHallucinatedImport } from '../../src/analyzers/hallucinated-import.js';
import { defaultConfig } from '../../src/defaults.js';
import { fileTypeFromPath, type AnalyzerInput } from '../../src/types.js';

/** Builds an AnalyzerInput anchored at a temp dir with a custom package.json. */
function makeInput(opts: {
  dir: string;
  relPath: string;
  content: string;
  pkg: Record<string, unknown>;
}): AnalyzerInput {
  writeFileSync(join(opts.dir, 'package.json'), JSON.stringify(opts.pkg));
  const filePath = join(opts.dir, opts.relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, opts.content);

  return {
    filePath, // absolute — analyzer walks up from dirname(filePath)
    fileContent: opts.content,
    fileType: fileTypeFromPath(filePath),
    config: defaultConfig(),
  };
}

describe('hallucinated-import analyzer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-halluc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when every import is declared', async () => {
    const input = makeInput({
      dir,
      relPath: 'src/x.ts',
      content: `import { z } from 'zod';\nimport fs from 'node:fs';\nimport { y } from './y';\nimport { a } from '@/lib/a';`,
      pkg: { dependencies: { zod: '^3.0.0' } },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(true);
    expect(result.metrics.hallucinatedImportCount).toBe(0);
  });

  it('flags an undeclared import', async () => {
    const input = makeInput({
      dir,
      relPath: 'src/x.ts',
      content: `import { stringify } from 'json-pretty-formatter-xyz';`,
      pkg: { dependencies: {} },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/json-pretty-formatter-xyz/);
  });

  it('recognizes scoped packages', async () => {
    const input = makeInput({
      dir,
      relPath: 'src/x.ts',
      content: `import { foo } from '@scope/pkg/sub/path';`,
      pkg: { dependencies: { '@scope/pkg': '^1.0.0' } },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(true);
  });

  it('flags scoped-package hallucinations', async () => {
    const input = makeInput({
      dir,
      relPath: 'src/x.ts',
      content: `import { foo } from '@fake/pkg';`,
      pkg: { dependencies: {} },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/@fake\/pkg/);
  });

  it('flags hallucinated dynamic imports', async () => {
    const input = makeInput({
      dir,
      relPath: 'src/x.ts',
      content: `export async function go() { const m = await import('imaginary-runtime'); return m; }`,
      pkg: { dependencies: {} },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/imaginary-runtime/);
  });
});
