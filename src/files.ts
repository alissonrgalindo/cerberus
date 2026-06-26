import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';

/** Source extensions the gate analyzes: TypeScript and JavaScript (declaration files excluded). */
export const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const DTS_EXT = /\.d\.ts$/;
/** Directories never worth walking regardless of config. */
const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage']);

/** Normalizes an OS path to forward-slash form for glob matching. */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * True if a (posix) relative path lives under a build-output / dependency /
 * VCS directory that's never worth analyzing — generated or vendored code, not
 * something the author wrote. Mirrors the dirs `walkTsFiles` skips so the gate
 * (which reads a staged/changed file list, not a walk) is consistent: a repo
 * that commits its `dist/` bundle shouldn't have the gate grade the bundle.
 */
export function isBuildArtifactPath(relPosixPath: string): boolean {
  return relPosixPath.split('/').some((segment) => ALWAYS_SKIP.has(segment));
}

/** Builds a matcher that returns true when a (posix) relative path matches any ignore glob. */
export function makeIgnoreMatcher(patterns: string[]): (relPosixPath: string) => boolean {
  const isMatch = picomatch(patterns, { dot: true });
  return (relPosixPath: string) => isMatch(relPosixPath);
}

/**
 * True only for a glob that targets a *concrete* file extension — the trailing
 * basename segment must end in `.<ext>` or `.{<ext>,…}` with no wildcard in the
 * extension itself. `**\/*.pen`, `*.png`, `src/**\/*.{woff,woff2}` pass;
 * `**`, `*`, `**\/*`, `**\/*.*`, `secret.env*` do not.
 *
 * This is the gate that keeps `binaryAssets` from becoming a security hole: the
 * list is honored by the (non-bypassable) security tier, so a pattern that
 * could match arbitrary files would let an agent silence the secret scanner by
 * widening it. Restricting to extension globs means the worst a config can do
 * is exempt a specific file *type* — not "everything".
 */
export function isExtensionGlob(pattern: string): boolean {
  const lastSegment = pattern.split('/').pop() ?? pattern;
  return /\.(?:[A-Za-z0-9]+|\{[A-Za-z0-9]+(?:,[A-Za-z0-9]+)*\})$/.test(lastSegment);
}

/**
 * Builds a matcher for the `binaryAssets` list, dropping any entry that isn't a
 * concrete extension glob (warning to stderr so a typo'd pattern isn't silently
 * ignored). Returns a matcher that's always safe to consult from the security
 * tier — it can only ever match by file extension.
 */
export function makeBinaryAssetMatcher(patterns: string[]): (relPosixPath: string) => boolean {
  const safe = patterns.filter((p) => {
    if (isExtensionGlob(p)) return true;
    process.stderr.write(
      `cerberus: ignoring binaryAssets entry "${p}" — only concrete extension globs ` +
        `(e.g. **/*.pen, *.png) are honored, so the secret scanner can't be widened away.\n`,
    );
    return false;
  });
  if (safe.length === 0) return () => false;
  const isMatch = picomatch(safe, { dot: true });
  return (relPosixPath: string) => isMatch(relPosixPath);
}

/** Recursively collects analyzable TS/JS source files under rootDir, honoring ignore globs. */
export function walkTsFiles(rootDir: string, ignore: string[]): string[] {
  const isIgnored = makeIgnoreMatcher(ignore);
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && CODE_EXT.test(entry.name) && !DTS_EXT.test(entry.name)) {
        const rel = toPosix(relative(rootDir, full));
        if (!isIgnored(rel)) out.push(full);
      }
    }
  };

  walk(rootDir);
  return out;
}
