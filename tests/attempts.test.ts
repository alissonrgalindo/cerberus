import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashFileSet, incrementAttempt, peekAttempt } from '../src/attempts.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qg-att-'));
}

describe('attempts tracker', () => {
  it('produces an order-independent hash for a file set', () => {
    expect(hashFileSet(['a.ts', 'b.ts'])).toBe(hashFileSet(['b.ts', 'a.ts']));
    expect(hashFileSet(['a.ts'])).not.toBe(hashFileSet(['b.ts']));
  });

  it('increments and peeks the counter', () => {
    const dir = tempDir();
    const h = hashFileSet(['x.ts']);
    const t0 = 1_000_000;
    expect(incrementAttempt(dir, h, t0).count).toBe(1);
    expect(incrementAttempt(dir, h, t0 + 1000).count).toBe(2);
    expect(peekAttempt(dir, h, t0 + 2000)).toBe(2);
  });

  it('prunes entries older than the 30min TTL', () => {
    const dir = tempDir();
    const h = hashFileSet(['x.ts']);
    const t0 = 1_000_000;
    incrementAttempt(dir, h, t0);
    incrementAttempt(dir, h, t0 + 60_000); // count 2
    // 31 minutes later the original entry expired -> counter restarts
    expect(incrementAttempt(dir, h, t0 + 31 * 60_000).count).toBe(1);
  });
});
