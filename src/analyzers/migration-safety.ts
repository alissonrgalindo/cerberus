import { readFileSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { toPosix } from '../files.js';
import type { SetViolation, Violation } from '../types.js';

/**
 * Inspects newly added migration SQL for operations that break readers
 * deployed against the previous schema (DDIA ch.4 — schema evolution).
 * Pre-commit is the right place to catch these because once merged the
 * migration runs on prod and you can't un-rename a column.
 *
 * Blocked operations:
 *   - DROP COLUMN ............ destroys data, breaks any code still reading it
 *   - DROP TABLE ............. same, at the table level
 *   - RENAME COLUMN .......... breaks every reader/writer until redeploy
 *   - RENAME TABLE ........... same
 *   - ALTER COLUMN ... SET NOT NULL  (without a DEFAULT) — fails on any existing NULL
 *   - ALTER COLUMN ... TYPE ............ implicit cast can corrupt or fail
 *
 * The SQL parser is intentionally a series of focused regexes. Drizzle
 * generates a predictable subset of SQL; we don't need a full parser.
 */
const SQL_EXT = /\.sql$/i;
const LOWERCASE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

type Pattern = {
  id: string;
  regex: RegExp;
  describe: (m: RegExpMatchArray) => string;
  suggestion: string;
};

const PATTERNS: Pattern[] = [
  {
    id: 'drop-column',
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    describe: (m) => `DROP COLUMN ${m[1]}.${m[2]}`,
    suggestion:
      'Dropping a column is irreversible and breaks any deployed code still reading it. Run a two-step: (1) stop writing/reading the column and deploy, (2) drop the column in a later migration.',
  },
  {
    id: 'drop-table',
    regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    describe: (m) => `DROP TABLE ${m[1]}`,
    suggestion:
      'Dropping a table is irreversible. Confirm no service reads it, archive the data, and consider RENAME-then-DROP across two deploys.',
  },
  {
    id: 'rename-column',
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+RENAME\s+(?:COLUMN\s+)?["'`]?(\w+)["'`]?\s+TO\s+["'`]?(\w+)["'`]?/gi,
    describe: (m) => `RENAME COLUMN ${m[1]}.${m[2]} → ${m[3]}`,
    suggestion:
      'Renaming a column breaks every reader until redeploy. Add the new column, dual-write, migrate readers, then drop the old one.',
  },
  {
    id: 'rename-table',
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+RENAME\s+TO\s+["'`]?(\w+)["'`]?/gi,
    describe: (m) => `RENAME TABLE ${m[1]} → ${m[2]}`,
    suggestion:
      'Renaming a table breaks every reader until redeploy. Create a view aliasing the old name during the transition, or use a two-step deploy.',
  },
  {
    id: 'alter-type',
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+ALTER\s+COLUMN\s+["'`]?(\w+)["'`]?\s+(?:SET\s+DATA\s+)?TYPE\s+/gi,
    describe: (m) => `ALTER COLUMN TYPE ${m[1]}.${m[2]}`,
    suggestion:
      'Changing a column type can fail mid-flight on incompatible values and may rewrite the whole table. Add a new typed column and backfill.',
  },
];

/**
 * SET NOT NULL needs its own logic: it's only unsafe when there is no
 * DEFAULT in the same statement (otherwise existing NULLs get the default).
 * We match the statement and then check for a `DEFAULT` clause nearby.
 */
const SET_NOT_NULL_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+ALTER\s+COLUMN\s+["'`]?(\w+)["'`]?\s+SET\s+NOT\s+NULL/gi;
const NULL_BACKFILL_RE =
  /^UPDATE\s+["'`]?(\w+)["'`]?\s+SET\s+["'`]?(\w+)["'`]?\s*=\s*(?:'[^']+'|[-+]?\d+(?:\.\d+)?|TRUE|FALSE)\s+WHERE\s+["'`]?(\w+)["'`]?\s+IS\s+NULL\s*;$/i;
const TABLE_WRITE_RE = /(?:^|;)\s*(?:UPDATE|INSERT\s+INTO)\s+["'`]?(\w+)["'`]?/gi;

function migrationOrder(file: string, cwd: string): { directory: string; sequence: number } | null {
  const rel = toPosix(relative(cwd, file));
  const match = /^(\d+)/.exec(basename(rel));
  return match ? { directory: dirname(rel), sequence: Number(match[1]) } : null;
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).replace(/--.*$/gm, '');
}

type MigrationOrder = NonNullable<ReturnType<typeof migrationOrder>>;

function collectTableWrites(
  sql: string,
  order: MigrationOrder | null,
  priorBackfills: Map<string, number>,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!order) return counts;
  TABLE_WRITE_RE.lastIndex = 0;
  let write: RegExpExecArray | null;
  while ((write = TABLE_WRITE_RE.exec(sql)) !== null) {
    priorBackfills.clear();
    const table = write[1]!.toLowerCase();
    counts.set(table, (counts.get(table) ?? 0) + 1);
  }
  return counts;
}

function recordBackfillProof(
  sql: string,
  order: MigrationOrder | null,
  tableWriteCounts: Map<string, number>,
  priorBackfills: Map<string, number>,
): void {
  if (!order || /\$(?:[A-Za-z_]\w*)?\$/.test(sql) || /(?:UPDATE|INSERT\s+INTO)\s+["'`]?\w+["'`]?\s*\./i.test(sql)) return;
  const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  if (statements.some((statement) => ((statement.match(/'/g)?.length ?? 0) % 2) !== 0)) return;
  for (const statement of statements) {
    const backfill = `${statement};`.match(NULL_BACKFILL_RE);
    if (!isSafeBackfill(backfill, tableWriteCounts)) continue;
    priorBackfills.set(`${order.directory}:${backfill[1]}.${backfill[2]}`, order.sequence);
  }
}

function isSafeBackfill(backfill: RegExpMatchArray | null, tableWriteCounts: Map<string, number>): backfill is RegExpMatchArray {
  if (!backfill) return false;
  const table = backfill[1]!;
  const column = backfill[2]!;
  return LOWERCASE_SQL_IDENTIFIER.test(table)
    && LOWERCASE_SQL_IDENTIFIER.test(column)
    && column === backfill[3]
    && tableWriteCounts.get(table) === 1;
}

// TODO: cerberus(parameter-count=5, limit=4, attempt=3/2)
function addSetNotNullViolations(
  cleaned: string,
  rel: string,
  order: MigrationOrder | null,
  priorBackfills: Map<string, number>,
): SetViolation[] {
  const violations: SetViolation[] = [];
  for (const finding of findSetNotNullWithoutDefault(cleaned)) {
    const backfillSequence = priorBackfills.get(`${order?.directory}:${finding.table}.${finding.column}`);
    if (order && backfillSequence !== undefined && backfillSequence < order.sequence) continue;
    violations.push({
      file: rel,
      violation: {
        analyzer: 'migration-safety',
        location: `${rel}:${finding.line}`,
        current: 1,
        threshold: 0,
        severity: 'security',
        suggestion: `${finding.describe}. Existing NULL rows will fail the constraint. Add a DEFAULT in the same ALTER or backfill in a prior migration.`,
      },
    });
  }
  return violations;
}

function findSetNotNullWithoutDefault(sql: string): Array<{ line: number; table: string; column: string; describe: string }> {
  const out: Array<{ line: number; table: string; column: string; describe: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = SET_NOT_NULL_RE.exec(sql)) !== null) {
    const line = lineOf(sql, m.index);
    // Look at a small window (next ~200 chars or until ; ) for a DEFAULT clause
    // referencing the same column. Drizzle batches DEFAULT + SET NOT NULL in
    // a single statement, so this catches "safe" cases.
    const tail = sql.slice(m.index, m.index + 400);
    const stmt = tail.split(';')[0] ?? tail;
    const hasDefault = new RegExp(
      `ALTER\\s+COLUMN\\s+["'\`]?${m[2]}["'\`]?\\s+SET\\s+DEFAULT`,
      'i',
    ).test(stmt);
    if (!hasDefault) out.push({ line, table: m[1]!, column: m[2]!, describe: `SET NOT NULL ${m[1]}.${m[2]} (no DEFAULT)` });
  }
  return out;
}

function lineOf(content: string, idx: number): number {
  // 1-based line number for the given offset.
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/** Default content source: the working tree. Pre-commit passes a staged-blob reader. */
function readFromDisk(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Public entry: scans the staged SQL files for unsafe operations. */
export function analyzeMigrationSafety(
  files: string[],
  cwd: string,
  readContent: (abs: string) => string | null = readFromDisk,
): SetViolation[] {
  const sqlFiles = files.filter((f) => SQL_EXT.test(f)).sort((a, b) => {
    const left = migrationOrder(a, cwd);
    const right = migrationOrder(b, cwd);
    if (left?.directory === right?.directory && left && right) return left.sequence - right.sequence;
    return toPosix(relative(cwd, a)).localeCompare(toPosix(relative(cwd, b)));
  });
  if (sqlFiles.length === 0) return [];

  const out: SetViolation[] = [];
  const priorBackfills = new Map<string, number>();
  for (const abs of sqlFiles) {
    const sql = readContent(abs);
    if (sql === null) continue;
    const rel = toPosix(relative(cwd, abs));
    const order = migrationOrder(abs, cwd);
    // Strip line comments to avoid false positives on docs.
    const cleaned = stripComments(sql);

    const tableWriteCounts = collectTableWrites(cleaned, order, priorBackfills);

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(cleaned)) !== null) {
        const violation: Violation = {
          analyzer: 'migration-safety',
          location: `${rel}:${lineOf(cleaned, m.index)}`,
          current: 1,
          threshold: 0,
          severity: 'security',
          suggestion: `${pattern.describe(m)}. ${pattern.suggestion}`,
        };
        out.push({ file: rel, violation });
      }
    }

    out.push(...addSetNotNullViolations(cleaned, rel, order, priorBackfills));

    recordBackfillProof(cleaned, order, tableWriteCounts, priorBackfills);
  }
  return out;
}
