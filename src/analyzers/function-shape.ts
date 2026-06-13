import { Node, SyntaxKind } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Function-shape checks from Clean Code §3:
 *
 *   - function-length: warn at > 40 source lines, fail at > 80 (defaults; configurable).
 *     Measured as raw line span between `{` and `}` of the body — comments and
 *     blank lines count, matching how reviewers visually scan a function.
 *
 *   - parameter-count: fail at > 4 parameters (Uncle Bob: "ideal is zero — three
 *     is the maximum, and that's already suspect"). 5+ is the line where
 *     parameter objects become mandatory.
 *
 * Both checks are delta-aware: a function already at 6 params or 100 lines in
 * the baseline isn't blocked unless the current change makes it worse. New
 * functions are held to the absolute threshold.
 *
 * Skips: type-only declarations, abstract methods, overload signatures.
 */

const FUNCTION_LIKE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
]);

export type FunctionShape = {
  name: string;
  line: number;
  bodyLines: number;
  paramCount: number;
};

function functionName(node: Node): string {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getName() ?? '<anonymous>';
  }
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return '<anonymous>';
}

export function measureFunctionShapes(filePath: string, fileContent: string): FunctionShape[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const shapes: FunctionShape[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (!FUNCTION_LIKE_KINDS.has(node.getKind())) continue;
    if (Node.isMethodDeclaration(node) && node.isAbstract()) continue;

    let bodyLines = 0;
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node)
    ) {
      const body = node.getBody();
      if (!body) continue; // overload signature with no body
      if (Node.isBlock(body)) {
        bodyLines = body.getEndLineNumber() - body.getStartLineNumber() + 1;
      } else {
        // Arrow with expression body: single-line.
        bodyLines = 1;
      }
    }

    let paramCount = 0;
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node)
    ) {
      paramCount = node.getParameters().length;
    }

    shapes.push({
      name: functionName(node),
      line: node.getStartLineNumber(),
      bodyLines,
      paramCount,
    });
  }
  return shapes;
}

export async function analyzeFunctionShape(input: AnalyzerInput): Promise<AnalyzerResult> {
  const shapes = measureFunctionShapes(input.filePath, input.fileContent);
  const violations: Violation[] = [];

  const lengthLimit = input.config.thresholds.functionLength;
  const paramLimit = input.config.thresholds.parameterCount;

  // Pull per-function baselines (delta-aware). Same keying as cognitive/cyclomatic.
  const baselineLengths = input.fileBaseline?.metrics.functionLength?.perFunction ?? {};
  const baselineParams = input.fileBaseline?.metrics.parameterCount?.perFunction ?? {};

  let worstLength = 0;
  let worstParams = 0;
  for (const s of shapes) {
    worstLength = Math.max(worstLength, s.bodyLines);
    worstParams = Math.max(worstParams, s.paramCount);

    const baseLen = baselineLengths[s.name] ?? 0;
    if (s.bodyLines > lengthLimit && s.bodyLines > baseLen) {
      violations.push({
        analyzer: 'function-length',
        location: `${s.name}:${s.line}`,
        current: s.bodyLines,
        threshold: lengthLimit,
        baseline: baseLen > 0 ? baseLen : undefined,
        delta: baseLen > 0 ? s.bodyLines - baseLen : undefined,
        suggestion: `Function "${s.name}" is ${s.bodyLines} lines (limit ${lengthLimit}). Clean Code §3: "functions should be small, then smaller than that". Extract sub-steps into named helpers.`,
      });
    }

    const baseParams = baselineParams[s.name] ?? 0;
    if (s.paramCount > paramLimit && s.paramCount > baseParams) {
      violations.push({
        analyzer: 'parameter-count',
        location: `${s.name}:${s.line}`,
        current: s.paramCount,
        threshold: paramLimit,
        baseline: baseParams > 0 ? baseParams : undefined,
        delta: baseParams > 0 ? s.paramCount - baseParams : undefined,
        suggestion: `Function "${s.name}" takes ${s.paramCount} parameters (limit ${paramLimit}). Group related args into a parameter object — Clean Code §3.4 ("argument lists"). Flag booleans are a red flag of their own.`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    metrics: {
      maxFunctionLength: worstLength,
      maxParameterCount: worstParams,
    },
  };
}
