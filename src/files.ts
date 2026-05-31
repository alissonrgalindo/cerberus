import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const DTS_EXT = /\.d\.ts$/;
/** Directories never worth walking regardless of config. */
const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage']);

/** Normalizes an OS path to forward-slash form for glob matching. */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Builds a matcher that returns true when a (posix) relative path matches any ignore glob. */
export function makeIgnoreMatcher(patterns: string[]): (relPosixPath: string) => boolean {
  const isMatch = picomatch(patterns, { dot: true });
  return (relPosixPath: string) => isMatch(relPosixPath);
}

/** Recursively collects analyzable TS/TSX files under rootDir, honoring ignore globs. */
export function walkTsFiles(rootDir: string, ignore: string[]): string[] {
  const isIgnored = makeIgnoreMatcher(ignore);
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && TS_EXT.test(entry.name) && !DTS_EXT.test(entry.name)) {
        const rel = toPosix(relative(rootDir, full));
        if (!isIgnored(rel)) out.push(full);
      }
    }
  };

  walk(rootDir);
  return out;
}
