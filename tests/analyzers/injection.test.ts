import { describe, expect, it } from 'vitest';
import { analyzeInjection } from '../../src/analyzers/injection.js';
import { inputFromSource } from '../helpers.js';

describe('injection analyzer', () => {
  it('passes on clean code', async () => {
    const src = `export function f(x: number) { return x + 1; }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
    expect(result.metrics.injectionCount).toBe(0);
  });

  it('flags eval()', async () => {
    const src = `export function run(code: string) { return eval(code); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].severity).toBe('security');
    expect(result.violations[0].suggestion).toMatch(/Code injection/);
  });

  it('flags new Function()', async () => {
    const src = `export function run(body: string) { return new Function(body); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
  });

  it('flags exec() with an interpolated command', async () => {
    const src = `import { exec } from 'node:child_process';
export function ls(dir: string) { exec(\`ls -la \${dir}\`); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/Shell injection/);
  });

  it('flags execSync() with string concatenation', async () => {
    const src = `import { execSync } from 'node:child_process';
export function ls(dir: string) { execSync('ls -la ' + dir); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
  });

  it('passes exec() with a literal command', async () => {
    const src = `import { exec } from 'node:child_process';
export function ls() { exec('ls -la'); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags spawn() with { shell: true } and a dynamic command', async () => {
    const src = `import { spawn } from 'node:child_process';
export function run(cmd: string) { spawn(\`tool \${cmd}\`, { shell: true }); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
  });

  it('passes spawn() with array args and no shell', async () => {
    const src = `import { spawn } from 'node:child_process';
export function run(arg: string) { spawn('tool', [arg]); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags sql.raw() with a non-literal argument', async () => {
    const src = `import { sql } from 'drizzle-orm';
export function order(col: string) { return sql.raw(col); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/SQL injection/);
  });

  it('passes sql.raw() with a string literal', async () => {
    const src = `import { sql } from 'drizzle-orm';
export function order() { return sql.raw('created_at DESC'); }`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags db.execute() with an interpolated template literal', async () => {
    const src = `export async function find(db: any, id: string) {
  return db.execute(\`SELECT * FROM users WHERE id = '\${id}'\`);
}`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
  });

  it('passes db.execute() with a tagged template (parameterized)', async () => {
    const src = `import { sql } from 'drizzle-orm';
export async function find(db: any, id: string) {
  return db.execute(sql\`SELECT * FROM users WHERE id = \${id}\`);
}`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags client.query() with string concatenation', async () => {
    const src = `export async function find(client: any, table: string) {
  return client.query('SELECT * FROM ' + table);
}`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
  });

  it('flags dangerouslySetInnerHTML with unsanitized dynamic content', async () => {
    const src = `export function Bio({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}`;
    const result = await analyzeInjection(inputFromSource('inline.tsx', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].suggestion).toMatch(/XSS/);
  });

  it('passes dangerouslySetInnerHTML with sanitized content', async () => {
    const src = `import DOMPurify from 'dompurify';
export function Bio({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
}`;
    const result = await analyzeInjection(inputFromSource('inline.tsx', src));
    expect(result.passed).toBe(true);
  });

  it('passes dangerouslySetInnerHTML with a static string', async () => {
    const src = `export function Legal() {
  return <div dangerouslySetInnerHTML={{ __html: '<b>&copy; 2026</b>' }} />;
}`;
    const result = await analyzeInjection(inputFromSource('inline.tsx', src));
    expect(result.passed).toBe(true);
  });

  it('respects the suppression comment', async () => {
    const src = `export function run(code: string) {
  return eval(code); // quality-gate-allow: injection
}`;
    const result = await analyzeInjection(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });
});
