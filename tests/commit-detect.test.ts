import { describe, expect, it } from 'vitest';
import { isGitCommit } from '../src/commit-detect.js';

describe('isGitCommit', () => {
  it('matches plain and flagged commits', () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true);
    expect(isGitCommit('git commit')).toBe(true);
    expect(isGitCommit('git -C /repo commit -m x')).toBe(true);
    expect(isGitCommit('git add . && git commit -m x')).toBe(true);
  });

  it('ignores non-commit git commands', () => {
    expect(isGitCommit('git log --oneline')).toBe(false);
    expect(isGitCommit('git show HEAD')).toBe(false);
    expect(isGitCommit('git status')).toBe(false);
    expect(isGitCommit('git commit-tree abc')).toBe(false);
  });

  it('ignores unrelated commands that mention commit', () => {
    expect(isGitCommit('echo "time to commit"')).toBe(false);
    expect(isGitCommit('npm run commit-lint')).toBe(false);
  });
});
