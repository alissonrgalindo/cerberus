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

export type GitHookResult = { hookPath: string; wrapped: boolean; husky: boolean };

/** Husky-managed repos point core.hooksPath at .husky/_; we must edit .husky/pre-commit, not the shims. */
function isHuskyRepo(cwd: string): boolean {
  return existsSync(join(cwd, '.husky', '_')) || existsSync(join(cwd, '.husky', 'pre-commit'));
}

/**
 * Appends the gate to an existing husky pre-commit hook (never touches the
 * .husky/_ shims). Idempotent via the marker; preserves prior commands.
 */
function installHuskyHook(cwd: string): GitHookResult {
  const hookPath = join(cwd, '.husky', 'pre-commit');
  let content = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
  if (content.includes(MARKER)) return { hookPath, wrapped: true, husky: true };

  const hadContent = content.trim().length > 0;
  if (!hadContent) {
    content = '#!/usr/bin/env sh\nset -e\n';
  } else {
    if (!content.endsWith('\n')) content += '\n';
    // `set -e` so any pre-existing command (e.g. lint-staged) still blocks the
    // commit on failure once our gate is appended after it.
    if (!/^\s*set -e\b/m.test(content)) {
      const lines = content.split('\n');
      lines.splice(lines[0].startsWith('#!') ? 1 : 0, 0, 'set -e');
      content = `${lines.join('\n')}`;
      if (!content.endsWith('\n')) content += '\n';
    }
  }

  const block = `${MARKER}\n[ "$QUALITY_GATE_BYPASS" = "1" ] || ${cliInvocation()} check --staged --mode pre-commit --format human || exit 1\n`;
  writeFileSync(hookPath, content + block, { mode: 0o755 });
  return { hookPath, wrapped: hadContent, husky: true };
}

/**
 * Installs (or wraps) a git pre-commit hook that runs the gate on staged files.
 * Detects husky and appends to .husky/pre-commit; otherwise writes to the git
 * hooks dir, backing up and wrapping any pre-existing non-quality-gate hook.
 */
export function installGitHook(cwd: string): GitHookResult {
  if (isHuskyRepo(cwd)) return installHuskyHook(cwd);
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
  return { hookPath, wrapped, husky: false };
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
