import { execaSync } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeNewDependency } from '../../src/analyzers/new-dependency.js';

function git(cwd: string, args: string[]): void {
  execaSync('git', args, { cwd });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@test.dev']);
  git(dir, ['config', 'user.name', 'test']);
}

function commitAll(dir: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
}

describe('new-dependency analyzer (slopsquatting guard)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-newdep-'));
    initRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores staged sets without a package.json', () => {
    const f = join(dir, 'index.ts');
    writeFileSync(f, 'export const x = 1;');
    expect(analyzeNewDependency([f], dir)).toHaveLength(0);
  });

  it('passes when the new dependency has a lockfile entry', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: {} }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages: {}\n');
    commitAll(dir);

    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: { zod: '^3.0.0' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "packages:\n  '/zod@3.23.8':\n    resolution: {}\n");
    expect(analyzeNewDependency([pkg], dir)).toHaveLength(0);
  });

  it('flags a new dependency with no lockfile entry', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: {} }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages: {}\n');
    commitAll(dir);

    writeFileSync(
      pkg,
      JSON.stringify({ name: 'app', dependencies: { 'lodash-extra-utils': '^1.0.0' } }),
    );
    const out = analyzeNewDependency([pkg], dir);
    expect(out).toHaveLength(1);
    expect(out[0].violation.analyzer).toBe('new-dependency');
    expect(out[0].violation.severity).toBe('security');
    expect(out[0].violation.suggestion).toMatch(/lodash-extra-utils/);
  });

  it('does not flag dependencies that were already committed', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: { left: '1.0.0' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages: {}\n');
    commitAll(dir);

    // left is pre-existing (not new) even though the lockfile is empty.
    writeFileSync(
      pkg,
      JSON.stringify({ name: 'app', dependencies: { left: '1.0.0' }, devDependencies: {} }),
    );
    expect(analyzeNewDependency([pkg], dir)).toHaveLength(0);
  });

  it('stays quiet when the project has no lockfile at all', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: {} }));
    commitAll(dir);

    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: { 'made-up-pkg': '^1.0.0' } }));
    expect(analyzeNewDependency([pkg], dir)).toHaveLength(0);
  });

  it('treats every dep in a brand-new package.json as new', () => {
    writeFileSync(join(dir, 'README.md'), '# app');
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {} }));
    commitAll(dir);

    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: { 'ghost-pkg': '^2.0.0' } }));
    const out = analyzeNewDependency([pkg], dir);
    expect(out).toHaveLength(1);
    expect(out[0].violation.suggestion).toMatch(/ghost-pkg/);
  });

  it('recognizes scoped packages in package-lock.json', () => {
    const pkg = join(dir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: {} }));
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/@scope/pkg': { version: '1.0.0' } } }),
    );
    commitAll(dir);

    writeFileSync(pkg, JSON.stringify({ name: 'app', dependencies: { '@scope/pkg': '^1.0.0' } }));
    expect(analyzeNewDependency([pkg], dir)).toHaveLength(0);
  });
});
