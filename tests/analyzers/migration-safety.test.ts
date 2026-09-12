import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    mkdirSync(dirname(abs), { recursive: true });
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

  it('passes SET NOT NULL after an earlier ordered migration backfills every NULL', () => {
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = '00000000-0000-0000-0000-000000000001' WHERE municipality_id IS NULL;");
    expect(analyzeMigrationSafety([constraint, backfill], cwd)).toHaveLength(0);
  });

  it('passes multiple Drizzle backfills separated by statement markers', () => {
    const schema = write('0001_schema.sql', 'ALTER TABLE authorized_users ADD COLUMN municipality_id uuid;');
    const backfill = write('0002_backfill.sql', [
      `INSERT INTO "municipalities" ("id") SELECT '00000000-0000-0000-0000-000000000001' WHERE EXISTS (SELECT 1 FROM "authorized_users");--> statement-breakpoint`,
      `UPDATE "authorized_users" SET "municipality_id" = '00000000-0000-0000-0000-000000000001' WHERE "municipality_id" IS NULL;--> statement-breakpoint`,
      `UPDATE "fiscal_imports" SET "municipality_id" = '00000000-0000-0000-0000-000000000001' WHERE "municipality_id" IS NULL;--> statement-breakpoint`,
      `UPDATE "fiscal_records" SET "municipality_id" = '00000000-0000-0000-0000-000000000001' WHERE "municipality_id" IS NULL;--> statement-breakpoint`,
    ].join('\n'));
    const constraint = write('0003_constraints.sql', [
      'ALTER TABLE authorized_users ALTER COLUMN municipality_id SET NOT NULL;',
      'ALTER TABLE fiscal_imports ALTER COLUMN municipality_id SET NOT NULL;',
      'ALTER TABLE fiscal_records ALTER COLUMN municipality_id SET NOT NULL;',
      'ALTER TABLE authorized_users ADD CONSTRAINT owner_fk FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON UPDATE no action;',
    ].join('\n'));
    expect(analyzeMigrationSafety([schema, backfill, constraint], cwd)).toHaveLength(0);
  });

  it('still flags SET NOT NULL when the earlier update does not cover NULL rows', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = '00000000-0000-0000-0000-000000000001' WHERE status IS NULL;");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('still flags SET NOT NULL after assigning NULL again', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL;");
    const nullable = write('0002.sql', 'UPDATE users SET municipality_id = NULL;');
    const constraint = write('0003.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([constraint, backfill, nullable], cwd)).toHaveLength(1);
  });

  it('still flags when the backfill migration later assigns NULL', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL; UPDATE users SET municipality_id = NULL;");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('still flags when the backfill migration later inserts into the table', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL; INSERT INTO users (name) VALUES ('new');");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('still flags SET NOT NULL after any later write to the table', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL;");
    const laterWrite = write('0002.sql', "UPDATE users SET display_name = 'Configured';");
    const constraint = write('0003.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([constraint, backfill, laterWrite], cwd)).toHaveLength(1);
  });

  it('still flags after a later unquoted uppercase write', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL;");
    const nullable = write('0002.sql', 'UPDATE USERS SET municipality_id = NULL;');
    const constraint = write('0003.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, nullable, constraint], cwd)).toHaveLength(1);
  });

  it('does not prove a migration containing a schema-qualified write', () => {
    const backfill = write('0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL; UPDATE public.users SET municipality_id = NULL;");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('still flags SET NOT NULL when a prior update assigns NULL', () => {
    const backfill = write('0001.sql', 'UPDATE users SET municipality_id = NULL WHERE municipality_id IS NULL;');
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('does not use a backfill from another migration directory', () => {
    const backfill = write('a/0001.sql', "UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL;");
    const constraint = write('b/0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('does not treat a block-commented update as a backfill', () => {
    const comment = write('0001.sql', "/* UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL; */");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([comment, constraint], cwd)).toHaveLength(1);
  });

  it('does not treat an update inside dollar-quoted SQL as a backfill', () => {
    const fake = write('0001.sql', "SELECT $$UPDATE users SET municipality_id = 'configured' WHERE municipality_id IS NULL;$$;");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([fake, constraint], cwd)).toHaveLength(1);
  });

  it('does not equate differently cased identifiers', () => {
    const backfill = write('0001.sql', `UPDATE "Users" SET "municipality_id" = 'configured' WHERE "municipality_id" IS NULL;`);
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([backfill, constraint], cwd)).toHaveLength(1);
  });

  it('does not prove a backfill from a statement split inside a string', () => {
    const fake = write('0001.sql', "SELECT 'prefix; UPDATE users SET municipality_id = ''configured'' WHERE municipality_id IS NULL;';");
    const constraint = write('0002.sql', 'ALTER TABLE users ALTER COLUMN municipality_id SET NOT NULL;');
    expect(analyzeMigrationSafety([fake, constraint], cwd)).toHaveLength(1);
  });

  it('preserves line numbers after stripping block comments', () => {
    const f = write('0001.sql', '/* first\nsecond */\nALTER TABLE users ALTER COLUMN email SET NOT NULL;');
    expect(analyzeMigrationSafety([f], cwd)[0]!.violation.location).toBe('0001.sql:3');
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
