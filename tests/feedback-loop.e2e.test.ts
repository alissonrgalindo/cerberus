import { execaSync } from 'execa';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

function run(cwd: string, args: string[], input?: string) {
  return execaSync('node', [CLI, ...args], { cwd, reject: false, input });
}

function initRepo(dir: string): void {
  execaSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execaSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  execaSync('git', ['config', 'user.name', 't'], { cwd: dir });
}

describe('feedback loop (e2e)', () => {
  let dir: string;

  beforeAll(() => {
    if (!existsSync(CLI)) execaSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT });
  }, 120_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-loop-'));
    initRepo(dir);
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({}));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('claude-post-edit-hook', () => {
    it('feeds violations back after an Edit (exit 2)', () => {
      const file = join(dir, 'service.py');
      writeFileSync(file, 'try:\n    risky()\nexcept Exception:\n    pass\n');
      const payload = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: file },
        cwd: dir,
      });
      const res = run(dir, ['claude-post-edit-hook'], payload);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toMatch(/silent-catch/);
      expect(res.stderr).toMatch(/fix them now/);
    });

    it('stays silent on a clean edit (exit 0)', () => {
      const file = join(dir, 'ok.py');
      writeFileSync(file, 'def add(a, b):\n    return a + b\n');
      const payload = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: file },
        cwd: dir,
      });
      expect(run(dir, ['claude-post-edit-hook'], payload).exitCode).toBe(0);
    });

    it('catches a secret in a freshly written config file', () => {
      const file = join(dir, 'settings.ts');
      writeFileSync(file, `export const key = 'sk-ant-leakleakleakleakleakleakleak';\n`);
      const payload = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: file },
        cwd: dir,
      });
      const res = run(dir, ['claude-post-edit-hook'], payload);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toMatch(/secret-in-diff/);
    });

    it('ignores non-edit tools', () => {
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir });
      expect(run(dir, ['claude-post-edit-hook'], payload).exitCode).toBe(0);
    });
  });

  describe('--format github', () => {
    it('emits ::error annotations with file and line', () => {
      writeFileSync(join(dir, 'leak.py'), 'eval(user_input)\n');
      execaSync('git', ['add', 'leak.py'], { cwd: dir });
      const res = run(dir, ['check', '--staged', '--format', 'github']);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toMatch(/^::error file=leak\.py,line=1,title=cerberus%3A injection \[SECURITY\]::/m);
    });

    it('emits nothing on a clean check', () => {
      writeFileSync(join(dir, 'ok.py'), 'def f():\n    return 1\n');
      execaSync('git', ['add', 'ok.py'], { cwd: dir });
      const res = run(dir, ['check', '--staged', '--format', 'github']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toMatch(/::error/);
    });
  });

  describe('install-hooks', () => {
    it('registers both Claude Code hooks', () => {
      run(dir, ['install-hooks']);
      const settings = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
      expect(settings).toMatch(/claude-hook/);
      expect(settings).toMatch(/claude-post-edit-hook/);
      expect(settings).toMatch(/Edit\|Write\|MultiEdit/);
    });

    it('git hook has no shell-level bypass', () => {
      run(dir, ['install-hooks']);
      const hook = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
      expect(hook).not.toMatch(/QUALITY_GATE_BYPASS.*exit 0/);
    });
  });

  describe('python gate (e2e)', () => {
    it('blocks staged python with sql injection', () => {
      writeFileSync(
        join(dir, 'db.py'),
        'def get_user(cursor, user_id):\n    cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")\n',
      );
      execaSync('git', ['add', 'db.py'], { cwd: dir });
      const res = run(dir, ['check', '--staged']);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(/injection/);
    });

    it('passes clean python', () => {
      writeFileSync(
        join(dir, 'db.py'),
        'def get_user(cursor, user_id):\n    cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))\n    return cursor.fetchone()\n',
      );
      execaSync('git', ['add', 'db.py'], { cwd: dir });
      expect(run(dir, ['check', '--staged']).exitCode).toBe(0);
    });
  });
});
