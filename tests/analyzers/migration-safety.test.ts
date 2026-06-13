import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeMigrationSafety } from '../../src/analyzers/migration-safety.js';

describe('migration-safety analyzer', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'qg-migsafe-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function write(name: string, sql: string): string {
    const abs = join(cwd, name);
    writeFileSync(abs, sql);
    return abs;
  }

  it('returns nothing when no sql files are given', () => {
    const result = analyzeMigrationSafety([], cwd);
    expect(result).toEqual([]);
  });

  it('flags DROP COLUMN', () => {
    const f = write('0001.sql', 'ALTER TABLE users DROP COLUMN nickname;');
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation.suggestion).toContain('DROP COLUMN users.nickname');
  });

  it('flags DROP TABLE', () => {
    const f = write('0001.sql', 'DROP TABLE IF EXISTS legacy_audit;');
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation.suggestion).toContain('DROP TABLE legacy_audit');
  });

  it('flags RENAME COLUMN', () => {
    const f = write('0001.sql', 'ALTER TABLE users RENAME COLUMN email TO email_address;');
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation.suggestion).toContain('email → email_address');
  });

  it('flags ALTER COLUMN TYPE', () => {
    const f = write('0001.sql', 'ALTER TABLE users ALTER COLUMN age TYPE bigint;');
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation.suggestion).toContain('ALTER COLUMN TYPE');
  });

  it('flags SET NOT NULL without a DEFAULT in the same statement', () => {
    const f = write(
      '0001.sql',
      'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    );
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.violation.suggestion).toContain('SET NOT NULL');
  });

  it('passes SET NOT NULL when the same statement provides a DEFAULT', () => {
    const f = write(
      '0001.sql',
      `ALTER TABLE users
         ALTER COLUMN email SET DEFAULT '',
         ALTER COLUMN email SET NOT NULL;`,
    );
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(0);
  });

  it('passes safe additive migrations', () => {
    const f = write(
      '0001.sql',
      `CREATE TABLE settings (id serial primary key, value text);
       ALTER TABLE users ADD COLUMN nickname text;`,
    );
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(0);
  });

  it('ignores hits inside SQL comments', () => {
    const f = write(
      '0001.sql',
      `-- this used to DROP COLUMN nickname but we backed it out
       ALTER TABLE users ADD COLUMN nickname text;`,
    );
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(0);
  });

  it('aggregates multiple violations across one file', () => {
    const f = write(
      '0001.sql',
      `ALTER TABLE users DROP COLUMN a;
       ALTER TABLE users RENAME COLUMN b TO c;`,
    );
    const result = analyzeMigrationSafety([f], cwd);
    expect(result).toHaveLength(2);
  });
});
