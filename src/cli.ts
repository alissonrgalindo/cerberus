import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { measureCognitive } from './analyzers/cognitive-complexity.js';
import { analyzeCoverage, collectCoverageForBaseline } from './analyzers/coverage-delta.js';
import { measureCyclomatic } from './analyzers/cyclomatic-complexity.js';
import { analyzeDuplication } from './analyzers/duplication.js';
import { analyzeMigrationSafety } from './analyzers/migration-safety.js';
import { analyzeNewDependency } from './analyzers/new-dependency.js';
import { analyzeSecretInDiff } from './analyzers/secret-in-diff.js';
import { measureTypeSafety } from './analyzers/type-safety.js';
import { hashFileSet, incrementAttempt } from './attempts.js';
import { BASELINE_FILE, loadBaseline, saveBaseline } from './baseline.js';
import { isGitCommit } from './commit-detect.js';
import { CONFIG_FILE, loadConfig } from './config.js';
import { listDrift, type DriftEntry } from './drift.js';
import { analyzeFile, analyzePythonFile, computeFileBaseline, type FileReport } from './engine.js';
import { CODE_EXT, DTS_EXT, isBuildArtifactPath, makeIgnoreMatcher, toPosix, walkTsFiles } from './files.js';
import { getChangedFiles, getFileContent, getStagedContent, getStagedFiles } from './git-diff.js';
import { applyTodoInjection, stageFiles } from './injector.js';
import {
  detectInstalledHook,
  gitHooksDir,
  installGitHook,
  registerClaudeHook,
} from './install-hooks.js';
import { reportGithub, reportHuman, reportJson, type RunReport } from './reporter.js';
import {
  isSecurityViolation,
  SECURITY_ANALYZERS,
  type Baseline,
  type Config,
  type SetViolation,
} from './types.js';

/** Stable schema version for every --format json output. Bump on breaking changes. */
const JSON_SCHEMA_VERSION = 1 as const;

type CheckOutcome = { report: RunReport; exitCode: number };

const SQL_EXT = /\.sql$/i;
const PY_EXT = /\.py$/;

function relKey(cwd: string, absPath: string): string {
  return toPosix(relative(cwd, absPath));
}

function toAbs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function isTsAnalyzable(absPath: string): boolean {
  return CODE_EXT.test(absPath) && !DTS_EXT.test(absPath);
}

function isMigrationSql(absPath: string): boolean {
  return SQL_EXT.test(absPath);
}

function isPyAnalyzable(absPath: string): boolean {
  return PY_EXT.test(absPath);
}

function isAnalyzable(absPath: string): boolean {
  return isTsAnalyzable(absPath) || isMigrationSql(absPath) || isPyAnalyzable(absPath);
}

function bypassActive(): boolean {
  // CERBERUS_BYPASS is canonical; QUALITY_GATE_BYPASS kept as a legacy alias.
  return process.env.CERBERUS_BYPASS === '1' || process.env.QUALITY_GATE_BYPASS === '1';
}

/**
 * Core check shared by the CLI, the git hook and the Claude Code hook.
 * Runs analyzers over the given files and, in pre-commit mode, applies the
 * anti-doom-loop: after maxRefactorAttempts the gate lets the commit through,
 * injecting `// TODO: cerberus(...)` flags and re-staging the files.
 *
 * Security-tier analyzers are exempt from every escape hatch: the doom-loop
 * never passes them through, and `securityOnly` mode (used when a bypass is
 * active) still runs them.
 */
async function performCheck(opts: {
  cwd: string;
  files: string[];
  mode?: string;
  securityOnly?: boolean;
  /** Files come from the git index — read the staged blob, not the working tree. */
  staged?: boolean;
}): Promise<CheckOutcome> {
  const { cwd } = opts;
  const fullConfig = loadConfig(cwd);
  // Security analyzers are ALWAYS enabled, regardless of what the config says.
  // The config file lives in the repo, which means a blocked agent could edit
  // it to disable secret scanning — so it doesn't get a vote on security.
  const enabledWithSecurity = [
    ...new Set([...fullConfig.preCommit.enabled, ...SECURITY_ANALYZERS]),
  ] as Config['preCommit']['enabled'];
  const config: Config = {
    ...fullConfig,
    preCommit: {
      ...fullConfig.preCommit,
      enabled: opts.securityOnly
        ? enabledWithSecurity.filter((a) => SECURITY_ANALYZERS.has(a))
        : enabledWithSecurity,
    },
  };
  // Quality analyzers skip two things: files matched by `ignore`, and build
  // artifacts (dist/, node_modules/, .next/, …). `ignore` is a QUALITY knob and
  // build output is generated, not authored — neither is worth grading. The
  // SECURITY tier deliberately runs on both: otherwise a blocked agent could
  // add `**/*` to `ignore` to silence the secret scanner, and a secret inlined
  // into a committed bundle would go unseen. So ignored / generated files still
  // run the per-file security analyzer (injection) and every set-level security
  // pass.
  const isIgnored = makeIgnoreMatcher(fullConfig.ignore);
  const skipQuality = (abs: string): boolean => {
    const rel = relKey(cwd, abs);
    return isIgnored(rel) || isBuildArtifactPath(rel);
  };
  const securityConfig: Config = {
    ...config,
    preCommit: {
      ...config.preCommit,
      enabled: config.preCommit.enabled.filter((a) => SECURITY_ANALYZERS.has(a)),
    },
  };

  // When the file list comes from the index, the file-reading security
  // analyzers judge the STAGED blob (what actually commits), not the dirty
  // working tree — so a secret staged then wiped from disk can't slip past.
  // Falls back to disk if the path has no index entry. `undefined` → analyzers
  // use their default working-tree reader (CLI --file, post-edit hook).
  const readStagedOrDisk = (abs: string): string | null => {
    const staged = getStagedContent(cwd, relKey(cwd, abs));
    if (staged !== null) return staged;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  const readSecuritySource = opts.staged ? readStagedOrDisk : undefined;

  const baseline = loadBaseline(cwd);
  const allStaged = opts.files.filter((f) => existsSync(f));
  const files = allStaged.filter(isAnalyzable);

  const reports: FileReport[] = [];
  const tsFiles = files.filter(isTsAnalyzable);
  const sqlFiles = files.filter(isMigrationSql);
  const pyFiles = files.filter(isPyAnalyzable);
  for (const abs of tsFiles) {
    const rel = relKey(cwd, abs);
    const qualitySkipped = skipQuality(abs);
    const report = await analyzeFile(
      rel,
      getFileContent(abs),
      qualitySkipped ? securityConfig : config,
      qualitySkipped ? undefined : baseline?.files[rel],
    );
    reports.push(report);
  }
  for (const abs of pyFiles) {
    const rel = relKey(cwd, abs);
    reports.push(
      await analyzePythonFile(rel, getFileContent(abs), skipQuality(abs) ? securityConfig : config),
    );
  }

  // Set-level analyzers (coverage, duplication, migration-safety) run regardless
  // of mode when there are matching files — they're cheap when there's nothing
  // to look at. Their violations are merged into the per-file reports.
  const notes: string[] = [];
  const enabled = new Set(config.preCommit.enabled);
  const setViolations: SetViolation[] = [];

  if (opts.mode === 'pre-commit') {
    // duplication and coverage are quality analyzers — they honor the same skips.
    const tsQualityFiles = tsFiles.filter((f) => !skipQuality(f));
    if (enabled.has('duplication')) {
      setViolations.push(...analyzeDuplication(tsQualityFiles, cwd, config));
    }
    if (enabled.has('coverage')) {
      const cov = await analyzeCoverage(
        tsQualityFiles.map((f) => relKey(cwd, f)),
        cwd,
        baseline,
        config,
      );
      if (cov.skipped && cov.reason) notes.push(`coverage: ${cov.reason}`);
      setViolations.push(...cov.violations);
    }
  }
  if (enabled.has('migration-safety') && sqlFiles.length > 0) {
    setViolations.push(...analyzeMigrationSafety(sqlFiles, cwd, readSecuritySource));
  }
  // secret-in-diff scans every staged file regardless of extension (env files,
  // configs, fixtures, markdown — secrets leak through all of them).
  if (enabled.has('secret-in-diff') && allStaged.length > 0) {
    setViolations.push(...analyzeSecretInDiff(allStaged, cwd, readSecuritySource));
  }
  // new-dependency audits staged package.json manifests for slopsquatting.
  if (enabled.has('new-dependency') && allStaged.length > 0) {
    setViolations.push(...analyzeNewDependency(allStaged, cwd, readSecuritySource));
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

  const anyViolation = reports.some((r) => !r.passed);
  let status: RunReport['status'] = anyViolation ? 'QUALITY_GATE_FAIL' : 'PASS';
  let exitCode = anyViolation ? 1 : 0;
  let attempt: string | undefined;

  if (anyViolation && opts.mode === 'pre-commit') {
    const max = config.maxRefactorAttempts;
    const { count } = incrementAttempt(cwd, hashFileSet(files.map((f) => relKey(cwd, f))));
    attempt = `${count}/${max}`;
    const hasSecurityViolation = reports.some((r) => r.violations.some(isSecurityViolation));
    if (count > max && !hasSecurityViolation) {
      // Anti-doom-loop applies to QUALITY debt only. Security violations
      // (secrets, injection sinks, destructive migrations, slopsquatting)
      // never pass with a TODO — a leaked key with a TODO is still leaked.
      status = 'PASS_WITH_TODO';
      exitCode = 0;
      const failing = reports.filter((r) => !r.passed);
      for (const r of failing) applyTodoInjection(cwd, r, attempt);
      stageFiles(cwd, failing.map((r) => r.file));
    } else if (count > max && hasSecurityViolation) {
      notes.push('security violations present — anti-doom-loop pass-through disabled');
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
  base?: string;
  mode?: string;
  format?: string;
}): Promise<void> {
  const cwd = process.cwd();

  // CERBERUS_BYPASS downgrades the gate to security-only instead of
  // disabling it: quality debt is bypassable, leaked secrets are not.
  const securityOnly = bypassActive();
  if (securityOnly) {
    process.stderr.write(
      chalk.dim('cerberus: CERBERUS_BYPASS=1 — quality checks skipped, security checks still enforced\n'),
    );
  }

  const staged = !args.file && !args.base; // the --staged / default path reads the index
  const files = args.file
    ? [toAbs(cwd, args.file)]
    : args.base
      ? getChangedFiles(cwd, args.base).map((f) => toAbs(cwd, f))
      : getStagedFiles(cwd).map((f) => toAbs(cwd, f));

  const { report, exitCode } = await performCheck({ cwd, files, mode: args.mode, securityOnly, staged });
  if (args.format === 'json') reportJson(report);
  else if (args.format === 'github') reportGithub(report);
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

  // A bypass ([skip-cerberus] / [skip-quality] in the message, or
  // CERBERUS_BYPASS / QUALITY_GATE_BYPASS anywhere — including inline in the
  // command the agent wrote) only skips the QUALITY analyzers. Security
  // analyzers always run: an agent must never be able to talk itself past a
  // leaked secret or an injection sink. Legacy names kept as aliases.
  const securityOnly =
    /\[skip-cerberus\]/.test(command) ||
    /\[skip-quality\]/.test(command) ||
    /\bCERBERUS_BYPASS=1\b/.test(command) ||
    /\bQUALITY_GATE_BYPASS=1\b/.test(command) ||
    bypassActive();

  const files = getStagedFiles(cwd).map((f) => toAbs(cwd, f));
  if (files.length === 0) process.exit(0);

  const { report, exitCode } = await performCheck({ cwd, files, mode: 'pre-commit', securityOnly, staged: true });
  if (exitCode === 0) process.exit(0);

  const failing = report.files.filter((f) => !f.passed);
  const hasSecurity = failing.some((f) => f.violations.some(isSecurityViolation));
  const lines = failing.flatMap((f) =>
    f.violations.map(
      (v) =>
        `  ${f.file} — ${v.analyzer} ${v.location}: ${v.current} > ${v.threshold}\n    fix: ${v.suggestion}`,
    ),
  );
  // Deliberately NO bypass instructions here: this message is read by the
  // agent, and telling a blocked agent how to disable the gate defeats it.
  process.stderr.write(
    `cerberus blocked this commit (${failing.length} file(s)):\n${lines.join('\n')}\n` +
      (hasSecurity
        ? 'Security violations must be fixed — they cannot be bypassed or deferred.\n'
        : 'Fix the violations above and retry the commit.\n'),
  );
  process.exit(2); // block the Bash tool call
}

/**
 * Claude Code PostToolUse(Edit|Write|MultiEdit) hook: runs the gate on the
 * file the agent just edited and feeds violations straight back (exit 2 →
 * stderr is shown to the agent). Fixing at edit time costs one tool call;
 * discovering at commit time costs a doom-loop attempt.
 */
async function runClaudePostEditHook(): Promise<void> {
  let payload: {
    tool_name?: string;
    tool_input?: { file_path?: string };
    cwd?: string;
  };
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name ?? '';
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);
  const filePath = payload.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const cwd = payload.cwd ?? process.cwd();
  const abs = toAbs(cwd, filePath);
  if (!existsSync(abs)) process.exit(0);

  // Don't pre-filter by extension: secret-in-diff applies to any file the
  // agent writes (.env, configs, fixtures). performCheck routes internally.
  const { report, exitCode } = await performCheck({ cwd, files: [abs], mode: 'post-edit' });
  if (exitCode === 0) process.exit(0);

  const failing = report.files.filter((f) => !f.passed);
  const lines = failing.flatMap((f) =>
    f.violations.map((v) => `  ${v.analyzer} ${v.location}: ${v.suggestion}`),
  );
  process.stderr.write(
    `cerberus found issues in the file you just edited (fix them now — the commit will be blocked otherwise):\n${lines.join('\n')}\n`,
  );
  process.exit(2); // feed stderr back to the agent
}

function runInstallHooks(args: { dryRun?: boolean }): void {
  const cwd = process.cwd();
  const existing = detectInstalledHook(cwd);

  // Already wired (Husky or git): no-op. Don't mutate, don't confuse the agent.
  if (existing.kind !== 'none' && existing.hasMarker) {
    process.stdout.write(
      chalk.green(`✓ already installed (${existing.kind}: ${existing.path})\n`),
    );
    process.stdout.write(chalk.dim('Use --force to re-install (not implemented yet).\n'));
    return;
  }

  if (args.dryRun) {
    let plan: string;
    if (existing.kind === 'none') {
      const hooksDir = gitHooksDir(cwd);
      plan = hooksDir
        ? `would write fresh hook at ${hooksDir}/pre-commit`
        : 'not a git repository — would refuse to install (run "git init" or use Husky)';
    } else {
      plan = `would ${existing.kind === 'husky' ? 'append to' : 'wrap'} ${existing.path}`;
    }
    process.stdout.write(chalk.cyan(`(dry-run) ${plan}\n`));
    process.stdout.write(chalk.dim('Run without --dry-run to apply.\n'));
    return;
  }

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
  // Fill real coverage percentages so the coverage-delta analyzer has a floor
  // to compare against (best-effort; 0 means "no data, never flag").
  const coverage = collectCoverageForBaseline(cwd, config.preCommit.timeoutMs);
  if (coverage) {
    let covered = 0;
    for (const [rel, pct] of coverage) {
      if (baseline.files[rel]) {
        baseline.files[rel].metrics.coverage.percent = pct;
        covered += 1;
      }
    }
    process.stdout.write(chalk.dim(`coverage baseline: ${covered} file(s)\n`));
  } else {
    process.stdout.write(chalk.dim('coverage baseline: skipped (no vitest/coverage data)\n'));
  }
  saveBaseline(cwd, baseline);
  process.stdout.write(
    chalk.green(`✓ baseline: ${Object.keys(baseline.files).length} files → ${BASELINE_FILE}\n`),
  );
}

function runRefreshBaseline(args: {
  file?: string[];
  allDrifted?: boolean;
  stdin?: boolean;
}): void {
  const cwd = process.cwd();

  let targets: string[] = [];
  if (args.allDrifted) {
    targets = listDrift(cwd).map((d) => d.file);
    if (targets.length === 0) {
      process.stdout.write(chalk.green('✓ no drift — nothing to refresh\n'));
      return;
    }
  } else if (args.stdin) {
    targets = readFileSync(0, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (args.file && args.file.length) {
    targets = args.file;
  } else {
    process.stderr.write(
      chalk.red('Provide --file <path> (repeatable), --all-drifted, or --stdin\n'),
    );
    process.exit(1);
  }

  const baseline: Baseline = loadBaseline(cwd) ?? {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: {},
  };

  let updated = 0;
  for (const p of targets) {
    const abs = toAbs(cwd, p);
    if (!existsSync(abs)) {
      process.stderr.write(chalk.yellow(`skip (not found): ${p}\n`));
      continue;
    }
    const rel = relKey(cwd, abs);
    baseline.files[rel] = computeFileBaseline(rel, readFileSync(abs, 'utf8'));
    process.stdout.write(chalk.green(`✓ re-baselined ${rel}\n`));
    updated += 1;
  }
  if (updated > 0) {
    baseline.generatedAt = new Date().toISOString();
    saveBaseline(cwd, baseline);
  }
  process.stdout.write(chalk.dim(`${updated} file(s) updated\n`));
}

function runAudit(args: { path?: string; top?: number; format?: string }): void {
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
    return {
      file: rel,
      cognitive,
      cyclomatic,
      any: ts.anyCount,
      worst: Math.max(cognitive, cyclomatic),
    };
  });

  rows.sort((a, b) => b.worst - a.worst);
  const shown = rows.slice(0, top);

  if (args.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: JSON_SCHEMA_VERSION,
          scanned: rows.length,
          top: shown.length,
          rows: shown,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    chalk.bold(`\nTop ${shown.length} files by complexity (of ${rows.length} scanned)\n\n`),
  );
  process.stdout.write(chalk.dim('  cog  cyc  any  file\n'));
  for (const r of shown) {
    process.stdout.write(
      `  ${String(r.cognitive).padStart(3)}  ${String(r.cyclomatic).padStart(3)}  ${String(r.any).padStart(3)}  ${r.file}\n`,
    );
  }
  process.stdout.write('\n');
}

function runDoctor(args: { format?: string; verbose?: boolean }): void {
  const cwd = process.cwd();
  const verbose = args.verbose ?? false;
  const json = args.format === 'json';

  // Collect state first so JSON output can emit it whole.
  const hasConfig = existsSync(resolve(cwd, CONFIG_FILE));
  const baseline = loadBaseline(cwd);
  const drifted: DriftEntry[] = baseline ? listDrift(cwd) : [];
  const hook = detectInstalledHook(cwd);
  const bypass = bypassActive();

  let ok = true;
  const lines: Array<{ good: boolean; msg: string }> = [];
  const line = (good: boolean, msg: string): void => {
    lines.push({ good, msg });
    if (!good) ok = false;
  };

  line(hasConfig, hasConfig ? `${CONFIG_FILE} found` : `${CONFIG_FILE} missing (using defaults)`);

  if (!baseline) {
    line(false, `${BASELINE_FILE} missing — run "cerberus baseline"`);
  } else {
    const total = Object.keys(baseline.files).length;
    line(true, `${BASELINE_FILE}: ${total} files`);
    if (drifted.length === 0) {
      line(true, 'baseline up to date');
    } else {
      line(
        false,
        `${drifted.length} file(s) drifted from baseline — see "cerberus drift"`,
      );
    }
  }

  if (hook.kind === 'none') {
    line(false, 'git pre-commit hook missing — run "cerberus install-hooks"');
  } else if (!hook.hasMarker) {
    line(
      false,
      `pre-commit hook present (${hook.kind}: ${hook.path}) but cerberus not wired — run "cerberus install-hooks"`,
    );
  } else {
    line(true, `pre-commit hook installed (${hook.kind}: ${hook.path})`);
  }

  if (bypass) line(false, 'QUALITY_GATE_BYPASS=1 is active — gate disabled this session');

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: JSON_SCHEMA_VERSION,
          ok,
          config: { found: hasConfig, path: CONFIG_FILE },
          baseline: baseline
            ? { found: true, total: Object.keys(baseline.files).length, drifted: drifted.length }
            : { found: false, total: 0, drifted: 0 },
          drifted: drifted.map((d) => ({
            file: d.file,
            direction: d.direction,
            deltas: d.deltas,
          })),
          hook,
          bypass,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }

  process.stdout.write(chalk.bold('\ncerberus doctor\n\n'));
  for (const l of lines) {
    process.stdout.write(`  ${l.good ? chalk.green('✓') : chalk.yellow('•')} ${l.msg}\n`);
  }

  if (drifted.length > 0) {
    const limit = verbose ? drifted.length : Math.min(20, drifted.length);
    process.stdout.write('\n');
    for (const d of drifted.slice(0, limit)) {
      const arrow =
        d.direction === 'degraded' ? chalk.yellow('↑') :
        d.direction === 'improved' ? chalk.green('↓') : chalk.dim('·');
      process.stdout.write(`      ${arrow} ${d.file}\n`);
    }
    if (drifted.length > limit) {
      process.stdout.write(
        chalk.dim(`      … and ${drifted.length - limit} more (use --verbose)\n`),
      );
    }
  }

  process.stdout.write(
    `\n${ok ? chalk.green('All good.') : chalk.yellow('Some checks need attention.')}\n\n`,
  );
  process.exit(0);
}

function runDrift(args: { format?: string }): void {
  const cwd = process.cwd();
  const drifted = listDrift(cwd);

  if (args.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: JSON_SCHEMA_VERSION,
          count: drifted.length,
          drifted: drifted.map((d) => ({
            file: d.file,
            direction: d.direction,
            deltas: d.deltas,
            baseline: {
              cognitiveMax: d.baseline.metrics.cognitiveComplexity.max,
              cyclomaticMax: d.baseline.metrics.cyclomaticComplexity.max,
              anyCount: d.baseline.metrics.typeSafety.anyCount,
            },
            current: {
              cognitiveMax: d.current.metrics.cognitiveComplexity.max,
              cyclomaticMax: d.current.metrics.cyclomaticComplexity.max,
              anyCount: d.current.metrics.typeSafety.anyCount,
            },
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (drifted.length === 0) {
    process.stdout.write(chalk.green('✓ no drift — baseline matches working tree\n'));
    return;
  }

  const cell = (curr: number, delta: number): string => {
    const d = delta === 0 ? ' 0' : delta > 0 ? `+${delta}` : `${delta}`;
    return `${String(curr).padStart(3)} (${d.padStart(3)})`;
  };

  process.stdout.write(chalk.bold(`\n${drifted.length} file(s) drifted\n\n`));
  process.stdout.write(chalk.dim('  dir   cog (Δ)    cyc (Δ)    any (Δ)   file\n'));
  for (const d of drifted) {
    const arrow =
      d.direction === 'degraded' ? chalk.yellow('↑') :
      d.direction === 'improved' ? chalk.green('↓') : chalk.dim('·');
    process.stdout.write(
      `  ${arrow}   ${cell(d.current.metrics.cognitiveComplexity.max, d.deltas.cognitiveMax)}  ` +
        `${cell(d.current.metrics.cyclomaticComplexity.max, d.deltas.cyclomaticMax)}  ` +
        `${cell(d.current.metrics.typeSafety.anyCount, d.deltas.anyCount)}  ${d.file}\n`,
    );
  }
  process.stdout.write(
    '\n' + chalk.dim('Refresh: cerberus refresh-baseline --all-drifted\n'),
  );
}

function runDiff(args: { format?: string }): void {
  const cwd = process.cwd();
  const baseline = loadBaseline(cwd);
  if (!baseline) {
    process.stderr.write(chalk.red('No baseline — run "cerberus baseline" first.\n'));
    process.exit(1);
  }
  const drift = listDrift(cwd);

  const detailed = drift.map((d) => {
    const cogBase = baseline.files[d.file].metrics.cognitiveComplexity.perFunction;
    const cogCurr = d.current.metrics.cognitiveComplexity.perFunction;
    const cycBase = baseline.files[d.file].metrics.cyclomaticComplexity.perFunction;
    const cycCurr = d.current.metrics.cyclomaticComplexity.perFunction;
    const fnNames = new Set([
      ...Object.keys(cogBase),
      ...Object.keys(cogCurr),
      ...Object.keys(cycBase),
      ...Object.keys(cycCurr),
    ]);
    const functions = [...fnNames]
      .map((name) => ({
        name,
        cognitive: {
          baseline: cogBase[name] ?? 0,
          current: cogCurr[name] ?? 0,
          delta: (cogCurr[name] ?? 0) - (cogBase[name] ?? 0),
        },
        cyclomatic: {
          baseline: cycBase[name] ?? 0,
          current: cycCurr[name] ?? 0,
          delta: (cycCurr[name] ?? 0) - (cycBase[name] ?? 0),
        },
      }))
      .filter((f) => f.cognitive.delta !== 0 || f.cyclomatic.delta !== 0)
      .sort((a, b) => Math.abs(b.cognitive.delta) - Math.abs(a.cognitive.delta));
    return { file: d.file, direction: d.direction, functions };
  });

  if (args.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        { schemaVersion: JSON_SCHEMA_VERSION, files: detailed },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (detailed.length === 0) {
    process.stdout.write(chalk.green('✓ no diff — working tree matches baseline\n'));
    return;
  }

  for (const f of detailed) {
    process.stdout.write('\n' + chalk.underline(f.file) + chalk.dim(`  (${f.direction})\n`));
    if (f.functions.length === 0) {
      process.stdout.write(chalk.dim('  (content changed but no per-function metric delta)\n'));
      continue;
    }
    for (const fn of f.functions) {
      const cogD = fn.cognitive.delta;
      const cycD = fn.cyclomatic.delta;
      const tag = (label: string, base: number, curr: number, d: number): string => {
        if (d === 0) return '';
        const sign = d > 0 ? chalk.yellow(`+${d}`) : chalk.green(`${d}`);
        return `${chalk.dim(label)}: ${base}→${curr} (${sign})  `;
      };
      process.stdout.write(
        `  ${chalk.cyan(fn.name)}  ${tag('cog', fn.cognitive.baseline, fn.cognitive.current, cogD)}${tag('cyc', fn.cyclomatic.baseline, fn.cyclomatic.current, cycD)}\n`,
      );
    }
  }
  process.stdout.write('\n');
}

await yargs(hideBin(process.argv))
  .scriptName('cerberus')
  .command(
    'check',
    'Run analyzers against staged files or a single file',
    (y) =>
      y
        .option('file', { type: 'string', describe: 'Analyze a single file' })
        .option('staged', { type: 'boolean', describe: 'Analyze staged files' })
        .option('base', {
          type: 'string',
          describe: 'CI mode: analyze files changed vs. a base ref (e.g. origin/main)',
        })
        .option('mode', {
          choices: ['pre-commit', 'post-edit'] as const,
          describe: 'Enforcement mode (pre-commit counts attempts)',
        })
        .option('format', { choices: ['json', 'human', 'github'] as const, default: 'human' })
        .check((a) => {
          if (!a.file && !a.staged && !a.base) {
            throw new Error('Provide --file <path>, --staged, or --base <ref>');
          }
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
    'Recompute the baseline for one or more files',
    (y) =>
      y
        .option('file', {
          type: 'string',
          array: true,
          describe: 'File(s) to re-baseline (repeatable)',
        })
        .option('all-drifted', {
          type: 'boolean',
          describe: 'Re-baseline every drifted file',
        })
        .option('stdin', {
          type: 'boolean',
          describe: 'Read newline-separated paths from stdin',
        }),
    (a) => runRefreshBaseline(a),
  )
  .command(
    'audit [path]',
    'List the worst files by complexity',
    (y) =>
      y
        .positional('path', { type: 'string', describe: 'Directory to scan (default: cwd)' })
        .option('top', { type: 'number', default: 10, describe: 'How many files to show' })
        .option('format', { choices: ['json', 'human'] as const, default: 'human' }),
    (a) => runAudit(a),
  )
  .command(
    'drift',
    'List files whose content drifted from the baseline',
    (y) => y.option('format', { choices: ['json', 'human'] as const, default: 'human' }),
    (a) => runDrift(a),
  )
  .command(
    'diff',
    'Show per-function deltas between working tree and baseline',
    (y) => y.option('format', { choices: ['json', 'human'] as const, default: 'human' }),
    (a) => runDiff(a),
  )
  .command(
    'doctor',
    'Diagnose config, baseline and hook state',
    (y) =>
      y
        .option('format', { choices: ['json', 'human'] as const, default: 'human' })
        .option('verbose', { type: 'boolean', default: false, describe: 'Show all drifted files' }),
    (a) => runDoctor(a),
  )
  .command(
    'install-hooks',
    'Install the git pre-commit hook and register the Claude Code hook',
    (y) =>
      y.option('dry-run', {
        type: 'boolean',
        describe: 'Print planned action and exit without writing',
      }),
    (a) => runInstallHooks(a),
  )
  .command('claude-hook', false, {}, () => runClaudeHook())
  .command('claude-post-edit-hook', false, {}, () => runClaudePostEditHook())
  .demandCommand(1)
  .strict()
  .help()
  .parseAsync();
