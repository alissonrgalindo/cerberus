/** Git options that consume the following token as their value. */
const VALUE_OPTS = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/;

/** True if a single shell segment invokes `git ... commit` as its subcommand. */
function segmentIsCommit(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const gitIdx = tokens.indexOf('git');
  if (gitIdx === -1) return false;

  let i = gitIdx + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i];
    i += 1;
    if (VALUE_OPTS.test(opt)) i += 1; // skip the option's value (e.g. -C <path>)
  }
  return tokens[i] === 'commit';
}

/**
 * Detects whether a shell command would create a git commit.
 * Splits on shell separators so `git add . && git commit -m x` is caught,
 * while `git log`, `git show` and `git commit-tree` are not.
 */
export function isGitCommit(command: string): boolean {
  return command.split(/&&|\|\||;|\|/).some(segmentIsCommit);
}
