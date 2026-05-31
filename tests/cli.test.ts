import { execaSync } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

function run(cwd: string, args: string[]) {
  return execaSync('node', [CLI, ...args], { cwd, reject: false });
}

const CLEAN = `export function add(a: number, b: number): number {
  return a + b;
}
`;
const NEW_BAD = `export function deep(x: number, raw: unknown): any {
  const v = raw as unknown as number;
  if (x > 0) { if (x > 1) { if (x > 2) { if (x > 3) { if (x > 4) { if (x > 5) { return x; } } } } } }
  return v;
}
`;

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qg-cli-'));
  writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify({ extends: '@quality-gate/nextjs' }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'clean.ts'), CLEAN);
  return dir;
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    execaSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT });
  }
}, 120_000);

describe('quality-gate CLI (e2e)', () => {
  it('baseline writes a valid baseline file', () => {
    const dir = makeProject();
    const res = run(dir, ['baseline']);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(dir, '.quality-gate-baseline.json'))).toBe(true);
  });

  it('check --file on a clean file exits 0', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    const res = run(dir, ['check', '--file', 'src/clean.ts']);
    expect(res.exitCode).toBe(0);
  });

  it('check --file on a new file with violations exits 1 with JSON', () => {
    const dir = makeProject();
    run(dir, ['baseline']); // baselines only clean.ts; newbad is unseen
    writeFileSync(join(dir, 'src', 'newbad.tsx'), NEW_BAD);
    const res = run(dir, ['check', '--file', 'src/newbad.tsx', '--format', 'json']);
    expect(res.exitCode).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe('QUALITY_GATE_FAIL');
    const analyzers = new Set(parsed.files[0].violations.map((v: { analyzer: string }) => v.analyzer));
    expect(analyzers.has('cognitive-complexity')).toBe(true);
    expect(analyzers.has('type-safety')).toBe(true);
  });

  it('audit lists scanned files', () => {
    const dir = makeProject();
    writeFileSync(join(dir, 'src', 'newbad.tsx'), NEW_BAD);
    const res = run(dir, ['audit', '--top', '5']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('src/newbad.tsx');
    expect(res.stdout).toMatch(/Top \d+ files by complexity/);
  });

  it('doctor exits 0 and reports baseline state', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    const res = run(dir, ['doctor']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('quality-gate doctor');
  });

  it('anti-doom-loop: 3rd staged pre-commit attempt passes with debt', () => {
    const dir = makeProject();
    execaSync('git', ['init', '-q'], { cwd: dir });
    execaSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execaSync('git', ['config', 'user.name', 't'], { cwd: dir });
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'newbad.tsx'), NEW_BAD);
    execaSync('git', ['add', 'src/newbad.tsx'], { cwd: dir });

    const a1 = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    const a2 = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    const a3 = run(dir, ['check', '--staged', '--mode', 'pre-commit']);
    expect(a1.exitCode).toBe(1);
    expect(a2.exitCode).toBe(1);
    expect(a3.exitCode).toBe(0);
    expect(a3.stderr).toMatch(/letting the commit through/);
  });

  it('QUALITY_GATE_BYPASS=1 skips the gate', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'newbad.tsx'), NEW_BAD);
    const res = execaSync('node', [CLI, 'check', '--file', 'src/newbad.tsx'], {
      cwd: dir,
      reject: false,
      env: { QUALITY_GATE_BYPASS: '1' },
    });
    expect(res.exitCode).toBe(0);
  });
});
