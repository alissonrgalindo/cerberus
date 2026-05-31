import { Node, SyntaxKind } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
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
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    const name = fn.getName();
    if (name) return name;
  }
  if (Node.isConstructorDeclaration(fn)) return 'constructor';
  // Arrow/expression assigned to a variable: use the variable name.
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return '<anonymous>';
}

export async function analyzeCyclomatic(input: AnalyzerInput): Promise<AnalyzerResult> {
  const sourceFile = createSourceFile(input.filePath, input.fileContent);
  const threshold = input.config.thresholds.cyclomaticComplexity;
  const perFunctionBaseline = input.fileBaseline?.metrics.cyclomaticComplexity.perFunction;

  const violations: Violation[] = [];
  let max = 0;

  for (const fn of sourceFile.getDescendants().filter(isFunctionLike)) {
    const complexity = 1 + countDecisions(fn);
    max = Math.max(max, complexity);
    const name = functionName(fn);
    const line = fn.getStartLineNumber();
    const key = `${name}:${line}`;
    const baseline = perFunctionBaseline?.[name] ?? perFunctionBaseline?.[key] ?? threshold;

    if (complexity > threshold && complexity > baseline) {
      violations.push({
        analyzer: 'cyclomatic-complexity',
        location: key,
        current: complexity,
        threshold,
        baseline: perFunctionBaseline ? baseline : undefined,
        delta: perFunctionBaseline ? complexity - baseline : undefined,
        suggestion: `Function "${name}" has cyclomatic complexity ${complexity} (limit ${threshold}). Reduce branching or split into smaller functions.`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    metrics: { cyclomaticComplexityMax: max },
  };
}
