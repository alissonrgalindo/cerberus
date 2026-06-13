import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Drizzle mutation methods. We match `db.insert(...)`, `db.update(...)`,
 * `db.delete(...)`, and tx variants. The DB receiver name doesn't matter —
 * we look at the method name. This intentionally over-matches a tiny bit
 * (any object with these method names will count) in exchange for catching
 * common aliases like `tx`, `trx`, `database`, etc.
 */
const MUTATION_METHODS = new Set(['insert', 'update', 'delete']);

const FUNCTION_LIKE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
]);

/** Detects `'use server'` directive at the top of a file or function body. */
function isUseServerFile(content: string): boolean {
  // Match a directive in the first ~10 non-empty lines (covers shebangs/comments).
  const head = content.split('\n').slice(0, 12).join('\n');
  return /^\s*['"]use server['"]\s*;?/m.test(head);
}

/** True if a CallExpression looks like `<x>.insert/update/delete(...)`. */
function isDrizzleMutationCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  return MUTATION_METHODS.has(expr.getName());
}

/** True if a CallExpression looks like `<x>.transaction(...)`. */
function isTransactionCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  return expr.getName() === 'transaction';
}

function isFunctionLike(node: Node): boolean {
  return FUNCTION_LIKE_KINDS.has(node.getKind());
}

function functionName(fn: Node): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? '<anonymous>';
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return '<anonymous>';
}

type FunctionAudit = {
  name: string;
  line: number;
  mutationCount: number;
  wrappedInTransaction: boolean;
};

/**
 * Walks each function body and counts mutations at THIS function's level
 * (mutations inside a nested function get their own audit). A mutation is
 * "wrapped" if it appears inside a `.transaction(...)` callback within the
 * same function — that's the only thing the analyzer cares about.
 */
function auditFunctions(filePath: string, fileContent: string): FunctionAudit[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const fns = sourceFile.getDescendants().filter(isFunctionLike);
  const audits: FunctionAudit[] = [];

  for (const fn of fns) {
    let mutationCount = 0;
    let allWrapped = true;
    const fnIsInsideTransaction = hasTransactionAncestor(fn);

    fn.forEachDescendant((node, traversal) => {
      // Don't descend into nested functions — they get their own audit.
      if (node !== fn && isFunctionLike(node)) {
        traversal.skip();
        return;
      }
      if (!Node.isCallExpression(node)) return;
      if (!isDrizzleMutationCall(node)) return;
      mutationCount += 1;
      // The mutation is "wrapped" if either the enclosing function lives
      // inside a transaction callback OR an ancestor call up to `fn` is
      // itself a `.transaction(...)`.
      if (!fnIsInsideTransaction && !hasTransactionAncestorUpTo(node, fn)) {
        allWrapped = false;
      }
    });

    audits.push({
      name: functionName(fn),
      line: fn.getStartLineNumber(),
      mutationCount,
      wrappedInTransaction: mutationCount === 0 ? true : allWrapped || fnIsInsideTransaction,
    });
  }
  return audits;
}

/** Walks ancestors of `node` (stopping at `stopAt`) looking for a `.transaction(...)` call. */
function hasTransactionAncestorUpTo(node: Node, stopAt: Node): boolean {
  let cur: Node | undefined = node.getParent();
  while (cur && cur !== stopAt) {
    if (Node.isCallExpression(cur) && isTransactionCall(cur)) return true;
    cur = cur.getParent();
  }
  return false;
}

/** Walks all ancestors of `node` looking for a `.transaction(...)` call. */
function hasTransactionAncestor(node: Node): boolean {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isCallExpression(cur) && isTransactionCall(cur)) return true;
    cur = cur.getParent();
  }
  return false;
}

/**
 * Flags any function in a `'use server'` file that performs 2+ Drizzle
 * mutations without wrapping them in `db.transaction(...)`. Single mutations
 * are fine — atomicity is implicit. Multi-table mutations without a tx leak
 * partial state on failure (DDIA ch.7).
 */
export async function analyzeTransactionRequired(input: AnalyzerInput): Promise<AnalyzerResult> {
  if (!isUseServerFile(input.fileContent)) {
    return { passed: true, violations: [], metrics: { mutationFunctions: 0 } };
  }
  const audits = auditFunctions(input.filePath, input.fileContent);
  const violations: Violation[] = [];
  let mutationFunctions = 0;

  for (const a of audits) {
    if (a.mutationCount >= 2) mutationFunctions += 1;
    if (a.mutationCount >= 2 && !a.wrappedInTransaction) {
      violations.push({
        analyzer: 'transaction-required',
        location: `${a.name}:${a.line}`,
        current: a.mutationCount,
        threshold: 1,
        suggestion: `Function "${a.name}" performs ${a.mutationCount} Drizzle mutations without a transaction. Wrap with \`db.transaction(async (tx) => { ... })\` to avoid partial writes on failure.`,
      });
    }
  }

  return { passed: violations.length === 0, violations, metrics: { mutationFunctions } };
}
