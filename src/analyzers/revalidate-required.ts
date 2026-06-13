import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Server Action mutations must invalidate the cache or the UI shows stale
 * data after the action returns. This analyzer flags any exported async
 * function in a `'use server'` file that performs a Drizzle mutation but
 * never calls `revalidatePath`, `revalidateTag`, or `redirect` (redirect
 * implicitly busts the cache for the target route).
 */
const MUTATION_METHODS = new Set(['insert', 'update', 'delete']);
const REVALIDATORS = new Set(['revalidatePath', 'revalidateTag', 'redirect']);

const FUNCTION_LIKE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
]);

function isUseServerFile(content: string): boolean {
  const head = content.split('\n').slice(0, 12).join('\n');
  return /^\s*['"]use server['"]\s*;?/m.test(head);
}

function isFunctionLike(node: Node): boolean {
  return FUNCTION_LIKE_KINDS.has(node.getKind());
}

function isDrizzleMutationCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  return MUTATION_METHODS.has(expr.getName());
}

/** True for top-level `revalidatePath(...)`, `revalidateTag(...)`, `redirect(...)`. */
function isRevalidatorCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return REVALIDATORS.has(expr.getText());
  if (Node.isPropertyAccessExpression(expr)) return REVALIDATORS.has(expr.getName());
  return false;
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

/**
 * Only audits "top-level exported async" functions — the actual Server
 * Action surface. Helpers/inner closures aren't actions themselves; they
 * should be allowed to do raw mutations as long as the action wrapping
 * them revalidates.
 */
function isExportedActionLike(fn: Node): boolean {
  if (Node.isFunctionDeclaration(fn)) {
    return fn.isExported() && fn.isAsync();
  }
  // `export const action = async () => { ... }` / `export const action = async function () {}`.
  const varDecl = fn.getParent();
  if (varDecl && Node.isVariableDeclaration(varDecl)) {
    const stmt = varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (!stmt || !stmt.isExported()) return false;
    if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) return fn.isAsync();
  }
  return false;
}

type ActionAudit = {
  name: string;
  line: number;
  hasMutation: boolean;
  hasRevalidator: boolean;
};

function auditActions(filePath: string, fileContent: string): ActionAudit[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const actions = sourceFile.getDescendants().filter(isFunctionLike).filter(isExportedActionLike);
  const audits: ActionAudit[] = [];

  for (const fn of actions) {
    let hasMutation = false;
    let hasRevalidator = false;
    fn.forEachDescendant((node, traversal) => {
      if (node !== fn && isFunctionLike(node)) {
        traversal.skip();
        return;
      }
      if (!Node.isCallExpression(node)) return;
      if (isDrizzleMutationCall(node)) hasMutation = true;
      if (isRevalidatorCall(node)) hasRevalidator = true;
    });
    audits.push({
      name: functionName(fn),
      line: fn.getStartLineNumber(),
      hasMutation,
      hasRevalidator,
    });
  }
  return audits;
}

export async function analyzeRevalidateRequired(input: AnalyzerInput): Promise<AnalyzerResult> {
  if (!isUseServerFile(input.fileContent)) {
    return { passed: true, violations: [], metrics: { mutatingActions: 0 } };
  }
  const audits = auditActions(input.filePath, input.fileContent);
  const violations: Violation[] = [];
  let mutatingActions = 0;

  for (const a of audits) {
    if (!a.hasMutation) continue;
    mutatingActions += 1;
    if (!a.hasRevalidator) {
      violations.push({
        analyzer: 'revalidate-required',
        location: `${a.name}:${a.line}`,
        current: 0,
        threshold: 1,
        suggestion: `Server Action "${a.name}" mutates data but never calls revalidatePath/revalidateTag (or redirect). Cached pages will show stale data — add revalidation before returning.`,
      });
    }
  }

  return { passed: violations.length === 0, violations, metrics: { mutatingActions } };
}
