import { execaSync } from 'execa';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

function run(cwd: string, args: string[]) {
  return execaSync('node', [CLI, ...args], { cwd, reject: false });
}
function git(cwd: string, args: string[]): void {
  execaSync('git', args, { cwd });
}
function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@test.dev']);
  git(dir, ['config', 'user.name', 'test']);
}

const ANY_FILE = 'export function f(x: any): any { return x; }\n';
const SECRET_FILE = `export const k = 'sk-ant-leakedleakedleakedleakedleaked';\n`;

describe('config.ignore is honored by the gate (e2e)', () => {
  let dir: string;

  beforeAll(() => {
    if (!existsSync(CLI)) execaSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT });
  }, 120_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-ign-'));
    initRepo(dir);
    writeFileSync(join(dir, '.cerberus.json'), JSON.stringify({ ignore: ['**/*.skip.ts'] }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips QUALITY violations in an ignored file', () => {
    // Control: the same content in a non-ignored file fails the gate.
    writeFileSync(join(dir, 'gated.ts'), ANY_FILE);
    git(dir, ['add', 'gated.ts']);
    expect(run(dir, ['check', '--staged', '--mode', 'pre-commit']).exitCode).toBe(1);

    // The ignored file passes despite the same quality violations.
    git(dir, ['rm', '--cached', '-q', 'gated.ts']);
    writeFileSync(join(dir, 'thing.skip.ts'), ANY_FILE);
    git(dir, ['add', 'thing.skip.ts']);
    expect(run(dir, ['check', '--staged', '--mode', 'pre-commit']).exitCode).toBe(0);
  });

  it('still enforces the SECURITY tier in an ignored file', () => {
    // ignore is a quality knob — a secret in an ignored file is still blocked,
    // so an agent can't silence the secret scanner by widening `ignore`.
    writeFileSync(join(dir, 'leak.skip.ts'), SECRET_FILE);
    git(dir, ['add', 'leak.skip.ts']);
    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/secret-in-diff/);
  });
});
