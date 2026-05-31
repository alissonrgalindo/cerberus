import { Node, SyntaxKind } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

const SUPPRESSION_RE = /(?:\/\/|\/\*|\*)\s*@ts-(?:ignore|expect-error|nocheck)\b/;

type Counts = {
  anyCount: number;
  anyLines: number[];
  asUnknownAsCount: number;
  asUnknownAsLines: number[];
  tsIgnoreCount: number;
  tsIgnoreLines: number[];
};

/** Counts type-safety escape hatches via AST (never regex on raw `any` to avoid string matches). */
function countEscapes(input: AnalyzerInput): Counts {
  const sourceFile = createSourceFile(input.filePath, input.fileContent);

  const anyLines: number[] = [];
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword)) {
    anyLines.push(node.getStartLineNumber());
  }

  const asUnknownAsLines: number[] = [];
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression)) {
    const inner = node.getExpression();
    if (Node.isAsExpression(inner) && inner.getType().isUnknown()) {
      asUnknownAsLines.push(node.getStartLineNumber());
    }
  }

  // Suppression directives only carry meaning inside comments — match comment-prefixed lines.
  const tsIgnoreLines: number[] = [];
  input.fileContent.split('\n').forEach((line, idx) => {
    if (SUPPRESSION_RE.test(line)) tsIgnoreLines.push(idx + 1);
  });

  return {
    anyCount: anyLines.length,
    anyLines,
    asUnknownAsCount: asUnknownAsLines.length,
    asUnknownAsLines,
    tsIgnoreCount: tsIgnoreLines.length,
    tsIgnoreLines,
  };
}

function fmtLines(lines: number[]): string {
  return lines.map((l) => `L${l}`).join(', ');
}

export async function analyzeTypeSafety(input: AnalyzerInput): Promise<AnalyzerResult> {
  const counts = countEscapes(input);
  const baseline = input.fileBaseline?.metrics.typeSafety;
  const violations: Violation[] = [];

  const checks: Array<{
    label: string;
    current: number;
    lines: number[];
    base: number;
    allowedDelta: number;
    suggestion: string;
  }> = [
    {
      label: 'any',
      current: counts.anyCount,
      lines: counts.anyLines,
      base: baseline?.anyCount ?? 0,
      allowedDelta: input.config.thresholds.newAnyCount,
      suggestion: 'Replace `any` with an inferred or explicit type.',
    },
    {
      label: 'as-unknown-as',
      current: counts.asUnknownAsCount,
      lines: counts.asUnknownAsLines,
      base: baseline?.asUnknownAsCount ?? 0,
      allowedDelta: input.config.thresholds.newAnyCount,
      suggestion: 'Avoid `as unknown as` double casts — narrow the type properly.',
    },
    {
      label: 'ts-ignore',
      current: counts.tsIgnoreCount,
      lines: counts.tsIgnoreLines,
      base: baseline?.tsIgnoreCount ?? 0,
      allowedDelta: input.config.thresholds.newTsIgnoreCount,
      suggestion: 'Remove the suppression directive and fix the underlying type error.',
    },
  ];

  for (const check of checks) {
    const delta = check.current - check.base;
    if (delta > check.allowedDelta) {
      violations.push({
        analyzer: 'type-safety',
        location: fmtLines(check.lines) || `${check.label}`,
        current: check.current,
        threshold: check.base + check.allowedDelta,
        baseline: input.fileBaseline ? check.base : undefined,
        delta,
        suggestion: `${delta} new \`${check.label}\` (${fmtLines(check.lines)}). ${check.suggestion}`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    metrics: {
      anyCount: counts.anyCount,
      asUnknownAsCount: counts.asUnknownAsCount,
      tsIgnoreCount: counts.tsIgnoreCount,
    },
  };
}
