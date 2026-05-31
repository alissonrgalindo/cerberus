import { execaSync } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

const NEW_BAD = `export function Bad({ x }: { x: number }): any {
  if (x > 0) { if (x > 1) { if (x > 2) { if (x > 3) { if (x > 4) { if (x > 5) { return x; } } } } } }
  return 0;
}
`;

function cli(cwd: string, args: string[], env?: Record<string, string>) {
  return execaSync('node', [CLI, ...args], { cwd, reject: false, env });
}

function git(cwd: string, args: string[], env?: Record<string, string>) {
  return execaSync('git', args, { cwd, reject: false, env });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qg-hooks-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(
    join(dir, '.quality-gate.json'),
    JSON.stringify({
      extends: '@quality-gate/nextjs',
      preCommit: { enabled: ['cognitive', 'cyclomatic', 'type-safety'] },
    }),
  );
  writeFileSync(join(dir, '.gitignore'), '.quality-gate-attempts.json\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = 1;\n');
  return dir;
}

beforeAll(() => {
  if (!existsSync(CLI)) execaSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT });
}, 120_000);

describe('install-hooks (integration)', () => {
  it('installs a marked git hook and registers the Claude Code hook', () => {
    const dir = makeRepo();
    const res = cli(dir, ['install-hooks']);
    expect(res.exitCode).toBe(0);
    const hook = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('quality-gate-hook');
    expect(hook).toContain('check --staged --mode pre-commit');
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('claude-hook');
  });

  it('appends to an existing husky pre-commit hook without touching the shims', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.husky', '_'), { recursive: true });
    writeFileSync(join(dir, '.husky', 'pre-commit'), '#!/bin/sh\npnpm exec lint-staged\n', { mode: 0o755 });
    const res = cli(dir, ['install-hooks']);
    expect(res.stdout).toContain('appended to husky hook');
    const hook = readFileSync(join(dir, '.husky', 'pre-commit'), 'utf8');
    expect(hook).toContain('pnpm exec lint-staged'); // original preserved
    expect(hook).toContain('quality-gate-hook'); // gate appended
    expect(hook).toContain('check --staged --mode pre-commit');
    expect(hook).toMatch(/^\s*set -e\b/m); // prior commands still block on failure

    // idempotent: a second install does not duplicate the block
    cli(dir, ['install-hooks']);
    const after = readFileSync(join(dir, '.husky', 'pre-commit'), 'utf8');
    expect(after.match(/quality-gate-hook/g)).toHaveLength(1);
  });

  it('backs up and wraps a pre-existing hook', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/usr/bin/env sh\necho hi\n', { mode: 0o755 });
    const res = cli(dir, ['install-hooks']);
    expect(res.stdout).toContain('wrapped existing hook');
    expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit.backup-quality-gate'))).toBe(true);
    expect(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('backup-quality-gate');
  });

  it('blocks bad commits, then passes the 3rd with a TODO injected', () => {
    const dir = makeRepo();
    cli(dir, ['baseline']);
    cli(dir, ['install-hooks']);
    writeFileSync(join(dir, 'src', 'bad.tsx'), NEW_BAD);
    git(dir, ['add', 'src/bad.tsx', '.gitignore']);

    const c1 = git(dir, ['commit', '-m', 'bad 1']);
    const c2 = git(dir, ['commit', '-m', 'bad 2']);
    const c3 = git(dir, ['commit', '-m', 'bad 3']);

    expect(c1.exitCode).not.toBe(0);
    expect(c2.exitCode).not.toBe(0);
    expect(c3.exitCode).toBe(0);

    // a commit now exists and the file carries the debt flag
    expect(git(dir, ['rev-parse', 'HEAD']).exitCode).toBe(0);
    expect(readFileSync(join(dir, 'src', 'bad.tsx'), 'utf8')).toContain('TODO: quality-gate(');
  });

  it('QUALITY_GATE_BYPASS=1 lets a bad commit through immediately', () => {
    const dir = makeRepo();
    cli(dir, ['baseline']);
    cli(dir, ['install-hooks']);
    writeFileSync(join(dir, 'src', 'bad.tsx'), NEW_BAD);
    git(dir, ['add', 'src/bad.tsx', '.gitignore']);
    const res = git(dir, ['commit', '-m', 'bypass'], { QUALITY_GATE_BYPASS: '1' });
    expect(res.exitCode).toBe(0);
  });
});

describe('claude-hook (integration)', () => {
  it('blocks a git commit payload with exit 2', () => {
    const dir = makeRepo();
    cli(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'bad.tsx'), NEW_BAD);
    git(dir, ['add', 'src/bad.tsx']);
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m wip' },
      cwd: dir,
    });
    const res = execaSync('node', [CLI, 'claude-hook'], { cwd: dir, input: payload, reject: false });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('blocked this commit');
  });

  it('ignores non-commit commands with exit 0', () => {
    const dir = makeRepo();
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline' },
      cwd: dir,
    });
    const res = execaSync('node', [CLI, 'claude-hook'], { cwd: dir, input: payload, reject: false });
    expect(res.exitCode).toBe(0);
  });
});
