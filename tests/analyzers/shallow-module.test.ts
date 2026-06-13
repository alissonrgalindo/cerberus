import { describe, expect, it } from 'vitest';
import { analyzeShallowModule } from '../../src/analyzers/shallow-module.js';
import { inputFromSource } from '../helpers.js';

describe('shallow-module analyzer', () => {
  it('passes a function with real behavior', async () => {
    const src = `export function process(x: number) {
  if (x < 0) throw new Error('negative');
  return x * 2;
}`;
    const result = await analyzeShallowModule(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags a single-statement return-of-call', async () => {
    const src = `import { repo } from './repo';
export function getUserById(id: string) {
  return repo.findById(id);
}`;
    const result = await analyzeShallowModule(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].location).toMatch(/^getUserById:/);
  });

  it('flags an exported arrow that just delegates', async () => {
    const src = `import { repo } from './repo';
export const findUser = (id: string) => repo.findById(id);`;
    const result = await analyzeShallowModule(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0].location).toMatch(/^findUser:/);
  });

  it('passes the const-then-return pattern when there is also a guard', async () => {
    const src = `import { repo } from './repo';
export function getUserById(id: string) {
  if (!id) throw new Error('id required');
  const u = repo.findById(id);
  return u;
}`;
    const result = await analyzeShallowModule(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('ignores non-exported helpers', async () => {
    const src = `import { repo } from './repo';
function getUserById(id: string) { return repo.findById(id); }
export function caller(id: string) { return getUserById(id) + '!'; }`;
    const result = await analyzeShallowModule(inputFromSource('inline.ts', src));
    // caller is also a single-call return → still shallow. But getUserById isn't exported.
    expect(result.violations.every((v) => !v.location.startsWith('getUserById'))).toBe(true);
  });

  it('respects the suppression comment', async () => {
    const src = `import { repo } from './repo';
// quality-gate-allow: shallow-module
export function getUserById(id: string) {
  return repo.findById(id);
}`;
    const result = await analyzeShallowModule(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });
});
