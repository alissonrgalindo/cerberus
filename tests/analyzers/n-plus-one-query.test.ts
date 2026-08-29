import { describe, expect, it } from 'vitest';
import { analyzeNPlusOneQuery } from '../../src/analyzers/n-plus-one-query.js';
import { baselineWith, inputFromSource } from '../helpers.js';

describe('n-plus-one-query analyzer', () => {
  it('flags await db.* inside for-of', async () => {
    const src = `
import { db } from './db';
export async function load(ids: number[]) {
  for (const id of ids) {
    await db.query.users.findFirst({ where: { id } });
  }
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(1);
  });

  it('flags await context.db.* inside for-of', async () => {
    const src = `
export async function copy(targetId: string, formulas: Array<{id: string}>) {
  for (const formula of formulas) {
    await context.db.insert(groups).values({ id: formula.id });
  }
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(1);
    expect(result.violations[0].suggestion).toContain('await context.db.*');
  });

  it('flags await db.* inside .map(async ...)', async () => {
    const src = `
import { db } from './db';
export async function load(ids: number[]) {
  return Promise.all(ids.map(async (id) => {
    return await db.select().from(users).where(eq(users.id, id));
  }));
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(1);
  });

  it('flags await context.db.* inside .map(async ...)', async () => {
    const src = `
export async function load(ids: number[]) {
  return Promise.all(ids.map(async (id) =>
    await context.db.update(users).set({ active: true }).where(eq(users.id, id)),
  ));
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(1);
  });

  it('flags await tx.* inside .forEach(async ...)', async () => {
    const src = `
export async function fan(ids: number[], tx: any) {
  ids.forEach(async (id) => {
    await tx.update(items).set({ touched: true }).where(eq(items.id, id));
  });
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(false);
  });

  it('passes a single query outside any loop', async () => {
    const src = `
import { db } from './db';
export async function load(ids: number[]) {
  return db.query.users.findMany({ where: { id: { inArray: ids } } });
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes a context.db query outside any loop', async () => {
    const src = `
export async function load() {
  return await context.db.select().from(users);
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(true);
    expect(result.metrics.nPlusOneCount).toBe(0);
  });

  it('passes a loop that does not query the db', async () => {
    const src = `
export function sum(xs: number[]) {
  let n = 0;
  for (const x of xs) n += x;
  return n;
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags multiple findings inside the same loop', async () => {
    const src = `
import { db } from './db';
export async function load(ids: number[]) {
  for (const id of ids) {
    const a = await db.query.x.findFirst({ where: { id } });
    const b = await db.query.y.findFirst({ where: { id } });
    void a; void b;
  }
}`;
    const result = await analyzeNPlusOneQuery(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(2);
    expect(result.violations).toHaveLength(2);
  });

  it('passes when the N+1 count matches the baseline', async () => {
    const src = `
export async function load(ids: number[]) {
  for (const id of ids) {
    await db.query.users.findFirst({ where: { id } });
  }
}`;
    const result = await analyzeNPlusOneQuery(
      inputFromSource('lib/x.ts', src, {
        baseline: baselineWith({ nPlusOneQuery: { count: 1 } }),
      }),
    );
    expect(result.passed).toBe(true);
    expect(result.metrics.nPlusOneCount).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it('flags all findings when the N+1 count exceeds the baseline', async () => {
    const src = `
export async function load(ids: number[]) {
  for (const id of ids) {
    await db.query.users.findFirst({ where: { id } });
    await db.query.teams.findFirst({ where: { id } });
  }
}`;
    const result = await analyzeNPlusOneQuery(
      inputFromSource('lib/x.ts', src, {
        baseline: baselineWith({ nPlusOneQuery: { count: 1 } }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.metrics.nPlusOneCount).toBe(2);
    expect(result.violations).toHaveLength(2);
  });
});
