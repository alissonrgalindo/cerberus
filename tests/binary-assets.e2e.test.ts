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

// Assembled at runtime so this test file doesn't itself trip secret-in-diff
// when Cerberus scans its own repo.
const FAKE_ANTHROPIC_KEY = `sk-ant-${'leaked'.repeat(6)}`;

// A design file (Pencil .pen — large committed JSON) that happens to contain a
// token-shaped string. It is an artifact, not source: the security tier must
// not scan it.
const PEN_WITH_TOKEN = JSON.stringify({
  version: '2.13',
  children: [{ type: 'text', value: `apiKey: ${FAKE_ANTHROPIC_KEY}` }],
});

const TS_WITH_TOKEN = `export const config = { apiKey: '${FAKE_ANTHROPIC_KEY}' };\n`;

describe('binaryAssets skip (e2e)', () => {
  let dir: string;

  beforeAll(() => {
    if (!existsSync(CLI)) {
      execaSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT });
    }
  }, 120_000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-bin-'));
    initRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT scan a .pen design file for secrets (skipped by default)', () => {
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({}));
    writeFileSync(join(dir, 'design.pen'), PEN_WITH_TOKEN);
    git(dir, ['add', 'design.pen']);

    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(0);
    expect(res.stderr + res.stdout).not.toMatch(/secret-in-diff/);
  });

  it('still flags the same token in a .ts source file', () => {
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({}));
    writeFileSync(join(dir, 'leak.ts'), TS_WITH_TOKEN);
    git(dir, ['add', 'leak.ts']);

    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/secret-in-diff/);
  });

  it('a user-registered asset extension is skipped too (config UNIONs onto defaults)', () => {
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({ binaryAssets: ['**/*.blob'] }));
    writeFileSync(join(dir, 'data.blob'), `token=${FAKE_ANTHROPIC_KEY}`);
    git(dir, ['add', 'data.blob']);

    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(0);
  });

  it('env files are never exemptable, even if listed under binaryAssets', () => {
    // `.env` is extension-shaped so the guard would honor it — but the env-file
    // scan runs unconditionally, so a committed `.env` is still flagged.
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({ binaryAssets: ['.env'] }));
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://u:p@host/db # cerberus-allow: secret\n');
    git(dir, ['add', '-A']);

    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/secret-in-diff/);
  });

  it('cannot be widened into a hole: binaryAssets ["**/*"] is rejected, secret still caught', () => {
    // The guard drops any non-extension glob, so an agent can't add `**/*` to
    // binaryAssets to silence the (non-bypassable) secret scanner.
    writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({ binaryAssets: ['**/*'] }));
    writeFileSync(join(dir, 'leak.ts'), TS_WITH_TOKEN);
    git(dir, ['add', '-A']);

    const res = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/secret-in-diff/);
    expect(res.stderr).toMatch(/ignoring binaryAssets entry/);
  });
});
