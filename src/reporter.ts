import chalk from 'chalk';
import type { FileReport } from './engine.js';
import { isSecurityViolation } from './types.js';

export type RunReport = {
  status: 'PASS' | 'QUALITY_GATE_FAIL' | 'PASS_WITH_TODO';
  passed: boolean;
  attempt?: string;
  files: FileReport[];
  notes?: string[];
};

export function reportJson(report: RunReport): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** Extracts a line number from the location formats analyzers emit: `L12`, `path:12`, `name:12`. */
function lineFromLocation(location: string): number {
  const m = /(?:^L|:)(\d+)$/.exec(location);
  return m ? Number(m[1]) : 1;
}

/** GitHub workflow-command escaping (https://docs.github.com/actions/reference/workflow-commands). */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Emits GitHub Actions workflow commands so violations render as inline
 * annotations on the PR diff. Use with `check --base origin/<base> --format github`.
 */
export function reportGithub(report: RunReport): void {
  let count = 0;
  for (const f of report.files) {
    for (const v of f.violations) {
      count += 1;
      const security = isSecurityViolation(v);
      const title = `cerberus: ${v.analyzer}${security ? ' [SECURITY]' : ''}`;
      const line = lineFromLocation(v.location);
      process.stdout.write(
        `::error file=${escapeProperty(f.file)},line=${line},title=${escapeProperty(title)}::${escapeData(v.suggestion)}\n`,
      );
    }
  }
  process.stderr.write(
    count === 0
      ? '✓ cerberus: all checks passed\n'
      : `✗ cerberus: ${count} violation(s) annotated on the diff\n`,
  );
}

export function reportHuman(report: RunReport): void {
  for (const note of report.notes ?? []) {
    process.stderr.write(chalk.dim(`  note: ${note}\n`));
  }
  const failed = report.files.filter((f) => !f.passed);

  if (report.status === 'PASS_WITH_TODO') {
    process.stderr.write(
      chalk.yellow(
        `⚠ cerberus: ${failed.length} file(s) still failing after ${report.attempt} attempts — letting the commit through (debt flagged).\n`,
      ),
    );
    for (const f of failed) writeFileBlock(f);
    return;
  }

  if (failed.length === 0) {
    process.stderr.write(chalk.green('✓ cerberus: all checks passed\n'));
    return;
  }

  const attemptStr = report.attempt ? chalk.dim(` (attempt ${report.attempt})`) : '';
  process.stderr.write(chalk.red(`✗ cerberus: ${failed.length} file(s) with violations`) + attemptStr + '\n');
  for (const f of failed) writeFileBlock(f);
  // No bypass hint here on purpose: this output is also read by coding agents
  // via the git hook, and advertising the escape hatch defeats the gate.
  // Bypasses are documented in the README for humans.
}

function writeFileBlock(f: FileReport): void {
  process.stderr.write('\n' + chalk.underline(f.file) + '\n');
  for (const v of f.violations) {
    const deltaStr =
      v.delta !== undefined ? chalk.dim(` (baseline ${v.baseline}, Δ+${v.delta})`) : '';
    const sevTag = isSecurityViolation(v) ? chalk.bgRed.white(' SECURITY ') + ' ' : '';
    process.stderr.write(
      `  ${sevTag}${chalk.yellow(v.analyzer)} ${chalk.cyan(v.location)} — ${v.current} > ${v.threshold}${deltaStr}\n`,
    );
    process.stderr.write(`    ${chalk.dim(v.suggestion)}\n`);
  }
}
