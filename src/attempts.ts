import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ATTEMPTS_FILE = '.quality-gate-attempts.json';
const TTL_MS = 30 * 60 * 1000; // 30 minutes

type AttemptEntry = { count: number; firstAt: number };
type Store = Record<string, AttemptEntry>;

/** Stable key for a set of files (order-independent). */
export function hashFileSet(files: string[]): string {
  return createHash('sha256')
    .update([...files].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function load(cwd: string): Store {
  const path = join(cwd, ATTEMPTS_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function save(cwd: string, store: Store): void {
  writeFileSync(join(cwd, ATTEMPTS_FILE), `${JSON.stringify(store, null, 2)}\n`);
}

function prune(store: Store, now: number): Store {
  const out: Store = {};
  for (const [key, entry] of Object.entries(store)) {
    if (now - entry.firstAt < TTL_MS) out[key] = entry;
  }
  return out;
}

/** Increments (or starts) the attempt counter for a file set, pruning expired entries. */
export function incrementAttempt(cwd: string, hash: string, now: number = Date.now()): { count: number } {
  const store = prune(load(cwd), now);
  const entry = store[hash] ?? { count: 0, firstAt: now };
  entry.count += 1;
  store[hash] = entry;
  save(cwd, store);
  return { count: entry.count };
}

/** Reads the current attempt count without mutating it. */
export function peekAttempt(cwd: string, hash: string, now: number = Date.now()): number {
  return prune(load(cwd), now)[hash]?.count ?? 0;
}
