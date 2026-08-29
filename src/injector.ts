import { execaSync } from 'execa';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FileReport } from './engine.js';
import { CERBERUS_MARKER_RE, type Violation } from './types.js';

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
 * and refreshes an analyzer marker already present directly above the target.
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
    let idx = Math.min(Math.max(ln - 1, 0), lines.length);
    while (idx < lines.length && CERBERUS_MARKER_RE.test(lines[idx] ?? '')) idx += 1;
    const indent = lines[idx]?.match(/^\s*/)?.[0] ?? '';
    const analyzersAbove = new Map<string, number>();

    // Only the contiguous Cerberus marker block immediately above the target
    // belongs to this site. Track line indexes so stale values can be refreshed.
    for (let aboveIdx = idx - 1; aboveIdx >= 0; aboveIdx -= 1) {
      const line = lines[aboveIdx] ?? '';
      if (!CERBERUS_MARKER_RE.test(line)) break;
      const analyzer = line.match(/\/\/ TODO: cerberus\(([^=\s]+)=/)?.[1];
      if (analyzer !== undefined) analyzersAbove.set(analyzer, aboveIdx);
    }

    const comments: string[] = [];
    const pendingAnalyzers = new Map<string, number>();
    for (const comment of byLine.get(ln)!) {
      const analyzer = comment.match(/\/\/ TODO: cerberus\(([^=\s]+)=/)?.[1];
      const markerIdx = analyzer === undefined ? undefined : analyzersAbove.get(analyzer);
      if (markerIdx !== undefined) {
        const markerIndent = lines[markerIdx]?.match(/^\s*/)?.[0] ?? indent;
        lines[markerIdx] = markerIndent + comment;
        continue;
      }

      const pendingIdx = analyzer === undefined ? undefined : pendingAnalyzers.get(analyzer);
      if (pendingIdx !== undefined) {
        comments[pendingIdx] = indent + comment;
        continue;
      }

      if (analyzer !== undefined) pendingAnalyzers.set(analyzer, comments.length);
      comments.push(indent + comment);
    }
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
