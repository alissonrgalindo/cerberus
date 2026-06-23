import { Node } from 'ts-morph';
import type { ArrowFunction, FunctionDeclaration, FunctionExpression } from 'ts-morph';

type Fn = FunctionDeclaration | FunctionExpression | ArrowFunction;
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Detects shallow modules — Ousterhout, *A Philosophy of Software Design* ch. 4.
 *
 * A module is "shallow" when its interface (signature, generics, JSDoc) is large
 * relative to the abstraction it provides (body). LLMs love to create wrappers
 * that rename or forward to another function without adding meaningful behavior:
 *
 *     export function getUserById(id: string): Promise<User> {
 *       return userRepo.findById(id);   // one statement of pure delegation
 *     }
 *
 * This adds a hop in the call graph and a name to remember without abstracting
 * anything. The right move is usually to inline the call.
 *
 * Heuristic — only fires when ALL of:
 *   1. Function is `export`ed at the top level (it's a public interface).
 *   2. Body is ≤ 2 effective statements (single-return or single-call counts as 1).
 *   3. The body's "real work" is a single CallExpression or PropertyAccess
 *      (no branching, no local computation, no object construction). A function
 *      that does `if (!x) throw …; return f(x)` is NOT shallow — the guard
 *      is real behavior.
 *
 * Type guards, branded constructors, and re-exports of one-liners trip this if
 * exported directly; suppress with a `// cerberus-allow: shallow-module`
 * line comment on the function declaration when intentional. The legacy
 * `quality-gate-allow` spelling is still accepted.
 */

const SUPPRESSION = /(?:cerberus|quality-gate)-allow:\s*shallow-module\b/;

type Finding = { name: string; line: number; reason: string };

function isPureDelegationBody(fn: Fn): boolean {
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) {
    // Arrow with expression body: `() => foo(x)` — pure delegation by shape.
    return true;
  }
  const stmts = body.getStatements();
  if (stmts.length === 0) return false; // empty body — that's a different smell
  if (stmts.length > 2) return false;

  // Single statement: must be a return-of-call, return-of-property-access, or
  // an expression statement that's a single call.
  if (stmts.length === 1) {
    const s = stmts[0];
    if (Node.isReturnStatement(s)) {
      const expr = s.getExpression();
      if (!expr) return false;
      return Node.isCallExpression(expr) || Node.isPropertyAccessExpression(expr) || Node.isIdentifier(expr);
    }
    if (Node.isExpressionStatement(s)) {
      const expr = s.getExpression();
      return Node.isCallExpression(expr);
    }
    return false;
  }

  // Two statements: tolerate `const x = …; return x;` if the first is a call
  // and the second returns that variable. Anything else is real logic.
  const [first, second] = stmts;
  if (
    Node.isVariableStatement(first) &&
    Node.isReturnStatement(second)
  ) {
    const decls = first.getDeclarationList().getDeclarations();
    if (decls.length !== 1) return false;
    const init = decls[0].getInitializer();
    const ret = second.getExpression();
    if (!init || !ret) return false;
    if (!Node.isCallExpression(init)) return false;
    return Node.isIdentifier(ret) && ret.getText() === decls[0].getName();
  }
  return false;
}

function hasSuppression(node: Node): boolean {
  const ranges = node.getLeadingCommentRanges();
  for (const r of ranges) {
    if (SUPPRESSION.test(r.getText())) return true;
  }
  return false;
}

function findShallowModules(filePath: string, fileContent: string): Finding[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const out: Finding[] = [];

  // Exported function declarations: export function foo(x) { return bar(x); }
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    if (hasSuppression(fn)) continue;
    if (!isPureDelegationBody(fn)) continue;
    const name = fn.getName() ?? '<anonymous>';
    out.push({
      name,
      line: fn.getStartLineNumber(),
      reason: 'exported function is a one-statement pass-through',
    });
  }

  // Exported `const foo = (x) => bar(x)` / `export const foo = function (x) { … }`
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    if (hasSuppression(stmt)) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
      if (!isPureDelegationBody(init)) continue;
      out.push({
        name: decl.getName(),
        line: decl.getStartLineNumber(),
        reason: 'exported arrow/function expression is a one-statement pass-through',
      });
    }
  }

  return out;
}

/** Counts shallow modules in a file — used to snapshot the baseline so legacy pass-throughs are grandfathered. */
export function measureShallowModule(filePath: string, fileContent: string): number {
  return findShallowModules(filePath, fileContent).length;
}

export async function analyzeShallowModule(input: AnalyzerInput): Promise<AnalyzerResult> {
  const findings = findShallowModules(input.filePath, input.fileContent);
  // Delta vs baseline (mirrors silent-catch): legacy pass-throughs captured at
  // `cerberus baseline` time are grandfathered; we only block when a file gains
  // MORE shallow modules than its snapshot. A new file (no baseline) is held to
  // the absolute threshold, so every finding is flagged. This keeps the
  // "delta, not absolute — legacy debt grandfathered" promise: touching a utils
  // file full of one-line exports no longer floods the gate.
  const baseCount = input.fileBaseline?.metrics.shallowModule?.count ?? 0;
  const flagged = findings.length > baseCount ? findings : [];
  const violations: Violation[] = flagged.map((f) => ({
    analyzer: 'shallow-module',
    location: `${f.name}:${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `"${f.name}" — ${f.reason}. Either inline the call at the caller (Ousterhout, *A Philosophy of Software Design* ch. 4), or move real abstraction inside (validation, error mapping, default values). Suppress with \`// cerberus-allow: shallow-module\` if the indirection is intentional (e.g. testing seam).`,
  }));

  return {
    passed: violations.length === 0,
    violations,
    metrics: { shallowModuleCount: findings.length },
  };
}
