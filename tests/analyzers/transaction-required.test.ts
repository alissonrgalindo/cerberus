import { describe, expect, it } from 'vitest';
import { analyzeTransactionRequired } from '../../src/analyzers/transaction-required.js';
import { inputFromSource } from '../helpers.js';

const USE_SERVER = `'use server'\n`;

describe('transaction-required analyzer', () => {
  it('ignores files without the use server directive', async () => {
    const src = `
import { db } from './db';
export async function multi() {
  await db.insert(a).values({});
  await db.update(b).set({});
}`;
    const result = await analyzeTransactionRequired(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes when an action does a single mutation', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function createOne() {
  await db.insert(users).values({ name: 'a' });
}`;
    const result = await analyzeTransactionRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags 2+ raw mutations in a use server function', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function moveAndLog() {
  await db.insert(audit).values({});
  await db.update(items).set({ moved: true });
}`;
    const result = await analyzeTransactionRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.location).toContain('moveAndLog');
    expect(result.violations[0]?.current).toBe(2);
  });

  it('passes when mutations are wrapped in db.transaction', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function moveAndLog() {
  await db.transaction(async (tx) => {
    await tx.insert(audit).values({});
    await tx.update(items).set({ moved: true });
  });
}`;
    const result = await analyzeTransactionRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes when the surrounding function itself is inside .transaction(...)', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function outer() {
  return db.transaction(async (tx) => {
    async function inner() {
      await tx.insert(a).values({});
      await tx.update(b).set({});
    }
    await inner();
  });
}`;
    const result = await analyzeTransactionRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });
});
