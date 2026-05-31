import chalk from 'chalk';
import type { FileReport } from './engine.js';

export type RunReport = {
  status: 'PASS' | 'QUALITY_GATE_FAIL' | 'PASS_WITH_TODO';
  passed: boolean;
  attempt?: string;
  files: FileReport[];
};

export function reportJson(report: RunReport): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export function reportHuman(report: RunReport): void {
  const failed = report.files.filter((f) => !f.passed);

  if (report.status === 'PASS_WITH_TODO') {
    process.stderr.write(
      chalk.yellow(
        `⚠ quality-gate: ${failed.length} file(s) still failing after ${report.attempt} attempts — letting the commit through (debt flagged).\n`,
      ),
    );
    for (const f of failed) writeFileBlock(f);
    return;
  }

  if (failed.length === 0) {
    process.stderr.write(chalk.green('✓ quality-gate: all checks passed\n'));
    return;
  }

  const attemptStr = report.attempt ? chalk.dim(` (attempt ${report.attempt})`) : '';
  process.stderr.write(chalk.red(`✗ quality-gate: ${failed.length} file(s) with violations`) + attemptStr + '\n');
  for (const f of failed) writeFileBlock(f);
  process.stderr.write(
    '\n' + chalk.dim('Bypass: QUALITY_GATE_BYPASS=1 or add [skip-quality] to the commit message.\n'),
  );
}

function writeFileBlock(f: FileReport): void {
  process.stderr.write('\n' + chalk.underline(f.file) + '\n');
  for (const v of f.violations) {
    const deltaStr =
      v.delta !== undefined ? chalk.dim(` (baseline ${v.baseline}, Δ+${v.delta})`) : '';
    process.stderr.write(
      `  ${chalk.yellow(v.analyzer)} ${chalk.cyan(v.location)} — ${v.current} > ${v.threshold}${deltaStr}\n`,
    );
    process.stderr.write(`    ${chalk.dim(v.suggestion)}\n`);
  }
}
