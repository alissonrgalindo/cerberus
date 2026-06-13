import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Detects imports of packages that don't exist in any package.json
 * (dependencies / devDependencies / peerDependencies / optionalDependencies)
 * reachable from the file. This is the classic "hallucinated import" failure
 * mode of LLM-generated code: the model invents `lodash-extra`, `zod-pretty`,
 * `react-form-easy` because it's the kind of name that *sounds* right.
 *
 * Skipped (not hallucinations):
 *   - Relative imports:                    './foo', '../bar'
 *   - Absolute imports:                    '/abs/path' (rare in TS, but valid)
 *   - Node builtins:                       'node:fs', 'fs', 'path', 'crypto', …
 *   - TS path aliases (heuristic):         '@/components/x', '~/lib/y' — anything
 *     starting with '@/' or '~/' is treated as a local alias and skipped. Real
 *     scoped packages are '@scope/pkg' with a name after the slash; we only
 *     skip the alias forms.
 *
 * Walks up from the file's directory looking for package.json(s) and unions
 * all declared dependency names. Monorepos: every package.json on the way to
 * the repo root contributes (so a workspace package's deps cover a file inside
 * it, and the root's devDeps cover tooling).
 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

type PkgJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  name?: string;
};

/**
 * `import 'foo/bar/baz'` → package name is `foo`.
 * `import '@scope/pkg/sub'` → package name is `@scope/pkg`.
 */
function packageNameFromSpecifier(spec: string): string {
  if (spec.startsWith('@')) {
    const [scope, pkg] = spec.split('/', 2);
    return pkg ? `${scope}/${pkg}` : scope;
  }
  return spec.split('/', 1)[0] ?? spec;
}

function isLocalSpecifier(spec: string): boolean {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return true;
  if (spec.startsWith('/')) return true;
  // TS path aliases — we don't parse tsconfig.json, but '@/' and '~/' are the
  // dominant conventions (Next.js / Nuxt / Vite). Anything else with a single
  // '@' followed immediately by '/' is treated as alias too.
  if (spec.startsWith('@/') || spec.startsWith('~/')) return true;
  return false;
}

function isBuiltin(name: string): boolean {
  if (name.startsWith('node:')) return true;
  return NODE_BUILTINS.has(name);
}

/** Walks up from `fromDir` collecting every package.json's declared deps. */
function collectDeclaredDeps(fromDir: string): { declared: Set<string>; foundPackageJson: boolean } {
  const declared = new Set<string>();
  let foundPackageJson = false;
  let dir = fromDir;
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      foundPackageJson = true;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PkgJson;
        for (const block of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
          if (block) for (const name of Object.keys(block)) declared.add(name);
        }
        if (pkg.name) declared.add(pkg.name);
      } catch {
        // Malformed package.json — skip silently; CI will catch it elsewhere.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { declared, foundPackageJson };
}

type Finding = { line: number; specifier: string; packageName: string };

export async function analyzeHallucinatedImport(input: AnalyzerInput): Promise<AnalyzerResult> {
  const sourceFile = createSourceFile(input.filePath, input.fileContent);

  // The analyzer is given either a relative path (CLI) or an absolute one
  // (tests, programmatic use). Resolve relative against cwd; absolute paths
  // are used as-is so callers can analyze files outside cwd.
  const absFilePath = isAbsolute(input.filePath)
    ? input.filePath
    : resolve(process.cwd(), input.filePath);
  const startDir = dirname(absFilePath);
  const { declared, foundPackageJson } = collectDeclaredDeps(startDir);

  const findings: Finding[] = [];

  const collect = (spec: string, line: number): void => {
    if (!spec) return;
    if (isLocalSpecifier(spec)) return;
    const pkg = packageNameFromSpecifier(spec);
    if (isBuiltin(pkg)) return;
    if (declared.has(pkg)) return;
    findings.push({ line, specifier: spec, packageName: pkg });
  };

  for (const imp of sourceFile.getImportDeclarations()) {
    collect(imp.getModuleSpecifierValue(), imp.getStartLineNumber());
  }
  // export { x } from 'foo'
  for (const exp of sourceFile.getExportDeclarations()) {
    const mod = exp.getModuleSpecifierValue();
    if (mod) collect(mod, exp.getStartLineNumber());
  }
  // Dynamic import('foo')
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (arg && Node.isStringLiteral(arg)) {
      collect(arg.getLiteralText(), call.getStartLineNumber());
    }
  }

  // If we found zero package.jsons, don't fire — the file is being analyzed
  // outside any project, and every import would look hallucinated. (An empty
  // `dependencies: {}` is a real project and SHOULD flag undeclared imports.)
  if (!foundPackageJson) {
    return { passed: true, violations: [], metrics: { hallucinatedImportCount: 0 } };
  }

  const violations: Violation[] = findings.map((f) => ({
    analyzer: 'hallucinated-import',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `Import "${f.specifier}" resolves to package "${f.packageName}", which is not in any package.json on the path to repo root. Likely an LLM hallucination — verify the package exists on npm before installing, or use a real alternative.`,
  }));

  return {
    passed: violations.length === 0,
    violations,
    metrics: { hallucinatedImportCount: findings.length },
  };
}
