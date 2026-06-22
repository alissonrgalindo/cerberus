import { execaSync } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { toPosix } from '../files.js';
import { extractDeclaredPyDeps } from './python.js';
import type { SetViolation, Violation } from '../types.js';

/**
 * Guards against slopsquatting: an LLM agent "fixes" a hallucinated import by
 * adding the invented package to package.json. The import then resolves on
 * paper, but the package is either nonexistent or — worse — a malicious
 * squat registered by someone who predicted the hallucination.
 *
 * Heuristic: every dependency name that is NEW in a staged package.json
 * (vs. the committed version) must already have an entry in a lockfile
 * (pnpm-lock.yaml / package-lock.json / yarn.lock / bun.lock). A lockfile
 * entry means a registry actually resolved the package during install. A new
 * dep with no lockfile entry means nobody ran an install — the name was
 * written straight into the manifest, which is exactly the slopsquatting
 * signature.
 *
 * No lockfile in the project at all → no-op (nothing to verify against).
 */

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'];
const PY_LOCKFILES = ['poetry.lock', 'uv.lock', 'pdm.lock', 'Pipfile.lock'];

const DEP_BLOCKS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

type PkgJson = Partial<Record<(typeof DEP_BLOCKS)[number], Record<string, string>>>;

function depNames(pkg: PkgJson): Set<string> {
  const out = new Set<string>();
  for (const block of DEP_BLOCKS) {
    const deps = pkg[block];
    if (deps) for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function parsePkg(content: string): PkgJson | null {
  try {
    return JSON.parse(content) as PkgJson;
  } catch {
    return null;
  }
}

/** Committed (HEAD) content of a file, or null when it's new/unreadable. */
function headContent(cwd: string, relPath: string): string | null {
  try {
    const { stdout } = execaSync('git', ['show', `HEAD:${relPath}`], { cwd });
    return stdout;
  } catch {
    return null;
  }
}

/** Finds the nearest lockfile walking up from `fromDir` (monorepo: root lockfile). */
function findLockfiles(fromDir: string, names: string[] = LOCKFILES): string[] {
  const found: string[] = [];
  let dir = fromDir;
  for (let i = 0; i < 12; i += 1) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) found.push(p);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Cheap containment check that works across lockfile formats:
 *   pnpm-lock.yaml:     /name@1.2.3  or  'name':  or  name: (specifiers/importers)
 *   package-lock.json:  "node_modules/name"
 *   yarn.lock:          name@^1.2.3:
 */
function lockfileHasPackage(lockContent: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`['"/]${escaped}['"@]`), // '/name@', '"name"', "'name'", '"name@'
    new RegExp(`^\\s*${escaped}@`, 'm'), // yarn: name@^1.0.0:
    new RegExp(`^\\s*['"]?${escaped}['"]?:`, 'm'), // pnpm/yaml: name: or 'name':
  ];
  return patterns.some((re) => re.test(lockContent));
}

/** Default content source: the working tree. Pre-commit passes a staged-blob reader. */
function readFromDisk(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** New deps in a staged pyproject.toml must have an entry in a Python lockfile. */
function analyzePyManifest(
  abs: string,
  cwd: string,
  readContent: (abs: string) => string | null,
): SetViolation[] {
  const out: SetViolation[] = [];
  const rel = toPosix(relative(cwd, abs));

  const currentRaw = readContent(abs);
  if (currentRaw === null) return out;
  const current = extractDeclaredPyDeps('pyproject.toml', currentRaw);
  const head = headContent(cwd, rel);
  const before = head ? extractDeclaredPyDeps('pyproject.toml', head) : new Set<string>();
  const added = [...current].filter((n) => !before.has(n));
  if (added.length === 0) return out;

  const lockfiles = findLockfiles(dirname(abs), PY_LOCKFILES);
  if (lockfiles.length === 0) return out; // nothing to verify against

  const lockContents = lockfiles.map((p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  });

  for (const name of added) {
    // poetry.lock / uv.lock / pdm.lock store `name = "pkg"`; Pipfile.lock keys are quoted.
    // PEP 503: -, _ and . are interchangeable in names, so match any of them.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-_.]');
    const re = new RegExp(`(?:name\\s*=\\s*["']|["'])${escaped}["']`, 'i');
    const inLock = lockContents.some((c) => re.test(c));
    if (inLock) continue;
    out.push({
      file: rel,
      violation: {
        analyzer: 'new-dependency',
        location: `${rel}:1`,
        current: 1,
        threshold: 0,
        severity: 'security',
        suggestion:
          `New dependency "${name}" was added to ${rel} but has no lockfile entry (poetry.lock/uv.lock/pdm.lock). ` +
          `Possible hallucinated/squatted package. Verify it on PyPI (pip index versions ${name}), run your installer so the lockfile resolves it, and stage the lockfile.`,
      },
    });
  }
  return out;
}

export function analyzeNewDependency(
  stagedFiles: string[],
  cwd: string,
  readContent: (abs: string) => string | null = readFromDisk,
): SetViolation[] {
  const out: SetViolation[] = [];
  const manifests = stagedFiles.filter((f) => basename(f) === 'package.json');
  const pyManifests = stagedFiles.filter((f) => basename(f) === 'pyproject.toml');
  for (const abs of pyManifests) out.push(...analyzePyManifest(abs, cwd, readContent));

  for (const abs of manifests) {
    const rel = toPosix(relative(cwd, abs));

    const currentRaw = readContent(abs);
    if (currentRaw === null) continue;
    const current = parsePkg(currentRaw);
    if (!current) continue;

    const head = headContent(cwd, rel);
    const previous = head ? (parsePkg(head) ?? {}) : {}; // new manifest: every dep is "new"
    const before = depNames(previous);
    const added = [...depNames(current)].filter((n) => !before.has(n));
    if (added.length === 0) continue;

    const lockfiles = findLockfiles(dirname(abs));
    if (lockfiles.length === 0) continue; // nothing to verify against — stay quiet

    const lockContents = lockfiles.map((p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    });

    for (const name of added) {
      const inLock = lockContents.some((c) => lockfileHasPackage(c, name));
      if (inLock) continue;
      const violation: Violation = {
        analyzer: 'new-dependency',
        location: `${rel}:1`,
        current: 1,
        threshold: 0,
        severity: 'security',
        suggestion:
          `New dependency "${name}" was added to ${rel} but has no lockfile entry. ` +
          `This is the slopsquatting signature: a hallucinated package name written straight into the manifest. ` +
          `Verify the package exists and is the one you mean (npm view ${name}), run your package manager's install so the lockfile resolves it, and stage the lockfile.`,
      };
      out.push({ file: rel, violation });
    }
  }

  return out;
}
