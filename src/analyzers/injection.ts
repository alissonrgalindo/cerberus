import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';
import { createSourceFile } from './ts-project.js';

/**
 * Detects the injection sinks LLMs most commonly produce:
 *
 *   1. eval(...) / new Function(...)                        — code injection
 *   2. exec/execSync(`... ${x} ...`) or string concat       — shell injection
 *      (child_process; spawn/spawnSync with { shell: true } and a dynamic command too)
 *   3. sql.raw(x) where x is not a plain string literal     — SQL injection (Drizzle)
 *   4. .execute(...) / .query(...) with an interpolated     — SQL injection (pg/mysql2/
 *      template literal or string concatenation               knex-style raw strings)
 *   5. dangerouslySetInnerHTML={{ __html: x }} where x is   — XSS
 *      dynamic and not visibly sanitized (DOMPurify.sanitize / sanitizeHtml / .sanitize())
 *
 * Tagged templates (db.execute(sql`...`)) are SAFE — the tag parameterizes the
 * values — and are never flagged. Plain string literals are safe too.
 *
 * Suppression: `// quality-gate-allow: injection` on the same line.
 */

const SUPPRESSION = /quality-gate-allow:\s*injection\b/;

type Finding = { line: number; kind: string; detail: string };

const EXEC_NAMES = new Set(['exec', 'execSync']);
const SPAWN_NAMES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const QUERY_METHODS = new Set(['execute', 'query', 'raw']);
const SANITIZER_HINT = /sanitiz/i;

/** A template literal with at least one ${} substitution. */
function isInterpolatedTemplate(node: Node): boolean {
  return Node.isTemplateExpression(node);
}

/** String concatenation involving at least one non-literal operand. */
function isDynamicConcat(node: Node): boolean {
  if (!Node.isBinaryExpression(node)) return false;
  if (node.getOperatorToken().getKind() !== SyntaxKind.PlusToken) return false;
  const hasString = (n: Node): boolean =>
    Node.isStringLiteral(n) ||
    Node.isNoSubstitutionTemplateLiteral(n) ||
    (Node.isBinaryExpression(n) && (hasString(n.getLeft()) || hasString(n.getRight())));
  const hasDynamic = (n: Node): boolean =>
    Node.isBinaryExpression(n)
      ? hasDynamic(n.getLeft()) || hasDynamic(n.getRight())
      : !Node.isStringLiteral(n) && !Node.isNoSubstitutionTemplateLiteral(n);
  return hasString(node) && hasDynamic(node);
}

/** Dynamic string: interpolated template, concat with non-literals, or a bare non-literal. */
function isDynamicString(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return false;
  if (isInterpolatedTemplate(node)) return true;
  if (isDynamicConcat(node)) return true;
  return false;
}

function calleeName(call: CallExpression): { name: string; receiver?: string } {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return { name: expr.getText() };
  if (Node.isPropertyAccessExpression(expr)) {
    const root = expr.getExpression();
    return {
      name: expr.getName(),
      receiver: Node.isIdentifier(root) ? root.getText() : root.getText(),
    };
  }
  return { name: '' };
}

function hasShellTrueOption(call: CallExpression): boolean {
  for (const arg of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.getProperties()) {
      if (
        Node.isPropertyAssignment(prop) &&
        prop.getName() === 'shell' &&
        prop.getInitializer()?.getKind() === SyntaxKind.TrueKeyword
      ) {
        return true;
      }
    }
  }
  return false;
}

function looksSanitized(node: Node): boolean {
  if (Node.isCallExpression(node)) {
    return SANITIZER_HINT.test(node.getExpression().getText());
  }
  return false;
}

function checkCall(call: CallExpression, out: Finding[]): void {
  const line = call.getStartLineNumber();
  const { name, receiver } = calleeName(call);
  const firstArg = call.getArguments()[0];

  // 1. eval()
  if (name === 'eval' && !receiver && call.getArguments().length > 0) {
    out.push({ line, kind: 'eval', detail: 'eval() executes arbitrary code' });
    return;
  }

  // 2. exec / execSync with a dynamic command string
  if (EXEC_NAMES.has(name) && firstArg && isDynamicString(firstArg)) {
    out.push({
      line,
      kind: 'shell',
      detail: `${name}() with an interpolated command string`,
    });
    return;
  }

  // 2b. spawn-family with { shell: true } and a dynamic command
  if (SPAWN_NAMES.has(name) && firstArg && isDynamicString(firstArg) && hasShellTrueOption(call)) {
    out.push({
      line,
      kind: 'shell',
      detail: `${name}() with { shell: true } and an interpolated command`,
    });
    return;
  }

  // 3. sql.raw(non-literal)
  if (name === 'raw' && receiver === 'sql') {
    if (
      firstArg &&
      !Node.isStringLiteral(firstArg) &&
      !Node.isNoSubstitutionTemplateLiteral(firstArg)
    ) {
      out.push({ line, kind: 'sql', detail: 'sql.raw() with a non-literal argument' });
    }
    return;
  }

  // 4. db.execute(...) / db.query(...) / knex.raw(...) with interpolation/concat
  if (QUERY_METHODS.has(name) && receiver && firstArg && isDynamicString(firstArg)) {
    out.push({
      line,
      kind: 'sql',
      detail: `${receiver}.${name}() with an interpolated string (use a tagged template / parameterized query)`,
    });
  }
}

function checkNewFunction(node: Node, out: Finding[]): void {
  if (!Node.isNewExpression(node)) return;
  const expr = node.getExpression();
  if (Node.isIdentifier(expr) && expr.getText() === 'Function' && (node.getArguments().length ?? 0) > 0) {
    out.push({
      line: node.getStartLineNumber(),
      kind: 'eval',
      detail: 'new Function() compiles arbitrary code',
    });
  }
}

function checkDangerousHtml(node: Node, out: Finding[]): void {
  if (!Node.isJsxAttribute(node)) return;
  if (node.getNameNode().getText() !== 'dangerouslySetInnerHTML') return;
  const init = node.getInitializer();
  if (!init || !Node.isJsxExpression(init)) return;
  const obj = init.getExpression();
  if (!obj || !Node.isObjectLiteralExpression(obj)) return;
  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop) || prop.getName() !== '__html') continue;
    const value = prop.getInitializer();
    if (!value) continue;
    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) continue;
    if (looksSanitized(value)) continue;
    out.push({
      line: node.getStartLineNumber(),
      kind: 'xss',
      detail: 'dangerouslySetInnerHTML with unsanitized dynamic content',
    });
  }
}

function isSuppressed(lines: string[], line: number): boolean {
  const text = lines[line - 1];
  return text !== undefined && SUPPRESSION.test(text);
}

export function findInjections(filePath: string, fileContent: string): Finding[] {
  const sourceFile = createSourceFile(filePath, fileContent);
  const out: Finding[] = [];

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    checkCall(call, out);
  }
  for (const ne of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    checkNewFunction(ne, out);
  }
  for (const attr of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    checkDangerousHtml(attr, out);
  }

  const lines = fileContent.split('\n');
  return out.filter((f) => !isSuppressed(lines, f.line));
}

const SUGGESTIONS: Record<string, string> = {
  eval: 'Code injection: never build executable code from data. Replace with a lookup table, JSON.parse, or explicit logic.',
  shell:
    'Shell injection: pass arguments as an array (execFile(cmd, [args])) or use execa without a shell. Never interpolate user/runtime data into a command string.',
  sql: 'SQL injection: use a parameterized query or a tagged template (db.execute(sql`... ${x} ...`)) so values are bound, not concatenated.',
  xss: 'XSS: sanitize with DOMPurify.sanitize(...) before injecting HTML, or render as text. Suppress with `// quality-gate-allow: injection` only if the content is provably static.',
};

export async function analyzeInjection(input: AnalyzerInput): Promise<AnalyzerResult> {
  const findings = findInjections(input.filePath, input.fileContent);
  const violations: Violation[] = findings.map((f) => ({
    analyzer: 'injection',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    severity: 'security',
    suggestion: `${f.detail}. ${SUGGESTIONS[f.kind] ?? ''}`.trim(),
  }));

  return {
    passed: violations.length === 0,
    violations,
    metrics: { injectionCount: findings.length },
  };
}
