import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeSecretInDiff } from '../../src/analyzers/secret-in-diff.js';

describe('secret-in-diff analyzer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-secret-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when no staged files contain secrets', async () => {
    const f = join(dir, 'clean.ts');
    writeFileSync(f, `export const x = 1;`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out).toHaveLength(0);
  });

  it('flags an Anthropic API key', () => {
    const f = join(dir, 'config.ts');
    writeFileSync(f, `const key = 'sk-ant-abcdef0123456789abcdefghij';`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/Anthropic/);
  });

  it('flags a GitHub token', () => {
    const f = join(dir, 'config.ts');
    writeFileSync(f, `const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/GitHub/);
  });

  it('flags an AWS access key id', () => {
    const f = join(dir, 'aws.ts');
    writeFileSync(f, `const ak = 'AKIAIOSFODNN7EXAMPLE';`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/AWS/);
  });

  it('flags any staged .env file regardless of contents', () => {
    const f = join(dir, '.env');
    writeFileSync(f, `# nothing secret here`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBe(1);
    expect(out[0].violation.location).toMatch(/\.env:1$/);
  });

  it('allowlists .env.example', () => {
    const f = join(dir, '.env.example');
    writeFileSync(f, `API_KEY=replace-me`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out).toHaveLength(0);
  });

  it('flags a Stripe live key', () => {
    const f = join(dir, 'pay.ts');
    writeFileSync(f, `const k = 'sk_live_abcdefghij0123456789';`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/Stripe/);
  });

  it('flags an npm token', () => {
    const f = join(dir, '.npmrc-backup');
    writeFileSync(f, `//registry.npmjs.org/:_authToken=npm_${'a1'.repeat(18)}`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/npm/);
  });

  it('flags a PEM private key block', () => {
    const f = join(dir, 'key.pem.ts');
    writeFileSync(f, `const key = \`-----BEGIN RSA PRIVATE KEY-----\nMIIE...\`;`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/Private key/);
  });

  it('flags a connection string with real credentials', () => {
    const f = join(dir, 'db.ts');
    writeFileSync(f, `const url = 'postgres://admin:hunter2real@db.prod.internal:5432/app';`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].violation.suggestion).toMatch(/Connection string/);
  });

  it('ignores connection strings with placeholder passwords', () => {
    const f = join(dir, 'docs.ts');
    writeFileSync(
      f,
      `// postgres://user:password@localhost:5432/app
const a = 'postgres://user:<password>@localhost/app';
const b = \`postgres://user:\${process.env.DB_PASS}@localhost/app\`;
const c = 'mysql://root:changeme@localhost/app';`,
    );
    const out = analyzeSecretInDiff([f], dir);
    expect(out).toHaveLength(0);
  });

  it('marks pattern violations as security severity', () => {
    const f = join(dir, 'config.ts');
    writeFileSync(f, `const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';`);
    const out = analyzeSecretInDiff([f], dir);
    expect(out[0].violation.severity).toBe('security');
  });

  it('respects the suppression comment', () => {
    const f = join(dir, 'fixtures.ts');
    writeFileSync(
      f,
      `// fake-but-shaped fixture
export const FAKE_KEY = 'sk-ant-fixturefixturefixturefixture'; // quality-gate-allow: secret`,
    );
    const out = analyzeSecretInDiff([f], dir);
    expect(out).toHaveLength(0);
  });
});
