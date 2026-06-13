import { Node, SyntaxKind, type CallExpression, type AwaitExpression } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Detects DB queries executed once per iteration of a loop — the classic
 * N+1 pattern (DDIA ch.2). Targets ORM call shapes common in this codebase:
 *
 *   for (const x of items) await db.query.users.findFirst(...)
 *   items.map(async (x) => await db.select()...)
 *
 * We look for `await db.*` (or `await tx.*`/`trx.*`) inside loop bodies and
 * inside `.map/.forEach/.flatMap/.filter/.reduce` callbacks over an array.
 * The receiver name is configurable in spirit but defaults to a small set
 * of common aliases for the Drizzle client.
 */
const DB_RECEIVERS = new Set(['db', 'tx', 'trx', 'database']);
const ARRAY_ITERATOR_METHODS = new Set(['map', 'forEach', 'flatMap', 'filter', 'reduce']);

const LOOP_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
]);

const FUNCTION_LIKE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
]);

/** Walks down chained property accesses AND call expressions to the root receiver. */
function rootReceiver(node: Node): Node {
  let cur: Node = node;
  // Drizzle queries chain like `db.select().from(t).where(...)` — the .getExpression()
  // of a CallExpression is another expression that can itself be a PropertyAccess
  // or a CallExpression. Unwrap both until we hit the bare identifier.
  while (true) {
    if (Node.isPropertyAccessExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node.isCallExpression(cur)) {
      cur = cur.getExpression();
    } else {
      break;
    }
  }
  return cur;
}

/** True for `db.something` / `db.query.x.findFirst` / `db.select().from(...).where(...)`. */
function isDbAccess(call: CallExpression): boolean {
  const root = rootReceiver(call.getExpression());
  return Node.isIdentifier(root) && DB_RECEIVERS.has(root.getText());
}

/** Get the receiver identifier name for diagnostic output. */
function dbReceiverName(call: CallExpression): string {
  const root = rootReceiver(call.getExpression());
  return Node.isIdentifier(root) ? root.getText() : 'db';
}

/** True if the await is inside a loop body, stopping at function boundaries. */
function isInsideLoop(node: Node): { kind: 'loop'; line: number } | null {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const kind = cur.getKind();
    if (FUNCTION_LIKE_KINDS.has(kind)) {
      // An async callback can still be a loop body (.map(async ...)). Don't
      // stop here unconditionally — check the parent for an iterator call
      // before bailing.
      const parent = cur.getParent();
      if (parent && Node.isCallExpression(parent) && isArrayIteratorCall(parent)) {
        return { kind: 'loop', line: parent.getStartLineNumber() };
      }
      return null;
    }
    if (LOOP_KINDS.has(kind)) {
      return { kind: 'loop', line: cur.getStartLineNumber() };
    }
    cur = cur.getParent();
  }
  return null;
}

/** True for `xs.map(...)`, `xs.forEach(...)`, etc. — heuristic, not type-aware. */
function isArrayIteratorCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  return ARRAY_ITERATOR_METHODS.has(expr.getName());
}

type Finding = {
  line: number;
  loopLine: number;
  receiver: string;
};

function findNPlusOne(filePath: string, fileContent: string): Finding[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const findings: Finding[] = [];

  for (const awaitExpr of sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const inner = (awaitExpr as AwaitExpression).getExpression();
    if (!Node.isCallExpression(inner)) continue;
    if (!isDbAccess(inner)) continue;
    const loop = isInsideLoop(awaitExpr);
    if (!loop) continue;
    findings.push({
      line: awaitExpr.getStartLineNumber(),
      loopLine: loop.line,
      receiver: dbReceiverName(inner),
    });
  }
  return findings;
}

export async function analyzeNPlusOneQuery(input: AnalyzerInput): Promise<AnalyzerResult> {
  const findings = findNPlusOne(input.filePath, input.fileContent);
  const violations: Violation[] = findings.map((f) => ({
    analyzer: 'n-plus-one-query',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `\`await ${f.receiver}.*\` runs once per iteration of the loop at L${f.loopLine}. Hoist the query out of the loop (use \`inArray()\` or a relational \`with:\` query to batch).`,
  }));

  return {
    passed: violations.length === 0,
    violations,
    metrics: { nPlusOneCount: findings.length },
  };
}
