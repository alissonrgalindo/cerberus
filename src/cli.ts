import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { measureCognitive } from './analyzers/cognitive-complexity.js';
import { analyzeCoverage } from './analyzers/coverage-delta.js';
import { measureCyclomatic } from './analyzers/cyclomatic-complexity.js';
import { analyzeDuplication } from './analyzers/duplication.js';
import { measureTypeSafety } from './analyzers/type-safety.js';
import { hashFileSet, incrementAttempt } from './attempts.js';
import { BASELINE_FILE, loadBaseline, saveBaseline } from './baseline.js';
import { isGitCommit } from './commit-detect.js';
import { CONFIG_FILE, loadConfig } from './config.js';
import { analyzeFile, computeFileBaseline, hashContent, type FileReport } from './engine.js';
import { toPosix, walkTsFiles } from './files.js';
import { getFileContent, getStagedFiles } from './git-diff.js';
import { applyTodoInjection, stageFiles } from './injector.js';
import { installGitHook, registerClaudeHook } from './install-hooks.js';
import { reportHuman, reportJson, type RunReport } from './reporter.js';
import type { Baseline, SetViolation } from './types.js';

type CheckOutcome = { report: RunReport; exitCode: number };

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const DTS_EXT = /\.d\.ts$/;

function relKey(cwd: string, absPath: string): string {
  return toPosix(relative(cwd, absPath));
}

function toAbs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function isAnalyzable(absPath: string): boolean {
  return TS_EXT.test(absPath) && !DTS_EXT.test(absPath);
}

function bypassActive(): boolean {
  return process.env.QUALITY_GATE_BYPASS === '1';
}

/**
 * Core check shared by the CLI, the git hook and the Claude Code hook.
 * Runs analyzers over the given files and, in pre-commit mode, applies the
 * anti-doom-loop: after maxRefactorAttempts the gate lets the commit through,
 * injecting `// TODO: quality-gate(...)` flags and re-staging the files.
 */
async function performCheck(opts: { cwd: string; files: string[]; mode?: string }): Promise<CheckOutcome> {
  const { cwd } = opts;
  const config = loadConfig(cwd);
  const baseline = loadBaseline(cwd);
  const files = opts.files.filter((f) => isAnalyzable(f) && existsSync(f));

  const reports: FileReport[] = [];
  for (const abs of files) {
    const rel = relKey(cwd, abs);
    const report = await analyzeFile(rel, getFileContent(abs), config, baseline?.files[rel]);
    reports.push(report);
  }

  // Set-level analyzers (coverage, duplication) are expensive and only run when
  // enforcing a commit. Their violations are merged into the per-file reports.
  const notes: string[] = [];
  if (opts.mode === 'pre-commit') {
    const enabled = new Set(config.preCommit.enabled);
    const setViolations: SetViolation[] = [];

    if (enabled.has('duplication')) {
      setViolations.push(...analyzeDuplication(files, cwd, config));
    }
    if (enabled.has('coverage')) {
      const cov = await analyzeCoverage(files.map((f) => relKey(cwd, f)), cwd, baseline, config);
      if (cov.skipped && cov.reason) notes.push(`coverage: ${cov.reason}`);
      setViolations.push(...cov.violations);
    }

    for (const sv of setViolations) {
      let report = reports.find((r) => r.file === sv.file);
      if (!report) {
        report = { file: sv.file, passed: true, violations: [], metrics: {} };
        reports.push(report);
      }
      report.violations.push(sv.violation);
      report.passed = false;
    }
  }

  const anyViolation = reports.some((r) => !r.passed);
  let status: RunReport['status'] = anyViolation ? 'QUALITY_GATE_FAIL' : 'PASS';
  let exitCode = anyViolation ? 1 : 0;
  let attempt: string | undefined;

  if (anyViolation && opts.mode === 'pre-commit') {
    const max = config.maxRefactorAttempts;
    const { count } = incrementAttempt(cwd, hashFileSet(files.map((f) => relKey(cwd, f))));
    attempt = `${count}/${max}`;
    if (count > max) {
      status = 'PASS_WITH_TODO';
      exitCode = 0;
      const failing = reports.filter((r) => !r.passed);
      for (const r of failing) applyTodoInjection(cwd, r, attempt);
      stageFiles(cwd, failing.map((r) => r.file));
    }
  }

  return {
    report: { status, passed: exitCode === 0, attempt, files: reports, notes: notes.length ? notes : undefined },
    exitCode,
  };
}

async function runCheck(args: {
  file?: string;
  staged?: boolean;
  mode?: string;
  format?: string;
}): Promise<void> {
  const cwd = process.cwd();
  if (bypassActive()) {
    process.stderr.write(chalk.dim('quality-gate: bypassed (QUALITY_GATE_BYPASS=1)\n'));
    process.exit(0);
  }

  const files = args.file
    ? [toAbs(cwd, args.file)]
    : getStagedFiles(cwd).map((f) => toAbs(cwd, f));

  const { report, exitCode } = await performCheck({ cwd, files, mode: args.mode });
  if (args.format === 'json') reportJson(report);
  else reportHuman(report);
  process.exit(exitCode);
}

/** Claude Code PreToolUse(Bash) hook: blocks an agent's `git commit` when the gate fails. */
async function runClaudeHook(): Promise<void> {
  let payload: { tool_name?: string; tool_input?: { command?: string }; cwd?: string };
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not a parseable hook payload — stay out of the way
  }

  const command = payload.tool_input?.command ?? '';
  const cwd = payload.cwd ?? process.cwd();
  if (payload.tool_name !== 'Bash' || !isGitCommit(command)) process.exit(0);
  if (/\[skip-quality\]/.test(command) || bypassActive()) process.exit(0);

  const files = getStagedFiles(cwd).map((f) => toAbs(cwd, f));
  if (files.length === 0) process.exit(0);

  const { report, exitCode } = await performCheck({ cwd, files, mode: 'pre-commit' });
  if (exitCode === 0) process.exit(0);

  const failing = report.files.filter((f) => !f.passed);
  const lines = failing.flatMap((f) =>
    f.violations.map((v) => `  ${f.file} — ${v.analyzer} ${v.location}: ${v.current} > ${v.threshold}`),
  );
  process.stderr.write(
    `quality-gate blocked this commit (${failing.length} file(s)):\n${lines.join('\n')}\n` +
      `Refactor and retry, or set QUALITY_GATE_BYPASS=1 / add [skip-quality] to the message.\n`,
  );
  process.exit(2); // block the Bash tool call
}

function runInstallHooks(): void {
  const cwd = process.cwd();
  const { hookPath, wrapped, husky } = installGitHook(cwd);
  const settingsPath = registerClaudeHook(cwd);
  const suffix = husky ? ' (appended to husky hook)' : wrapped ? ' (wrapped existing hook)' : '';
  process.stdout.write(chalk.green(`✓ git pre-commit hook: ${hookPath}${suffix}\n`));
  process.stdout.write(chalk.green(`✓ Claude Code PreToolUse hook: ${settingsPath}\n`));
  process.stdout.write(chalk.dim('Test with: git commit --allow-empty -m test\n'));
}

function runBaseline(args: { force?: boolean }): void {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  if (existsSync(resolve(cwd, BASELINE_FILE)) && !args.force) {
    process.stderr.write(chalk.red(`${BASELINE_FILE} already exists. Use --force to overwrite.\n`));
    process.exit(1);
  }
  const files = walkTsFiles(cwd, config.ignore);
  const baseline: Baseline = { version: 1, generatedAt: new Date().toISOString(), files: {} };
  for (const abs of files) {
    const rel = relKey(cwd, abs);
    baseline.files[rel] = computeFileBaseline(rel, readFileSync(abs, 'utf8'));
  }
  saveBaseline(cwd, baseline);
  process.stdout.write(
    chalk.green(`✓ baseline: ${Object.keys(baseline.files).length} files → ${BASELINE_FILE}\n`),
  );
}

function runRefreshBaseline(args: { file: string }): void {
  const cwd = process.cwd();
  const abs = toAbs(cwd, args.file);
  if (!existsSync(abs)) {
    process.stderr.write(chalk.red(`File not found: ${args.file}\n`));
    process.exit(1);
  }
  const baseline: Baseline = loadBaseline(cwd) ?? {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: {},
  };
  const rel = relKey(cwd, abs);
  baseline.files[rel] = computeFileBaseline(rel, readFileSync(abs, 'utf8'));
  baseline.generatedAt = new Date().toISOString();
  saveBaseline(cwd, baseline);
  process.stdout.write(chalk.green(`✓ re-baselined ${rel}\n`));
}

function runAudit(args: { path?: string; top?: number }): void {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const root = args.path ? toAbs(cwd, args.path) : cwd;
  const top = args.top ?? 10;

  const rows = walkTsFiles(root, config.ignore).map((abs) => {
    const rel = relKey(cwd, abs);
    const content = readFileSync(abs, 'utf8');
    const cognitive = measureCognitive(rel, content).reduce((m, s) => Math.max(m, s.score), 0);
    const cyclomatic = measureCyclomatic(rel, content).reduce((m, s) => Math.max(m, s.score), 0);
    const ts = measureTypeSafety(rel, content);
    return { file: rel, cognitive, cyclomatic, any: ts.anyCount, worst: Math.max(cognitive, cyclomatic) };
  });

  rows.sort((a, b) => b.worst - a.worst);
  const shown = rows.slice(0, top);

  process.stdout.write(chalk.bold(`\nTop ${shown.length} files by complexity (of ${rows.length} scanned)\n\n`));
  process.stdout.write(
    chalk.dim('  cog  cyc  any  file\n'),
  );
  for (const r of shown) {
    process.stdout.write(
      `  ${String(r.cognitive).padStart(3)}  ${String(r.cyclomatic).padStart(3)}  ${String(r.any).padStart(3)}  ${r.file}\n`,
    );
  }
  process.stdout.write('\n');
}

function runDoctor(): void {
  const cwd = process.cwd();
  let ok = true;
  const line = (good: boolean, msg: string): void => {
    process.stdout.write(`  ${good ? chalk.green('✓') : chalk.yellow('•')} ${msg}\n`);
    if (!good) ok = false;
  };

  process.stdout.write(chalk.bold('\nquality-gate doctor\n\n'));

  const hasConfig = existsSync(resolve(cwd, CONFIG_FILE));
  line(hasConfig, hasConfig ? `${CONFIG_FILE} found` : `${CONFIG_FILE} missing (using defaults)`);

  const baseline = loadBaseline(cwd);
  if (!baseline) {
    line(false, `${BASELINE_FILE} missing — run "quality-gate baseline"`);
  } else {
    const total = Object.keys(baseline.files).length;
    let stale = 0;
    for (const [rel, fb] of Object.entries(baseline.files)) {
      const abs = resolve(cwd, rel);
      if (existsSync(abs) && hashContent(readFileSync(abs, 'utf8')) !== fb.fileHash) stale += 1;
    }
    line(true, `${BASELINE_FILE}: ${total} files`);
    line(stale === 0, stale === 0 ? 'baseline up to date' : `${stale} file(s) drifted from baseline (refresh-baseline)`);
  }

  const gitHook = resolve(cwd, '.git', 'hooks', 'pre-commit');
  const hookInstalled = existsSync(gitHook) && readFileSync(gitHook, 'utf8').includes('quality-gate-hook');
  line(hookInstalled, hookInstalled ? 'git pre-commit hook installed' : 'git pre-commit hook missing — run "quality-gate install-hooks"');

  if (bypassActive()) line(false, 'QUALITY_GATE_BYPASS=1 is active — gate disabled this session');

  process.stdout.write(`\n${ok ? chalk.green('All good.') : chalk.yellow('Some checks need attention.')}\n\n`);
  process.exit(0);
}

await yargs(hideBin(process.argv))
  .scriptName('quality-gate')
  .command(
    'check',
    'Run analyzers against staged files or a single file',
    (y) =>
      y
        .option('file', { type: 'string', describe: 'Analyze a single file' })
        .option('staged', { type: 'boolean', describe: 'Analyze staged files' })
        .option('mode', { choices: ['pre-commit', 'post-edit'] as const, describe: 'Enforcement mode (pre-commit counts attempts)' })
        .option('format', { choices: ['json', 'human'] as const, default: 'human' })
        .check((a) => {
          if (!a.file && !a.staged) throw new Error('Provide --file <path> or --staged');
          return true;
        }),
    (a) => runCheck(a),
  )
  .command(
    'baseline',
    'Snapshot current metrics into the baseline file',
    (y) => y.option('force', { type: 'boolean', describe: 'Overwrite an existing baseline' }),
    (a) => runBaseline(a),
  )
  .command(
    'refresh-baseline',
    'Recompute the baseline for a single file',
    (y) => y.option('file', { type: 'string', demandOption: true, describe: 'File to re-baseline' }),
    (a) => runRefreshBaseline(a),
  )
  .command(
    'audit [path]',
    'List the worst files by complexity',
    (y) =>
      y
        .positional('path', { type: 'string', describe: 'Directory to scan (default: cwd)' })
        .option('top', { type: 'number', default: 10, describe: 'How many files to show' }),
    (a) => runAudit(a),
  )
  .command('doctor', 'Diagnose config, baseline and hook state', {}, () => runDoctor())
  .command(
    'install-hooks',
    'Install the git pre-commit hook and register the Claude Code hook',
    {},
    () => runInstallHooks(),
  )
  .command('claude-hook', false, {}, () => runClaudeHook())
  .demandCommand(1)
  .strict()
  .help()
  .parseAsync();
