import { execaSync } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const NEW_BAD_JS = `export function deep(x, raw) {
  const v = raw;
  if (x > 0) { if (x > 1) { if (x > 2) { if (x > 3) { if (x > 4) { if (x > 5) { return x; } } } } } }
  return v;
}
`;

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qg-cli-'));
  writeFileSync(
    join(dir, '.quality-gate.json'),
    JSON.stringify({
      extends: '@quality-gate/nextjs',
      preCommit: { enabled: ['cognitive', 'cyclomatic', 'type-safety'] },
    }),
  );
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
    expect(existsSync(join(dir, '.cerberus-baseline.json'))).toBe(true);
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

  it('check --file flags a high-complexity .js file (JavaScript support)', () => {
    const dir = makeProject();
    run(dir, ['baseline']); // baselines only clean.ts; bad.js is unseen
    writeFileSync(join(dir, 'src', 'bad.js'), NEW_BAD_JS);
    const res = run(dir, ['check', '--file', 'src/bad.js', '--format', 'json']);
    expect(res.exitCode).toBe(1);
    const parsed = JSON.parse(res.stdout);
    const analyzers = new Set(parsed.files[0].violations.map((v: { analyzer: string }) => v.analyzer));
    expect(analyzers.has('cognitive-complexity')).toBe(true);
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

  // ---- Gap 1 + Gap 3 + Gap 4: doctor lists drifted, detects Husky, --format json ----

  it('doctor lists drifted files (not just the count)', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    // mutate a baselined file → drift
    writeFileSync(join(dir, 'src', 'clean.ts'), CLEAN + '\nexport const x = 1;\n');
    const res = run(dir, ['doctor']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/1 file\(s\) drifted/);
    expect(res.stdout).toContain('src/clean.ts'); // the actual file is named
  });

  it('doctor --format json emits machine-readable state', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'clean.ts'), CLEAN + '\nexport const x = 1;\n');
    const res = run(dir, ['doctor', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.baseline.drifted).toBe(1);
    expect(parsed.drifted[0].file).toBe('src/clean.ts');
    expect(parsed.drifted[0]).toHaveProperty('direction');
    expect(parsed.drifted[0]).toHaveProperty('deltas');
    expect(parsed.hook).toHaveProperty('kind');
  });

  // ---- Gap 2: drift command ----

  it('drift exits 0 with no drift when clean', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    const res = run(dir, ['drift']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/no drift/);
  });

  it('drift --format json lists drifted with deltas', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'clean.ts'), CLEAN + '\nexport const x = 1;\n');
    const res = run(dir, ['drift', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.count).toBe(1);
    expect(parsed.drifted[0]).toHaveProperty('baseline');
    expect(parsed.drifted[0]).toHaveProperty('current');
    expect(parsed.drifted[0]).toHaveProperty('deltas');
  });

  // ---- Gap 4 (audit): --format json ----

  it('audit --format json returns rows', () => {
    const dir = makeProject();
    writeFileSync(join(dir, 'src', 'newbad.tsx'), NEW_BAD);
    const res = run(dir, ['audit', '--top', '5', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scanned).toBeGreaterThan(0);
    expect(Array.isArray(parsed.rows)).toBe(true);
  });

  // ---- Gap 5: refresh-baseline in batch ----

  it('refresh-baseline accepts multiple --file flags', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'a.ts'), CLEAN);
    writeFileSync(join(dir, 'src', 'b.ts'), CLEAN);
    // baseline is stale for a/b (they were created after baseline) — but refresh-baseline
    // accepts any file path, so this exercises the variadic plumbing.
    const res = run(dir, [
      'refresh-baseline',
      '--file',
      'src/a.ts',
      '--file',
      'src/b.ts',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/2 file\(s\) updated/);
    const baseline = JSON.parse(
      readFileSync(join(dir, '.cerberus-baseline.json'), 'utf8'),
    );
    expect(baseline.files['src/a.ts']).toBeDefined();
    expect(baseline.files['src/b.ts']).toBeDefined();
  });

  it('refresh-baseline --all-drifted refreshes only drifted files', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'clean.ts'), CLEAN + '\nexport const x = 1;\n');
    const before = JSON.parse(
      readFileSync(join(dir, '.cerberus-baseline.json'), 'utf8'),
    );
    const res = run(dir, ['refresh-baseline', '--all-drifted']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/1 file\(s\) updated/);
    const after = JSON.parse(
      readFileSync(join(dir, '.cerberus-baseline.json'), 'utf8'),
    );
    expect(after.files['src/clean.ts'].fileHash).not.toBe(
      before.files['src/clean.ts'].fileHash,
    );
  });

  it('refresh-baseline --all-drifted is a no-op on clean tree', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    const res = run(dir, ['refresh-baseline', '--all-drifted']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/no drift/);
  });

  it('refresh-baseline --stdin reads newline-separated paths', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    writeFileSync(join(dir, 'src', 'fromstdin.ts'), CLEAN);
    const res = execaSync('node', [CLI, 'refresh-baseline', '--stdin'], {
      cwd: dir,
      reject: false,
      input: 'src/fromstdin.ts\n',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/1 file\(s\) updated/);
  });

  // ---- Gap 6: install-hooks idempotent + dry-run ----

  it('install-hooks --dry-run does not write anything', () => {
    const dir = makeProject();
    execaSync('git', ['init', '-q'], { cwd: dir });
    const before = existsSync(join(dir, '.git', 'hooks', 'pre-commit'));
    const res = run(dir, ['install-hooks', '--dry-run']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/dry-run/);
    const after = existsSync(join(dir, '.git', 'hooks', 'pre-commit'));
    expect(after).toBe(before);
  });

  it('install-hooks is idempotent when already wired', () => {
    const dir = makeProject();
    execaSync('git', ['init', '-q'], { cwd: dir });
    const first = run(dir, ['install-hooks']);
    expect(first.exitCode).toBe(0);
    const second = run(dir, ['install-hooks']);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/already installed/);
  });

  // ---- Gap 7: diff ----

  it('diff returns empty files: [] on clean tree (JSON)', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    const res = run(dir, ['diff', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.files).toEqual([]);
  });

  it('diff surfaces per-function deltas after editing', () => {
    const dir = makeProject();
    run(dir, ['baseline']);
    // Add a new function with measurable complexity to the baselined file.
    writeFileSync(
      join(dir, 'src', 'clean.ts'),
      CLEAN +
        '\nexport function harder(x: number): number {\n  if (x>0) { if (x>1) { if (x>2) return x; } }\n  return 0;\n}\n',
    );
    const res = run(dir, ['diff', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0].file).toBe('src/clean.ts');
    const fns = parsed.files[0].functions.map((f: { name: string }) => f.name);
    expect(fns).toContain('harder');
  });
});
