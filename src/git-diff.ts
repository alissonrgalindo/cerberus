import { execaSync } from 'execa';
import { readFileSync } from 'node:fs';

/** Returns staged file paths (relative to repo root) matching the diff filter. */
export function getStagedFiles(cwd: string, filter = 'ACMR'): string[] {
  try {
    const { stdout } = execaSync('git', ['diff', '--cached', '--name-only', `--diff-filter=${filter}`], {
      cwd,
    });
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns files changed vs. a base ref (CI mode): `git diff base...HEAD`.
 * The three-dot form diffs against the merge-base, which is what a PR shows.
 */
export function getChangedFiles(cwd: string, baseRef: string, filter = 'ACMR'): string[] {
  try {
    const { stdout } = execaSync(
      'git',
      ['diff', '--name-only', `--diff-filter=${filter}`, `${baseRef}...HEAD`],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Reads file content from disk (the agent may have edited a staged file in place). */
export function getFileContent(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/**
 * Reads the STAGED (index) content of a path — the bytes that would actually
 * land in the commit, which can differ from the working tree under partial
 * staging (`git add -p`) or a stage-then-edit. Security analyzers must judge
 * what is committed, not the dirty working tree, so a secret staged then wiped
 * from disk can't slip past. Returns null when the path has no index entry
 * (caller falls back to disk).
 */
export function getStagedContent(cwd: string, relPath: string): string | null {
  try {
    const { stdout } = execaSync('git', ['show', `:${relPath}`], { cwd, stripFinalNewline: false });
    return stdout;
  } catch {
    return null;
  }
}
