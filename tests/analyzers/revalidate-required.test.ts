import { describe, expect, it } from 'vitest';
import { analyzeRevalidateRequired } from '../../src/analyzers/revalidate-required.js';
import { inputFromSource } from '../helpers.js';

const USE_SERVER = `'use server'\n`;

describe('revalidate-required analyzer', () => {
  it('ignores files without the use server directive', async () => {
    const src = `
import { db } from './db';
export async function update() {
  await db.update(t).set({});
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('lib/x.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags an exported action that mutates but never revalidates', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function rename(formData: FormData) {
  await db.update(users).set({ name: 'x' });
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.location).toContain('rename');
  });

  it('passes when the action calls revalidatePath', async () => {
    const src = `${USE_SERVER}
import { revalidatePath } from 'next/cache';
import { db } from './db';
export async function rename() {
  await db.update(users).set({ name: 'x' });
  revalidatePath('/users');
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes when the action calls revalidateTag', async () => {
    const src = `${USE_SERVER}
import { revalidateTag } from 'next/cache';
import { db } from './db';
export async function rename() {
  await db.update(users).set({ name: 'x' });
  revalidateTag('users');
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes when the action redirects (implicit invalidation)', async () => {
    const src = `${USE_SERVER}
import { redirect } from 'next/navigation';
import { db } from './db';
export async function rename() {
  await db.update(users).set({ name: 'x' });
  redirect('/users');
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });

  it('passes when an exported arrow action revalidates', async () => {
    const src = `${USE_SERVER}
import { revalidatePath } from 'next/cache';
import { db } from './db';
export const rename = async () => {
  await db.update(users).set({ name: 'x' });
  revalidatePath('/users');
};`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });

  it('ignores non-mutating actions', async () => {
    const src = `${USE_SERVER}
import { db } from './db';
export async function getUser() {
  return db.query.users.findFirst({});
}`;
    const result = await analyzeRevalidateRequired(inputFromSource('actions.ts', src));
    expect(result.passed).toBe(true);
  });
});
