import { execaSync } from 'execa';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

function run(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  return execaSync('node', [CLI, ...args], {
    cwd,
    reject: false,
    env: opts.env,
    input: opts.input,
  });
}

function git(cwd: string, args: string[]): void {
  execaSync('git', args, { cwd });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@test.dev']);
  git(dir, ['config', 'user.name', 'test']);
}

const SECRET_FILE = `export const config = {
  apiKey: 'sk-ant-leakedleakedleakedleakedleaked',
};
`;

describe('security hardening (e2e)', () => {
  let dir: string;

  beforeAll(() => {
    if (!existsSync(CLI)) {
      execaSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT });
    }
  }, 120_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-sec-'));
    initRepo(dir);
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({}));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the anti-doom-loop never passes a secret through', () => {
    writeFileSync(join(dir, 'leak.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.ts']);

    // Default maxRefactorAttempts is 2 — by run 3+ a quality violation would
    // be let through with a TODO. A secret must keep failing forever.
    for (let i = 0; i < 4; i += 1) {
      const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
      expect(res.exitCode).toBe(1);
    }
  });

  it('QUALITY_GATE_BYPASS=1 still enforces security analyzers', () => {
    writeFileSync(join(dir, 'leak.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.ts']);

    const res = run(dir, ['check', '--staged'], { env: { QUALITY_GATE_BYPASS: '1' } });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/security checks still enforced/);
  });

  it('QUALITY_GATE_BYPASS=1 still skips quality-only violations', () => {
    const complex = `export function deep(x: number, raw: unknown): any {
  const v = raw as unknown as number;
  if (x > 0) { if (x > 1) { if (x > 2) { if (x > 3) { if (x > 4) { if (x > 5) { return x; } } } } } }
  return v;
}
`;
    writeFileSync(join(dir, 'messy.ts'), complex);
    git(dir, ['add', 'messy.ts']);

    const res = run(dir, ['check', '--staged'], { env: { QUALITY_GATE_BYPASS: '1' } });
    expect(res.exitCode).toBe(0);
  });

  it('claude-hook blocks a commit with a secret and never advertises bypasses', () => {
    writeFileSync(join(dir, 'leak.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.ts']);

    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "add config"' },
      cwd: dir,
    });
    const res = run(dir, ['claude-hook'], { input: payload });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/cannot be bypassed/);
    expect(res.stderr).not.toMatch(/QUALITY_GATE_BYPASS/);
    expect(res.stderr).not.toMatch(/skip-quality/);
  });

  it('claude-hook enforces security even when the agent writes [skip-quality]', () => {
    writeFileSync(join(dir, 'leak.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.ts']);

    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "fix [skip-quality]"' },
      cwd: dir,
    });
    const res = run(dir, ['claude-hook'], { input: payload });
    expect(res.exitCode).toBe(2);
  });

  it('claude-hook enforces security when the agent inlines QUALITY_GATE_BYPASS=1', () => {
    writeFileSync(join(dir, 'leak.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.ts']);

    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'QUALITY_GATE_BYPASS=1 git commit -m "ship it"' },
      cwd: dir,
    });
    const res = run(dir, ['claude-hook'], { input: payload });
    expect(res.exitCode).toBe(2);
  });

  it('catches a secret in the STAGED blob even after it is wiped from the working tree', () => {
    // Stage the secret, then "clean up" the working tree without re-staging.
    // The index (what commits) still carries the secret — the gate must read
    // the staged blob, not the dirty working tree.
    writeFileSync(join(dir, 'cfg.ts'), SECRET_FILE);
    git(dir, ['add', 'cfg.ts']);
    writeFileSync(join(dir, 'cfg.ts'), 'export const k = process.env.K;\n');

    const staged = execaSync('git', ['show', ':cfg.ts'], { cwd: dir }).stdout;
    expect(staged).toMatch(/sk-ant-/); // the committed blob is the leaky one

    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/secret-in-diff/);
  });

  it('check --base analyzes files changed vs. a base ref (CI mode)', () => {
    writeFileSync(join(dir, 'clean.ts'), 'export const ok = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'init']);

    git(dir, ['checkout', '-qb', 'feature']);
    writeFileSync(join(dir, 'leak.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.ts']);
    git(dir, ['commit', '-qm', 'add leak']);

    const res = run(dir, ['check', '--base', 'main']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/secret-in-diff/);

    const clean = run(dir, ['check', '--base', 'feature']);
    expect(clean.exitCode).toBe(0);
  });
});
