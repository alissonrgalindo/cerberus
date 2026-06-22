import { execaSync } from 'execa';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FileReport } from './engine.js';
import type { Violation } from './types.js';

/** Builds the debt comment injected above a problematic symbol. */
export function buildTodoComment(v: Violation, attempt: string): string {
  return `// TODO: cerberus(${v.analyzer}=${v.current}, limit=${v.threshold}, attempt=${attempt})`;
}

/** Extracts the 1-based source line a violation points at, if any. */
function targetLine(v: Violation): number {
  const colon = v.location.match(/:(\d+)\s*$/);
  if (colon) return Number(colon[1]);
  const lmark = v.location.match(/L(\d+)/);
  if (lmark) return Number(lmark[1]);
  return 1;
}

/**
 * Inserts `// TODO: cerberus(...)` comments above each violating line.
 * Inserts bottom-up so earlier line numbers stay valid, matches indentation,
 * and skips a comment that is already present directly above the target.
 */
export function injectTodos(content: string, violations: Violation[], attempt: string): string {
  const lines = content.split('\n');
  const byLine = new Map<number, string[]>();

  for (const v of violations) {
    const ln = targetLine(v);
    const comment = buildTodoComment(v, attempt);
    const arr = byLine.get(ln) ?? [];
    if (!arr.includes(comment)) arr.push(comment);
    byLine.set(ln, arr);
  }

  for (const ln of [...byLine.keys()].sort((a, b) => b - a)) {
    const idx = Math.min(Math.max(ln - 1, 0), lines.length);
    const indent = lines[idx]?.match(/^\s*/)?.[0] ?? '';
    const aboveText = lines[idx - 1] ?? '';
    const comments = byLine
      .get(ln)!
      .filter((c) => !aboveText.includes(c))
      .map((c) => indent + c);
    if (comments.length > 0) lines.splice(idx, 0, ...comments);
  }

  return lines.join('\n');
}

/** Applies TODO injection to a file on disk; returns true if it changed. */
export function applyTodoInjection(cwd: string, report: FileReport, attempt: string): boolean {
  const abs = resolve(cwd, report.file);
  const content = readFileSync(abs, 'utf8');
  const updated = injectTodos(content, report.violations, attempt);
  if (updated === content) return false;
  writeFileSync(abs, updated);
  return true;
}

/** Stages files so the injected comments are part of the commit. */
export function stageFiles(cwd: string, files: string[]): void {
  if (files.length === 0) return;
  // `--` ends option parsing so a tracked path that looks like a flag
  // (e.g. `-x`) is treated as a pathspec, not a git option.
  execaSync('git', ['add', '--', ...files], { cwd, reject: false });
}
