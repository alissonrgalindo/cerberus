import { describe, expect, it } from 'vitest';
import { isGitCommit } from '../src/commit-detect.js';

describe('isGitCommit', () => {
  it('matches plain and flagged commits', () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true);
    expect(isGitCommit('git commit')).toBe(true);
    expect(isGitCommit('git -C /repo commit -m x')).toBe(true);
    expect(isGitCommit('git add . && git commit -m x')).toBe(true);
    expect(isGitCommit('git commit --no-verify -m x')).toBe(true);
  });

  it('catches evasions that route around the first git token', () => {
    // Path-qualified binary.
    expect(isGitCommit('/usr/bin/git commit --no-verify -m x')).toBe(true);
    expect(isGitCommit('C:\\tools\\git.exe commit')).toBe(true);
    // Newline-joined (a single Bash tool call with two commands).
    expect(isGitCommit('git status\ngit commit --no-verify -m x')).toBe(true);
    // Subshell / grouping / negation prefixes.
    expect(isGitCommit('(git commit --no-verify -m x)')).toBe(true);
    expect(isGitCommit('{ git commit -m x; }')).toBe(true);
    // command/builtin prefix, and backgrounded commit.
    expect(isGitCommit('command git commit -m x')).toBe(true);
    expect(isGitCommit('git commit -m x &')).toBe(true);
  });

  it('ignores non-commit git commands', () => {
    expect(isGitCommit('git log --oneline')).toBe(false);
    expect(isGitCommit('git show HEAD')).toBe(false);
    expect(isGitCommit('git status')).toBe(false);
    expect(isGitCommit('git commit-tree abc')).toBe(false);
    expect(isGitCommit('git status\ngit log\ngit diff')).toBe(false);
    expect(isGitCommit('(git log)')).toBe(false);
  });

  it('ignores unrelated commands that mention commit', () => {
    expect(isGitCommit('echo "time to commit"')).toBe(false);
    expect(isGitCommit('npm run commit-lint')).toBe(false);
    expect(isGitCommit('digit commit')).toBe(false); // not a git binary
  });
});
