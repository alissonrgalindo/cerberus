/** Git options that consume the following token as their value. */
const VALUE_OPTS = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/;

/**
 * True if a token invokes git, allowing for a path-qualified binary
 * (`/usr/bin/git`, `..\\git.exe`) and a leading subshell/negation char
 * (`(git`, `{git`, `!git`). An agent that writes `/usr/bin/git commit` or
 * `(git commit …)` must not slip past the hook.
 */
function tokenIsGit(token: string): boolean {
  const stripped = token.replace(/^[!(){]+/, '');
  const base = stripped.split(/[/\\]/).pop() ?? stripped;
  return base === 'git' || base === 'git.exe';
}

/** True if a single shell segment invokes `git ... commit` as its subcommand. */
function segmentIsCommit(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  // Check EVERY git occurrence in the segment, not just the first: a segment
  // may chain commands the splitter doesn't recognize (e.g. `command git …`,
  // or a subshell), so the commit may not follow the first `git` token.
  for (let g = 0; g < tokens.length; g += 1) {
    if (!tokenIsGit(tokens[g])) continue;
    let i = g + 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const opt = tokens[i];
      i += 1;
      if (VALUE_OPTS.test(opt)) i += 1; // skip the option's value (e.g. -C <path>)
    }
    if (tokens[i] === 'commit') return true;
  }
  return false;
}

/**
 * Detects whether a shell command would create a git commit.
 * Splits on shell separators — including newlines and `&` — so a multi-line
 * `git add .\ngit commit -m x`, a backgrounded `git commit &`, and
 * `git add . && git commit -m x` are all caught, while `git log`, `git show`
 * and `git commit-tree` are not.
 */
export function isGitCommit(command: string): boolean {
  return command.split(/&&|\|\||[;|&\n\r]/).some(segmentIsCommit);
}
