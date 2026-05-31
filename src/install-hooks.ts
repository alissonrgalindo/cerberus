import { execaSync } from 'execa';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MARKER = '# quality-gate-hook';

/** Resolves the git hooks directory, honoring core.hooksPath. */
function gitHooksDir(cwd: string): string {
  const { stdout } = execaSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd });
  return resolve(cwd, stdout.trim());
}

/** How the hooks should invoke this CLI — absolute path to the running bundle. */
export function cliInvocation(): string {
  return `node "${process.argv[1]}"`;
}

export type GitHookResult = { hookPath: string; wrapped: boolean };

/**
 * Installs (or wraps) a git pre-commit hook that runs the gate on staged files.
 * If a non-quality-gate hook already exists, it is backed up and called first.
 */
export function installGitHook(cwd: string): GitHookResult {
  const hooksDir = gitHooksDir(cwd);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');

  let preamble = '';
  let wrapped = false;
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.includes(MARKER)) {
      const backup = join(hooksDir, 'pre-commit.backup-quality-gate');
      renameSync(hookPath, backup);
      chmodSync(backup, 0o755);
      preamble = `if [ -x "${backup}" ]; then\n  "${backup}" "$@" || exit $?\nfi\n`;
      wrapped = true;
    }
  }

  const content = `#!/usr/bin/env sh
${MARKER}
[ "$QUALITY_GATE_BYPASS" = "1" ] && exit 0
${preamble}${cliInvocation()} check --staged --mode pre-commit --format human
`;
  writeFileSync(hookPath, content, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return { hookPath, wrapped };
}

/**
 * Registers a Claude Code PreToolUse(Bash) hook in the project's
 * `.claude/settings.json`, merging without clobbering existing hooks.
 */
export function registerClaudeHook(cwd: string): string {
  const claudeDir = join(cwd, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const preToolUse = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];

  const command = `${cliInvocation()} claude-hook`;
  const alreadyRegistered = JSON.stringify(preToolUse).includes('claude-hook');
  if (!alreadyRegistered) {
    preToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command }],
    });
  }

  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}
