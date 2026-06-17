/**
 * GATE-3: Validate that the 10 purely-syntactic analyzers behave on JavaScript
 * fixtures exactly as on their TypeScript equivalents.
 *
 * Each analyzer section:
 *   - passes a trivial JS file
 *   - reproduces the key finding(s) from the TS test on a .js mirror
 *   - confirms the violation shape is identical (same analyzer name, same
 *     count / current / threshold)
 *
 * Analyzers that genuinely rely on TS-only syntax are marked N/A:
 *   - type-safety.ts: detects `any`, `as unknown as`, `@ts-ignore` — valid only
 *     in TS; already a no-op on JS per GATE-4. Skipped here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeCognitive } from '../../src/analyzers/cognitive-complexity.js';
import { analyzeCyclomatic } from '../../src/analyzers/cyclomatic-complexity.js';
import { analyzeFunctionShape } from '../../src/analyzers/function-shape.js';
import { analyzeHallucinatedImport } from '../../src/analyzers/hallucinated-import.js';
import { analyzeInjection } from '../../src/analyzers/injection.js';
import { analyzeNPlusOneQuery } from '../../src/analyzers/n-plus-one-query.js';
import { analyzeRevalidateRequired } from '../../src/analyzers/revalidate-required.js';
import { analyzeShallowModule } from '../../src/analyzers/shallow-module.js';
import { analyzeSilentCatch } from '../../src/analyzers/silent-catch.js';
import { analyzeTransactionRequired } from '../../src/analyzers/transaction-required.js';
import { defaultConfig } from '../../src/defaults.js';
import { fileTypeFromPath, type AnalyzerInput } from '../../src/types.js';
import { baselineWith, inputFor, inputFromSource } from '../helpers.js';

// ---------------------------------------------------------------------------
// 1. cognitive-complexity
// ---------------------------------------------------------------------------

describe('cognitive-complexity — JS fixtures', () => {
  it('passes a trivial .js file', async () => {
    const result = await analyzeCognitive(inputFor('simple.js'));
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('flags the same deeply-nested function in a .js mirror as in .ts', async () => {
    const tsResult = await analyzeCognitive(inputFor('complex.ts'));
    const jsResult = await analyzeCognitive(inputFor('complex.js'));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations).toHaveLength(1);
    const v = jsResult.violations[0];
    expect(v.analyzer).toBe('cognitive-complexity');
    expect(v.location).toMatch(/^deeplyNested:/);
    // Score and threshold must match the TS finding exactly.
    expect(v.current).toBe(tsResult.violations[0].current);
    expect(v.threshold).toBe(tsResult.violations[0].threshold);
  });

  it('respects the baseline on a .js file', async () => {
    const result = await analyzeCognitive(
      inputFor('complex.js', {
        baseline: baselineWith({ cognitivePerFunction: { deeplyNested: 21 } }),
      }),
    );
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. cyclomatic-complexity
// ---------------------------------------------------------------------------

describe('cyclomatic-complexity — JS fixtures', () => {
  it('passes a trivial .js source', async () => {
    const result = await analyzeCyclomatic(inputFromSource('inline.js', 'export function f(x) { return x; }'));
    expect(result.passed).toBe(true);
  });

  it('computes McCabe complexity on .js identically to .ts', async () => {
    // 2 ifs + 1 && + 1 ternary = 4 decisions -> complexity 5 (same shape, no TS annotations)
    const jsSrc = `export function f(a, b) {
  if (a > 0 && b > 0) {
    return a;
  }
  if (b < 0) {
    return b;
  }
  return a > b ? a : b;
}`;
    const tsSrc = `export function f(a: number, b: number) {
  if (a > 0 && b > 0) {
    return a;
  }
  if (b < 0) {
    return b;
  }
  return a > b ? a : b;
}`;
    const jsResult = await analyzeCyclomatic(inputFromSource('inline.js', jsSrc));
    const tsResult = await analyzeCyclomatic(inputFromSource('inline.ts', tsSrc));
    expect(jsResult.metrics.cyclomaticComplexityMax).toBe(tsResult.metrics.cyclomaticComplexityMax);
    expect(jsResult.metrics.cyclomaticComplexityMax).toBe(5);
    expect(jsResult.passed).toBe(true);
  });

  it('flags an over-threshold .js function the same way as .ts', async () => {
    const ifs = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return '${i}';`).join('\n');
    const jsSrc = `export function classify(x) {\n${ifs}\n  return 'none';\n}`;
    const tsSrc = `export function classify(x: number): string {\n${ifs}\n  return 'none';\n}`;

    const jsResult = await analyzeCyclomatic(inputFromSource('branchy.js', jsSrc));
    const tsResult = await analyzeCyclomatic(inputFromSource('branchy.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations[0].location).toMatch(/^classify:/);
    expect(jsResult.violations[0].current).toBe(tsResult.violations[0].current);
    expect(jsResult.violations[0].threshold).toBe(tsResult.violations[0].threshold);
  });
});

// ---------------------------------------------------------------------------
// 3. function-shape (length + parameter-count)
// ---------------------------------------------------------------------------

describe('function-shape — JS fixtures', () => {
  it('passes a short .js function with few params', async () => {
    const src = `export function add(a, b) { return a + b; }`;
    const result = await analyzeFunctionShape(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
  });

  it('flags a .js function over the parameter-count threshold', async () => {
    const src = `export function ugly(a, b, c, d, e) { return a; }`;
    const result = await analyzeFunctionShape(
      inputFromSource('inline.js', src, { thresholds: { parameterCount: 4 } }),
    );
    const paramViolation = result.violations.find((v) => v.analyzer === 'parameter-count');
    expect(paramViolation).toBeDefined();
    expect(paramViolation?.current).toBe(5);
  });

  it('flags a .js function over the length threshold', async () => {
    const body = Array.from({ length: 50 }, () => '  console.log("x");').join('\n');
    const src = `export function big() {\n${body}\n}`;
    const result = await analyzeFunctionShape(
      inputFromSource('inline.js', src, { thresholds: { functionLength: 40 } }),
    );
    const lenViolation = result.violations.find((v) => v.analyzer === 'function-length');
    expect(lenViolation).toBeDefined();
    expect(lenViolation?.current).toBeGreaterThan(40);
  });

  it('measures max param count the same for .js and .ts', async () => {
    const jsSrc = `export function a(x) { return x; }
export function b(p, q, r) { return p + q + r; }`;
    const tsSrc = `export function a(x: number) { return x; }
export function b(p: number, q: number, r: number) { return p + q + r; }`;
    const jsResult = await analyzeFunctionShape(inputFromSource('inline.js', jsSrc));
    const tsResult = await analyzeFunctionShape(inputFromSource('inline.ts', tsSrc));
    expect(jsResult.metrics.maxParameterCount).toBe(tsResult.metrics.maxParameterCount);
    expect(jsResult.metrics.maxParameterCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. shallow-module
// ---------------------------------------------------------------------------

describe('shallow-module — JS fixtures', () => {
  it('passes a .js function with real behavior', async () => {
    const src = `export function process(x) {
  if (x < 0) throw new Error('negative');
  return x * 2;
}`;
    const result = await analyzeShallowModule(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
  });

  it('flags a .js single-statement return-of-call (same as .ts)', async () => {
    const jsSrc = `import { repo } from './repo';
export function getUserById(id) {
  return repo.findById(id);
}`;
    const tsSrc = `import { repo } from './repo';
export function getUserById(id: string) {
  return repo.findById(id);
}`;
    const jsResult = await analyzeShallowModule(inputFromSource('inline.js', jsSrc));
    const tsResult = await analyzeShallowModule(inputFromSource('inline.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations[0].location).toMatch(/^getUserById:/);
    expect(jsResult.violations.length).toBe(tsResult.violations.length);
  });

  it('flags a .js exported arrow that delegates', async () => {
    const src = `import { repo } from './repo';
export const findUser = (id) => repo.findById(id);`;
    const result = await analyzeShallowModule(inputFromSource('inline.js', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].location).toMatch(/^findUser:/);
  });

  it('respects the suppression comment in .js', async () => {
    const src = `import { repo } from './repo';
// quality-gate-allow: shallow-module
export function getUserById(id) {
  return repo.findById(id);
}`;
    const result = await analyzeShallowModule(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. injection
// ---------------------------------------------------------------------------

describe('injection — JS fixtures', () => {
  it('passes clean .js code', async () => {
    const src = `export function f(x) { return x + 1; }`;
    const result = await analyzeInjection(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
    expect(result.metrics.injectionCount).toBe(0);
  });

  it('flags eval() in .js (same as .ts)', async () => {
    const jsSrc = `export function run(code) { return eval(code); }`;
    const tsSrc = `export function run(code: string) { return eval(code); }`;
    const jsResult = await analyzeInjection(inputFromSource('inline.js', jsSrc));
    const tsResult = await analyzeInjection(inputFromSource('inline.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations[0].severity).toBe('security');
    expect(jsResult.violations[0].suggestion).toMatch(/Code injection/);
    expect(jsResult.violations.length).toBe(tsResult.violations.length);
  });

  it('flags exec() with an interpolated command in .js', async () => {
    const src = `import { exec } from 'node:child_process';
export function ls(dir) { exec(\`ls -la \${dir}\`); }`;
    const result = await analyzeInjection(inputFromSource('inline.js', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/Shell injection/);
  });

  it('flags sql.raw() with a non-literal in .js', async () => {
    const src = `import { sql } from 'drizzle-orm';
export function order(col) { return sql.raw(col); }`;
    const result = await analyzeInjection(inputFromSource('inline.js', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/SQL injection/);
  });

  it('respects suppression comment in .js', async () => {
    const src = `export function run(code) {
  return eval(code); // quality-gate-allow: injection
}`;
    const result = await analyzeInjection(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. silent-catch
// ---------------------------------------------------------------------------

describe('silent-catch — JS fixtures', () => {
  it('passes when there are no try/catch blocks in .js', async () => {
    const src = `export function f(x) { return x + 1; }`;
    const result = await analyzeSilentCatch(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
    expect(result.metrics.silentCatchCount).toBe(0);
  });

  it('flags an empty catch block in .js (same as .ts)', async () => {
    const jsSrc = `export async function load() {
  try { await fetch('/x'); } catch (e) {}
}`;
    const tsSrc = `export async function load() {
  try { await fetch('/x'); } catch (e) {}
}`;
    const jsResult = await analyzeSilentCatch(inputFromSource('inline.js', jsSrc));
    const tsResult = await analyzeSilentCatch(inputFromSource('inline.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations).toHaveLength(tsResult.violations.length);
    expect(jsResult.violations[0].suggestion).toMatch(/swallows the error/);
  });

  it('flags a catch that only console.logs in .js', async () => {
    const src = `export async function load() {
  try { await fetch('/x'); } catch (e) { console.log(e); }
}`;
    const result = await analyzeSilentCatch(inputFromSource('inline.js', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/only logs to console/);
  });

  it('grandfathers silent catches from the baseline in .js', async () => {
    const src = `export async function load() {
  try { await a(); } catch (e) {}
  try { await b(); } catch (e) {}
}`;
    const result = await analyzeSilentCatch(
      inputFromSource('legacy.js', src, { baseline: baselineWith({ silentCatch: { count: 2 } }) }),
    );
    expect(result.passed).toBe(true);
  });

  it('passes when the catch rethrows in .js', async () => {
    const src = `export async function load() {
  try { await fetch('/x'); } catch (e) { console.log(e); throw e; }
}`;
    const result = await analyzeSilentCatch(inputFromSource('inline.js', src));
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. hallucinated-import
// ---------------------------------------------------------------------------

describe('hallucinated-import — JS fixtures', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-halluc-js-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeInput(opts: {
    relPath: string;
    content: string;
    pkg: Record<string, unknown>;
  }): AnalyzerInput {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(opts.pkg));
    const filePath = join(dir, opts.relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, opts.content);
    return {
      filePath,
      fileContent: opts.content,
      fileType: fileTypeFromPath(filePath),
      config: defaultConfig(),
    };
  }

  it('passes when every import is declared in a .js file', async () => {
    const input = makeInput({
      relPath: 'src/x.js',
      content: `import { z } from 'zod';\nimport fs from 'node:fs';\nimport { y } from './y';`,
      pkg: { dependencies: { zod: '^3.0.0' } },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(true);
    expect(result.metrics.hallucinatedImportCount).toBe(0);
  });

  it('flags an undeclared import in a .js file (same as .ts)', async () => {
    const input = makeInput({
      relPath: 'src/x.js',
      content: `import { stringify } from 'json-pretty-formatter-xyz';`,
      pkg: { dependencies: {} },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/json-pretty-formatter-xyz/);
  });

  it('flags hallucinated dynamic imports in .js', async () => {
    const input = makeInput({
      relPath: 'src/x.js',
      content: `export async function go() { const m = await import('imaginary-runtime'); return m; }`,
      pkg: { dependencies: {} },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/imaginary-runtime/);
  });

  it('recognizes scoped packages in .js', async () => {
    const input = makeInput({
      relPath: 'src/x.js',
      content: `import { foo } from '@scope/pkg/sub/path';`,
      pkg: { dependencies: { '@scope/pkg': '^1.0.0' } },
    });
    const result = await analyzeHallucinatedImport(input);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. n-plus-one-query
// ---------------------------------------------------------------------------

describe('n-plus-one-query — JS fixtures', () => {
  it('passes a .js query outside any loop', async () => {
    const src = `
import { db } from './db';
export async function load(ids) {
  return db.query.users.findMany({ where: { id: { inArray: ids } } });
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.js', src));
    expect(result.passed).toBe(true);
  });

  it('flags await db.* inside for-of in .js (same as .ts)', async () => {
    const jsSrc = `
import { db } from './db';
export async function load(ids) {
  for (const id of ids) {
    await db.query.users.findFirst({ where: { id } });
  }
}`;
    const tsSrc = `
import { db } from './db';
export async function load(ids: number[]) {
  for (const id of ids) {
    await db.query.users.findFirst({ where: { id } });
  }
}`;
    const jsResult = await analyzeNPlusOneQuery(inputFromSource('lib/x.js', jsSrc));
    const tsResult = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.metrics.nPlusOneCount).toBe(tsResult.metrics.nPlusOneCount);
    expect(jsResult.metrics.nPlusOneCount).toBe(1);
  });

  it('flags await db.* inside .map(async ...) in .js', async () => {
    const src = `
import { db } from './db';
export async function load(ids) {
  return Promise.all(ids.map(async (id) => {
    return await db.select().from(users).where(eq(users.id, id));
  }));
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.js', src));
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. transaction-required
// ---------------------------------------------------------------------------

describe('transaction-required — JS fixtures', () => {
  const USE_SERVER = `'use server'\n`;

  it('ignores .js files without the use server directive', async () => {
    const src = `
import { db } from './db';
export async function multi() {
  await db.insert(a).values({});
  await db.update(b).set({});
}`;
    const result = await analyzeTransactionRequired(inputFromSource('lib/x.js', src));
    expect(result.passed).toBe(true);
  });

  it('flags 2+ raw mutations in a .js use server function (same as .ts)', async () => {
    const jsSrc = `${USE_SERVER}
import { db } from './db';
export async function moveAndLog() {
  await db.insert(audit).values({});
  await db.update(items).set({ moved: true });
}`;
    const tsSrc = `${USE_SERVER}
import { db } from './db';
export async function moveAndLog() {
  await db.insert(audit).values({});
  await db.update(items).set({ moved: true });
}`;
    const jsResult = await analyzeTransactionRequired(inputFromSource('actions.js', jsSrc));
    const tsResult = await analyzeTransactionRequired(inputFromSource('actions.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations[0]?.location).toContain('moveAndLog');
    expect(jsResult.violations[0]?.current).toBe(tsResult.violations[0]?.current);
  });

  it('passes when .js mutations are wrapped in db.transaction', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function moveAndLog() {
  await db.transaction(async (tx) => {
    await tx.insert(audit).values({});
    await tx.update(items).set({ moved: true });
  });
}`;
    const result = await analyzeTransactionRequired(inputFromSource('actions.js', src));
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. revalidate-required
// ---------------------------------------------------------------------------

describe('revalidate-required — JS fixtures', () => {
  const USE_SERVER = `'use server'\n`;

  it('ignores .js files without the use server directive', async () => {
    const src = `
import { db } from './db';
export async function update() {
  await db.update(t).set({});
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('lib/x.js', src));
    expect(result.passed).toBe(true);
  });

  it('flags a .js action that mutates but never revalidates (same as .ts)', async () => {
    const jsSrc = `${USE_SERVER}
import { db } from './db';
export async function rename(formData) {
  await db.update(users).set({ name: 'x' });
}`;
    const tsSrc = `${USE_SERVER}
import { db } from './db';
export async function rename(formData) {
  await db.update(users).set({ name: 'x' });
}`;
    const jsResult = await analyzeRevalidateRequired(inputFromSource('actions.js', jsSrc));
    const tsResult = await analyzeRevalidateRequired(inputFromSource('actions.ts', tsSrc));

    expect(jsResult.passed).toBe(false);
    expect(jsResult.violations[0]?.location).toContain('rename');
    expect(jsResult.violations.length).toBe(tsResult.violations.length);
  });

  it('passes when a .js action calls revalidatePath', async () => {
    const src = `${USE_SERVER}
import { revalidatePath } from 'next/cache';
import { db } from './db';
export async function rename() {
  await db.update(users).set({ name: 'x' });
  revalidatePath('/users');
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.js', src));
    expect(result.passed).toBe(true);
  });

  it('passes when a .js exported arrow action revalidates', async () => {
    const src = `${USE_SERVER}
import { revalidatePath } from 'next/cache';
import { db } from './db';
export const rename = async () => {
  await db.update(users).set({ name: 'x' });
  revalidatePath('/users');
};`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.js', src));
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N/A: type-safety
// ---------------------------------------------------------------------------
// type-safety.ts detects TypeScript-specific constructs (`any`, `as unknown as`,
// `@ts-ignore`, `@ts-expect-error`). These are not valid JavaScript syntax and
// do not appear in plain .js files. Per GATE-4, type-safety is already a no-op
// on JS file types. No JS fixture or assertion is added here.
