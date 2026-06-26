import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { toPosix } from '../files.js';
import type { SetViolation, Violation } from '../types.js';

/**
 * Detects high-confidence secrets in staged files before they reach the remote.
 * Pre-commit is the last point where you can cancel a leak without a force-push
 * and a key rotation.
 *
 * We are conservative on purpose: each pattern has a distinctive prefix and a
 * length floor, so generic "looks like base64" matches don't blow up the gate.
 * False negatives on home-grown formats are accepted in exchange for ~zero
 * false positives on the patterns below.
 *
 *   - OpenAI / Anthropic API keys:  sk-…  /  sk-ant-…
 *   - GitHub personal tokens:       ghp_… / gho_… / ghu_… / ghs_… / ghr_…
 *   - Slack tokens:                 xox[abprso]-…
 *   - AWS access key id:            AKIA…  (uppercase + digits, 20 chars total)
 *   - Google API keys:              AIza… (39 chars)
 *   - JWT-ish in source:            eyJ…  followed by a second base64 segment
 *
 * Plus: any file whose basename is exactly `.env` (or `.env.<anything>` that
 * is not `.env.example` / `.env.sample` / `.env.template`) is flagged at L1 —
 * env files should never be committed regardless of contents.
 *
 * Suppression: a `// cerberus-allow: secret` (or `# cerberus-allow: secret`)
 * line comment on the same line as the match skips it. The legacy
 * `quality-gate-allow` spelling is still accepted. Use this for test fixtures
 * with intentionally-fake-but-shaped tokens.
 */

const SUPPRESSION = /(?:cerberus|quality-gate)-allow:\s*secret\b/;

type Pattern = { id: string; regex: RegExp; describe: (m: RegExpMatchArray) => string };

const PATTERNS: Pattern[] = [
  {
    id: 'anthropic-key',
    regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
    describe: () => 'Anthropic API key',
  },
  {
    id: 'openai-key',
    regex: /\bsk-(?!ant-)[A-Za-z0-9_\-]{20,}\b/g,
    describe: () => 'OpenAI-style API key (sk-…)',
  },
  {
    id: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    describe: (m) => `GitHub token (${m[0].slice(0, 4)}…)`,
  },
  {
    id: 'slack-token',
    regex: /\bxox[abprso]-[A-Za-z0-9-]{10,}\b/g,
    describe: (m) => `Slack token (${m[0].slice(0, 5)}…)`,
  },
  {
    id: 'aws-access-key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    describe: () => 'AWS access key id',
  },
  {
    id: 'google-api-key',
    regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g,
    describe: () => 'Google API key',
  },
  {
    id: 'jwt',
    regex: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    describe: () => 'JWT in source',
  },
  {
    id: 'stripe-live-key',
    regex: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g,
    describe: () => 'Stripe live key',
  },
  {
    id: 'stripe-webhook-secret',
    regex: /\bwhsec_[A-Za-z0-9]{24,}\b/g,
    describe: () => 'Stripe webhook signing secret',
  },
  {
    id: 'npm-token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    describe: () => 'npm access token',
  },
  {
    id: 'gitlab-token',
    regex: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g,
    describe: () => 'GitLab personal access token',
  },
  {
    id: 'private-key-pem',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    describe: () => 'Private key (PEM block)',
  },
  {
    id: 'connection-string',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/([^\s:@/'"]+):([^\s@/'"]+)@/g,
    describe: () => 'Connection string with embedded credentials',
  },
];

/**
 * Placeholder passwords in connection strings that are documentation, not
 * leaks: postgres://user:password@…, …:<password>@…, …:${DB_PASS}@…
 */
const PLACEHOLDER_PASSWORD =
  /^(?:pass(?:word)?|pwd|secret|changeme|example|xxx+|\*{3,}|<[^>]*>|\{\{[^}]*\}\}|\$\{[^}]*\}|\$[A-Z_]+|%[a-zA-Z_]+%?)$/i;

const ENV_FILE_RE = /^\.env(\.|$)/;
const ENV_ALLOWLIST = /\.(example|sample|template|dist)$/i;

function lineOf(content: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function isSuppressed(content: string, idx: number): boolean {
  // Find end of the current line and check for the suppression marker on it.
  let end = idx;
  while (end < content.length && content[end] !== '\n') end += 1;
  let start = idx;
  while (start > 0 && content[start - 1] !== '\n') start -= 1;
  return SUPPRESSION.test(content.slice(start, end));
}

/**
 * True for a committed env file (`.env`, `.env.production`, …) that isn't a
 * documented template (`.env.example`/`.sample`/`.template`/`.dist`). Exported
 * so the security tier can guarantee env files are scanned even if a config
 * lists their extension under `binaryAssets` — they're the single most
 * sensitive file to leak, never exemptable.
 */
export function isEnvFile(name: string): boolean {
  if (!ENV_FILE_RE.test(name)) return false;
  if (ENV_ALLOWLIST.test(name)) return false;
  return true;
}

/** Default content source: the working tree. Pre-commit passes a staged-blob reader. */
function readFromDisk(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

export function analyzeSecretInDiff(
  files: string[],
  cwd: string,
  readContent: (abs: string) => string | null = readFromDisk,
): SetViolation[] {
  const out: SetViolation[] = [];

  for (const abs of files) {
    const rel = toPosix(relative(cwd, abs));
    const name = basename(abs);

    if (isEnvFile(name)) {
      const violation: Violation = {
        analyzer: 'secret-in-diff',
        location: `${rel}:1`,
        current: 1,
        threshold: 0,
        severity: 'security',
        suggestion: `\`${name}\` should not be committed. Add it to .gitignore and use \`.env.example\` for documented defaults. If this was an accident, run \`git rm --cached ${rel}\` before re-committing.`,
      };
      out.push({ file: rel, violation });
      continue;
    }

    const content = readContent(abs);
    if (content === null) continue;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(content)) !== null) {
        if (isSuppressed(content, m.index)) continue;
        if (pattern.id === 'connection-string' && m[2] && PLACEHOLDER_PASSWORD.test(m[2])) continue;
        const violation: Violation = {
          analyzer: 'secret-in-diff',
          location: `${rel}:${lineOf(content, m.index)}`,
          current: 1,
          threshold: 0,
          severity: 'security',
          suggestion: `${pattern.describe(m)} detected. Rotate the credential immediately (it's effectively public the moment a commit lands), move it to your secret manager / .env (gitignored), and reference via process.env. Suppress per-line with \`// cerberus-allow: secret\` for test fixtures.`,
        };
        out.push({ file: rel, violation });
      }
    }
  }

  return out;
}
