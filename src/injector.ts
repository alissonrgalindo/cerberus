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

function groupTodoComments(violations: Violation[], attempt: string): Map<number, string[]> {
  const byLine = new Map<number, string[]>();

  for (const violation of violations) {
    const line = targetLine(violation);
    const comment = buildTodoComment(violation, attempt);
    const comments = byLine.get(line) ?? [];
    if (!comments.includes(comment)) comments.push(comment);
    byLine.set(line, comments);
  }

  return byLine;
}

type MarkerBlock = {
  insertionIndex: number;
  indent: string;
  analyzerIndexes: Map<string, number>;
};

function markerAnalyzer(comment: string): string | undefined {
  return comment.match(/\/\/ TODO: cerberus\(([^=\s]+)=/)?.[1];
}

function scanMarkerBlock(lines: string[], lineNumber: number): MarkerBlock {
  let insertionIndex = Math.min(Math.max(lineNumber - 1, 0), lines.length);
  while (insertionIndex < lines.length && CERBERUS_MARKER_RE.test(lines[insertionIndex] ?? '')) {
    insertionIndex += 1;
  }

  const indent = lines[insertionIndex]?.match(/^\s*/)?.[0] ?? '';
  const analyzerIndexes = new Map<string, number>();
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const marker = lines[index] ?? '';
    if (!CERBERUS_MARKER_RE.test(marker)) break;
    const analyzer = markerAnalyzer(marker);
    if (analyzer !== undefined) analyzerIndexes.set(analyzer, index);
  }

  return { insertionIndex, indent, analyzerIndexes };
}

type MarkerUpdates = {
  lines: string[];
  indent: string;
  analyzerIndexes: Map<string, number>;
  pendingIndexes: Map<string, number>;
  additions: string[];
};

function addMarkerUpdate(updates: MarkerUpdates, comment: string): void {
  const analyzer = markerAnalyzer(comment);
  const existingIndex = analyzer === undefined ? undefined : updates.analyzerIndexes.get(analyzer);
  if (existingIndex !== undefined) {
    const markerIndent = updates.lines[existingIndex]?.match(/^\s*/)?.[0] ?? updates.indent;
    updates.lines[existingIndex] = markerIndent + comment;
    return;
  }

  const pendingIndex = analyzer === undefined ? undefined : updates.pendingIndexes.get(analyzer);
  if (pendingIndex !== undefined) {
    updates.additions[pendingIndex] = updates.indent + comment;
    return;
  }

  if (analyzer !== undefined) updates.pendingIndexes.set(analyzer, updates.additions.length);
  updates.additions.push(updates.indent + comment);
}

function updateMarkerBlock(lines: string[], lineNumber: number, comments: string[]): void {
  const block = scanMarkerBlock(lines, lineNumber);
  const updates: MarkerUpdates = {
    lines,
    indent: block.indent,
    analyzerIndexes: block.analyzerIndexes,
    pendingIndexes: new Map<string, number>(),
    additions: [],
  };

  for (const comment of comments) addMarkerUpdate(updates, comment);
  if (updates.additions.length > 0) {
    lines.splice(block.insertionIndex, 0, ...updates.additions);
  }
}

/**
 * Inserts `// TODO: cerberus(...)` comments above each violating line.
 * Inserts bottom-up so earlier line numbers stay valid, matches indentation,
 * and refreshes an analyzer marker already present directly above the target.
 */
export function injectTodos(content: string, violations: Violation[], attempt: string): string {
  const lines = content.split('\n');
  const byLine = groupTodoComments(violations, attempt);

  for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
    updateMarkerBlock(lines, line, byLine.get(line)!);
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
