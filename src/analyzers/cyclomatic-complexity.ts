import { Node, SyntaxKind } from 'ts-morph';
import {
  functionBaselineFloor,
  type AnalyzerInput,
  type AnalyzerResult,
  type FunctionScore,
  type Violation,
} from '../types.js';
import { createSourceFile } from './ts-project.js';

const FUNCTION_LIKE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/** Nodes that add a branch to McCabe cyclomatic complexity. */
const DECISION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.CatchClause,
]);

const LOGICAL_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

function isFunctionLike(node: Node): boolean {
  return FUNCTION_LIKE_KINDS.has(node.getKind());
}

/** Counts decision points inside a function body, NOT descending into nested functions. */
function countDecisions(fn: Node): number {
  let count = 0;
  fn.forEachDescendant((node, traversal) => {
    if (node !== fn && isFunctionLike(node)) {
      traversal.skip(); // nested function gets its own complexity score
      return;
    }
    const kind = node.getKind();
    if (DECISION_KINDS.has(kind)) {
      count += 1;
    } else if (Node.isBinaryExpression(node) && LOGICAL_TOKENS.has(node.getOperatorToken().getKind())) {
      count += 1;
    }
  });
  return count;
}

function functionName(fn: Node): string {
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn) ||
    Node.isGetAccessorDeclaration(fn) ||
    Node.isSetAccessorDeclaration(fn)
  ) {
    const name = fn.getName();
    if (name) return name;
  }
  if (Node.isConstructorDeclaration(fn)) return 'constructor';
  // Arrow/expression assigned to a variable or property: use that name.
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return '<anonymous>';
}

/** Raw measurement (no thresholds) — shared with the baseline builder. */
export function measureCyclomatic(filePath: string, fileContent: string): FunctionScore[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  return sourceFile
    .getDescendants()
    .filter(isFunctionLike)
    .map((fn) => ({
      name: functionName(fn),
      line: fn.getStartLineNumber(),
      score: 1 + countDecisions(fn),
    }));
}

export async function analyzeCyclomatic(input: AnalyzerInput): Promise<AnalyzerResult> {
  const functions = measureCyclomatic(input.filePath, input.fileContent);
  const threshold = input.config.thresholds.cyclomaticComplexity;
  const perFunctionBaseline = input.fileBaseline?.metrics.cyclomaticComplexity.perFunction;
  const baselineMax = input.fileBaseline?.metrics.cyclomaticComplexity.max ?? 0;

  const violations: Violation[] = [];
  let max = 0;

  for (const fn of functions) {
    max = Math.max(max, fn.score);
    const baseline = functionBaselineFloor(fn.name, perFunctionBaseline, baselineMax, threshold);
    if (fn.score > threshold && fn.score > baseline) {
      violations.push({
        analyzer: 'cyclomatic-complexity',
        location: `${fn.name}:${fn.line}`,
        current: fn.score,
        threshold,
        baseline: perFunctionBaseline ? baseline : undefined,
        delta: perFunctionBaseline ? fn.score - baseline : undefined,
        suggestion: `Function "${fn.name}" has cyclomatic complexity ${fn.score} (limit ${threshold}). Reduce branching or split into smaller functions.`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    metrics: { cyclomaticComplexityMax: max },
  };
}
