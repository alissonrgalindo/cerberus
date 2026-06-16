import { Node, SyntaxKind, type CatchClause } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Detects `try { ... } catch { }` blocks that swallow errors silently — Clean
 * Code §7 ("Use Exceptions Rather Than Return Codes" / "Don't Return Null").
 *
 * Three flavors are flagged:
 *   1. Empty catch body:                   } catch (e) {}
 *   2. Body whose only statement(s) are a console.* log:  } catch (e) { console.log(e) }
 *   3. A bare comment with no real handling: } catch (e) { /* ignore *\/ }
 *
 * Rethrows (`throw e`), assignments, function calls beyond console.*, or any
 * control flow (return/continue/break/await) count as handling — we want to
 * permit "log + rethrow" and "log + report to Sentry" patterns. LLMs love to
 * paper over failing test fixtures with `catch (e) { console.log(e) }`; this
 * is the single highest-signal smell in agent-generated code.
 */
const CONSOLE_RECEIVERS = new Set(['console', 'logger', 'log']);

type Finding = { line: number; kind: 'empty' | 'console-only' };

function isConsoleCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const expr = node.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  const root = expr.getExpression();
  return Node.isIdentifier(root) && CONSOLE_RECEIVERS.has(root.getText());
}

function statementIsConsoleCall(stmt: Node): boolean {
  if (!Node.isExpressionStatement(stmt)) return false;
  return isConsoleCall(stmt.getExpression());
}

function classifyCatch(clause: CatchClause): Finding | null {
  const block = clause.getBlock();
  const statements = block.getStatements();
  const line = clause.getStartLineNumber();

  if (statements.length === 0) return { line, kind: 'empty' };

  // Body is only console.* calls — still silent in practice.
  const allConsole = statements.every(statementIsConsoleCall);
  if (allConsole) return { line, kind: 'console-only' };

  return null;
}

function findSilentCatches(filePath: string, fileContent: string): Finding[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const out: Finding[] = [];
  for (const clause of sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const finding = classifyCatch(clause);
    if (finding) out.push(finding);
  }
  return out;
}

/** Counts silent-catch findings in a file — used to snapshot the baseline so legacy catches are grandfathered. */
export function measureSilentCatch(filePath: string, fileContent: string): number {
  return findSilentCatches(filePath, fileContent).length;
}

export async function analyzeSilentCatch(input: AnalyzerInput): Promise<AnalyzerResult> {
  const findings = findSilentCatches(input.filePath, input.fileContent);
  // Delta vs baseline: legacy empty catches captured at `quality-gate baseline` time are
  // grandfathered; we only block when a file gains MORE silent catches than its snapshot.
  // A new file (no baseline) is held to the absolute threshold (every finding flagged).
  const baseCount = input.fileBaseline?.metrics.silentCatch?.count ?? 0;
  const flagged = findings.length > baseCount ? findings : [];
  const violations: Violation[] = flagged.map((f) => ({
    analyzer: 'silent-catch',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion:
      f.kind === 'empty'
        ? `Empty catch at L${f.line} swallows the error. Either rethrow (\`throw e\`), report it (Sentry/logger.error), or document with a comment why ignoring is safe and include the caught binding.`
        : `Catch at L${f.line} only logs to console. Logging is not handling — rethrow, return a typed error, or hand it to your error reporter.`,
  }));

  return {
    passed: violations.length === 0,
    violations,
    metrics: { silentCatchCount: findings.length },
  };
}
