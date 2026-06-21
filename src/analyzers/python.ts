import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AnalyzerInput, AnalyzerResult, Violation } from '../types.js';

/**
 * Python analyzers — line/indentation-based (no AST dependency), covering the
 * same agent failure modes as the TypeScript analyzers:
 *
 *   - silent-catch:        `except: pass` / except bodies that only print/log
 *   - injection (security): eval/exec, os.system / subprocess(shell=True) with
 *                           dynamic commands, cursor.execute with f-strings/
 *                           concat/%-format instead of parameterized queries
 *   - hallucinated-import:  import of a package not declared in pyproject.toml /
 *                           requirements*.txt (with stdlib + local-module skips)
 *
 * v1 is presence-based (no per-function baseline); complexity metrics for
 * Python can layer on later. Suppressions mirror the TS analyzers:
 * `# quality-gate-allow: silent-catch` / `injection` / `hallucinated-import`.
 */

const SUPPRESS = (kind: string): RegExp =>
  new RegExp(`(?:cerberus|quality-gate)-allow:\\s*${kind}\\b`);

type Line = { text: string; indent: number; code: string };

function parseLines(content: string): Line[] {
  return content.split('\n').map((text) => {
    const indent = text.length - text.trimStart().length;
    // Strip comments (naive: a # not inside quotes; good enough per-line).
    let code = text;
    let inS: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (inS) {
        if (c === inS && text[i - 1] !== '\\') inS = null;
      } else if (c === '"' || c === "'") {
        inS = c;
      } else if (c === '#') {
        code = text.slice(0, i);
        break;
      }
    }
    return { text, indent, code: code.trimEnd() };
  });
}

function isBlankOrComment(l: Line): boolean {
  return l.code.trim().length === 0;
}

/* ------------------------------------------------------------------ */
/* silent-catch                                                        */
/* ------------------------------------------------------------------ */

const EXCEPT_RE = /^\s*except\b[^:]*:\s*(.*)$/;
const NOOP_STMT = /^(?:pass|\.\.\.)$/;
const LOG_ONLY_STMT = /^(?:print|logging\.\w+|logger\.\w+|log\.\w+)\(.*\)$/;

type PyFinding = { line: number; detail: string };

export function findPySilentCatches(content: string): PyFinding[] {
  const lines = parseLines(content);
  const out: PyFinding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = EXCEPT_RE.exec(lines[i].code);
    if (!m) continue;
    if (SUPPRESS('silent-catch').test(lines[i].text)) continue;

    const indent = lines[i].indent;
    const inline = m[1].trim();
    const body: string[] = [];

    if (inline) {
      body.push(inline); // single-line form: `except Exception: pass`
    } else {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isBlankOrComment(lines[j])) continue;
        if (lines[j].indent <= indent) break;
        body.push(lines[j].code.trim());
      }
    }

    if (body.length === 0) continue;
    const allNoop = body.every((s) => NOOP_STMT.test(s));
    const allLog = body.every((s) => NOOP_STMT.test(s) || LOG_ONLY_STMT.test(s));
    if (allNoop) {
      out.push({ line: i + 1, detail: 'except block swallows the error (pass/...)' });
    } else if (allLog) {
      out.push({ line: i + 1, detail: 'except block only logs — logging is not handling' });
    }
  }
  return out;
}

export async function analyzePySilentCatch(input: AnalyzerInput): Promise<AnalyzerResult> {
  const findings = findPySilentCatches(input.fileContent);
  const violations: Violation[] = findings.map((f) => ({
    analyzer: 'silent-catch',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `${f.detail}. Re-raise (\`raise\`), return a typed error, or hand it to your error reporter. Suppress with \`# quality-gate-allow: silent-catch\` only when ignoring is provably safe.`,
  }));
  return { passed: violations.length === 0, violations, metrics: { silentCatchCount: findings.length } };
}

/* ------------------------------------------------------------------ */
/* injection (security)                                                */
/* ------------------------------------------------------------------ */

/** Heuristics for "this string argument is built dynamically". */
function isDynamicPyArg(rest: string): boolean {
  const arg = rest.trim();
  if (arg.length === 0) return false;
  // f-string with interpolation: f"... {x} ..."
  if (/^(?:rf|fr|f)["'][^"']*\{/i.test(arg)) return true;
  // string concatenation: "..." + x  /  x + "..."
  if (/["']\s*\+/.test(arg) || /\+\s*["']/.test(arg)) return true;
  // %-formatting applied to the string itself: "..." % x
  if (/["']\s*%\s*[\w(]/.test(arg)) return true;
  // .format(...) on the string
  if (/["']\s*\.format\(/.test(arg)) return true;
  // bare variable / attribute as the whole first argument
  if (/^[A-Za-z_][\w.]*\s*[,)]/.test(arg)) return true;
  return false;
}

const PY_INJECTION_SINKS: Array<{
  id: string;
  re: RegExp;
  dynamicOnly: boolean;
  detail: string;
  fix: string;
}> = [
  {
    id: 'eval-exec',
    re: /(?<![\w.])(?:eval|exec)\(\s*(?<rest>[^)].*)$/,
    dynamicOnly: true,
    detail: 'eval()/exec() with dynamic input',
    fix: 'Code injection: replace with a dict lookup, json.loads, ast.literal_eval, or explicit logic.',
  },
  {
    id: 'os-system',
    re: /\bos\.system\(\s*(?<rest>.*)$/,
    dynamicOnly: true,
    detail: 'os.system() with a dynamic command',
    fix: 'Shell injection: use subprocess.run([cmd, *args]) with a list — never interpolate data into a shell string.',
  },
  {
    id: 'subprocess-shell',
    re: /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\(\s*(?<rest>.*shell\s*=\s*True.*)$/,
    dynamicOnly: true,
    detail: 'subprocess with shell=True and a dynamic command',
    fix: 'Shell injection: drop shell=True and pass the command as a list of arguments.',
  },
  {
    id: 'sql-execute',
    re: /\.(?:execute|executemany|executescript)\(\s*(?<rest>.*)$/,
    dynamicOnly: true,
    detail: 'SQL built with f-string/concat/format instead of parameters',
    fix: 'SQL injection: use parameterized queries — cursor.execute("... WHERE id = %s", (id,)) / SQLAlchemy text() with bound params.',
  },
];

export function findPyInjections(content: string): Array<PyFinding & { fix: string }> {
  const lines = parseLines(content);
  const out: Array<PyFinding & { fix: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const { code, text } = lines[i];
    if (!code.trim()) continue;
    if (SUPPRESS('injection').test(text)) continue;

    for (const sink of PY_INJECTION_SINKS) {
      const m = sink.re.exec(code);
      if (!m) continue;
      const rest = m.groups?.rest ?? '';
      if (sink.dynamicOnly && !isDynamicPyArg(rest)) continue;
      out.push({ line: i + 1, detail: sink.detail, fix: sink.fix });
      break; // one finding per line is enough
    }
  }
  return out;
}

export async function analyzePyInjection(input: AnalyzerInput): Promise<AnalyzerResult> {
  const findings = findPyInjections(input.fileContent);
  const violations: Violation[] = findings.map((f) => ({
    analyzer: 'injection',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    severity: 'security',
    suggestion: `${f.detail}. ${f.fix}`,
  }));
  return { passed: violations.length === 0, violations, metrics: { injectionCount: findings.length } };
}

/* ------------------------------------------------------------------ */
/* hallucinated-import                                                 */
/* ------------------------------------------------------------------ */

/** Common stdlib modules (py3.9+). Not exhaustive — unknown names err toward declared deps. */
const PY_STDLIB = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bisect', 'builtins',
  'calendar', 'collections', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal', 'difflib', 'dis', 'email', 'enum',
  'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'functools',
  'gc', 'getpass', 'gettext', 'glob', 'graphlib', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'imaplib', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword',
  'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'math', 'mimetypes', 'mmap',
  'multiprocessing', 'numbers', 'operator', 'os', 'pathlib', 'pdb', 'pickle', 'pkgutil',
  'platform', 'plistlib', 'poplib', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'runpy',
  'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'smtplib', 'socket', 'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics', 'string',
  'stringprep', 'struct', 'subprocess', 'symtable', 'sys', 'sysconfig', 'tarfile', 'tempfile',
  'termios', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib',
  'trace', 'traceback', 'tracemalloc', 'tty', 'types', 'typing', 'unicodedata', 'unittest',
  'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'wsgiref', 'xml',
  'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo', '__future__',
]);

/** import-name → PyPI distribution name, for the usual suspects. */
const PY_IMPORT_ALIASES: Record<string, string> = {
  yaml: 'pyyaml',
  PIL: 'pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  dateutil: 'python-dateutil',
  jose: 'python-jose',
  OpenSSL: 'pyopenssl',
  Crypto: 'pycryptodome',
  fitz: 'pymupdf',
  magic: 'python-magic',
  github: 'pygithub',
  jwt: 'pyjwt',
  attr: 'attrs',
  pkg_resources: 'setuptools',
  serial: 'pyserial',
  websocket: 'websocket-client',
  zmq: 'pyzmq',
  google: 'google-api-python-client',
};

/** PEP 503 normalization: case-insensitive, -/_/. are equivalent. */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Pulls declared dependency names out of pyproject.toml / requirements*.txt content. */
export function extractDeclaredPyDeps(fileName: string, content: string): Set<string> {
  const out = new Set<string>();

  if (/requirements[^/]*\.txt$/.test(fileName)) {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      if (m) out.add(normalizePyName(m[1]));
    }
    return out;
  }

  // pyproject.toml — regex-based (no TOML parser): requirement strings inside
  // arrays ("requests>=2.0") and poetry-style `requests = "^2.0"` keys inside
  // [tool.poetry.*dependencies] tables.
  const reqString = /["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~;[\s]|["'])/g;
  let inDepArray = false;
  let inPoetryDeps = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (/^\[/.test(line)) {
      inPoetryDeps = /^\[tool\.poetry(?:\.group\.[\w-]+)?\.?(?:dev-)?dependencies\]/.test(line);
      inDepArray = false;
      continue;
    }
    if (/^(?:dependencies|optional-dependencies(?:\.[\w-]+)?|requires)\s*=\s*\[/.test(line)) {
      inDepArray = !line.includes(']');
      reqString.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = reqString.exec(line)) !== null) out.add(normalizePyName(m[1]));
      continue;
    }
    if (inDepArray) {
      if (line.includes(']')) inDepArray = false;
      reqString.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = reqString.exec(line)) !== null) out.add(normalizePyName(m[1]));
      continue;
    }
    if (inPoetryDeps) {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      if (m && m[1] !== 'python') out.add(normalizePyName(m[1]));
    }
  }
  return out;
}

const PY_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt'];

function collectPyDeclaredDeps(fromDir: string): { declared: Set<string>; foundManifest: boolean; rootDir: string | null } {
  const declared = new Set<string>();
  let foundManifest = false;
  let rootDir: string | null = null;
  let dir = fromDir;
  for (let i = 0; i < 12; i += 1) {
    for (const name of PY_MANIFESTS) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      foundManifest = true;
      if (!rootDir) rootDir = dir;
      try {
        for (const dep of extractDeclaredPyDeps(name, readFileSync(p, 'utf8'))) declared.add(dep);
      } catch {
        /* unreadable manifest — skip */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { declared, foundManifest, rootDir };
}

function isLocalPyModule(mod: string, fileDir: string, rootDir: string | null): boolean {
  const candidates = [fileDir, rootDir, rootDir ? join(rootDir, 'src') : null].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (existsSync(join(dir, `${mod}.py`))) return true;
    if (existsSync(join(dir, mod, '__init__.py'))) return true;
    if (existsSync(join(dir, mod)) && existsSync(join(dir, mod, '__main__.py'))) return true;
  }
  return false;
}

const IMPORT_RE = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;
const FROM_RE = /^\s*from\s+([\w.]+)\s+import\b/;

export async function analyzePyHallucinatedImport(input: AnalyzerInput): Promise<AnalyzerResult> {
  const absFilePath = isAbsolute(input.filePath) ? input.filePath : resolve(process.cwd(), input.filePath);
  const fileDir = dirname(absFilePath);
  const { declared, foundManifest, rootDir } = collectPyDeclaredDeps(fileDir);

  // No manifest anywhere → analyzing outside a project; stay quiet (mirrors the TS analyzer).
  if (!foundManifest) {
    return { passed: true, violations: [], metrics: { hallucinatedImportCount: 0 } };
  }

  const findings: Array<{ line: number; module: string }> = [];
  const lines = parseLines(input.fileContent);

  const check = (mod: string, lineNo: number): void => {
    const top = mod.split('.')[0];
    if (!top || PY_STDLIB.has(top)) return;
    const dist = PY_IMPORT_ALIASES[top] ?? top;
    if (declared.has(normalizePyName(dist)) || declared.has(normalizePyName(top))) return;
    if (isLocalPyModule(top, fileDir, rootDir)) return;
    findings.push({ line: lineNo, module: top });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const { code, text } = lines[i];
    if (SUPPRESS('hallucinated-import').test(text)) continue;
    const fromM = FROM_RE.exec(code);
    if (fromM) {
      if (!fromM[1].startsWith('.')) check(fromM[1], i + 1);
      continue;
    }
    const impM = IMPORT_RE.exec(code);
    if (impM) {
      for (const mod of impM[1].split(',')) check(mod.trim(), i + 1);
    }
  }

  const violations: Violation[] = findings.map((f) => ({
    analyzer: 'hallucinated-import',
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `Import "${f.module}" is not declared in pyproject.toml/requirements and is not a local module or stdlib. Likely an LLM hallucination — verify the package exists on PyPI (pip index versions ${f.module}) and declare it, or fix the import.`,
  }));

  return {
    passed: violations.length === 0,
    violations,
    metrics: { hallucinatedImportCount: findings.length },
  };
}
