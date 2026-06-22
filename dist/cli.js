#!/usr/bin/env node

// src/cli.ts
import { existsSync as existsSync11, readFileSync as readFileSync15 } from "fs";
import { isAbsolute as isAbsolute3, relative as relative7, resolve as resolve6 } from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import chalk2 from "chalk";

// src/analyzers/cognitive-complexity.ts
import { getSourceOutput } from "cognitive-complexity-ts";

// src/types.ts
var SECURITY_ANALYZERS = /* @__PURE__ */ new Set([
  "secret-in-diff",
  "migration-safety",
  "injection",
  "new-dependency"
]);
function isSecurityViolation(v) {
  return v.severity === "security" || SECURITY_ANALYZERS.has(v.analyzer);
}
function baselineKey(fn) {
  return fn.name === "<anonymous>" ? `${fn.name}:${fn.line}` : fn.name;
}
function functionBaselineFloor(name, perFunction, baselineMax, fallback) {
  return name === "<anonymous>" ? baselineMax : perFunction?.[name] ?? fallback;
}
function fileTypeFromPath(filePath) {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".mts")) return "mts";
  if (filePath.endsWith(".cts")) return "cts";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".mjs")) return "mjs";
  if (filePath.endsWith(".cjs")) return "cjs";
  if (filePath.endsWith(".js")) return "js";
  return "ts";
}
var JS_FILE_TYPES = /* @__PURE__ */ new Set(["js", "jsx", "mjs", "cjs"]);

// src/analyzers/cognitive-complexity.ts
function flattenScores(nodes, out) {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.kind !== "file") {
      out.push({
        name: node.name && node.name.length > 0 ? node.name : "<anonymous>",
        line: node.line ?? 0,
        score: node.score ?? 0
      });
    }
    flattenScores(node.inner, out);
  }
}
function measureCognitive(filePath, fileContent) {
  const report = getSourceOutput(fileContent, filePath);
  const flat = [];
  flattenScores(report.inner, flat);
  return flat;
}
async function analyzeCognitive(input) {
  const flat = measureCognitive(input.filePath, input.fileContent);
  const threshold = input.fileType === "tsx" ? input.config.tsxOverrides.cognitiveComplexity : input.config.thresholds.cognitiveComplexity;
  const perFunctionBaseline = input.fileBaseline?.metrics.cognitiveComplexity.perFunction;
  const baselineMax = input.fileBaseline?.metrics.cognitiveComplexity.max ?? 0;
  const violations = [];
  for (const fn of flat) {
    const baseline = functionBaselineFloor(fn.name, perFunctionBaseline, baselineMax, threshold);
    if (fn.score > threshold && fn.score > baseline) {
      violations.push({
        analyzer: "cognitive-complexity",
        location: `${fn.name}:${fn.line}`,
        current: fn.score,
        threshold,
        baseline: perFunctionBaseline ? baseline : void 0,
        delta: perFunctionBaseline ? fn.score - baseline : void 0,
        suggestion: `Function "${fn.name}" has cognitive complexity ${fn.score} (limit ${threshold}). Extract guard clauses and nested branches into helpers.`
      });
    }
  }
  const max = flat.reduce((m, f) => Math.max(m, f.score), 0);
  return {
    passed: violations.length === 0,
    violations,
    metrics: { cognitiveComplexityMax: max }
  };
}

// src/analyzers/coverage-delta.ts
import { execaSync } from "execa";
import { existsSync, readFileSync } from "fs";
import { join as join2, relative as relative2 } from "path";

// src/files.ts
import { readdirSync } from "fs";
import { join, relative, sep } from "path";
import picomatch from "picomatch";
var CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
var DTS_EXT = /\.d\.ts$/;
var ALWAYS_SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", ".next", ".turbo", "coverage"]);
function toPosix(p) {
  return p.split(sep).join("/");
}
function isBuildArtifactPath(relPosixPath) {
  return relPosixPath.split("/").some((segment) => ALWAYS_SKIP.has(segment));
}
function makeIgnoreMatcher(patterns) {
  const isMatch = picomatch(patterns, { dot: true });
  return (relPosixPath) => isMatch(relPosixPath);
}
function walkTsFiles(rootDir, ignore) {
  const isIgnored = makeIgnoreMatcher(ignore);
  const out = [];
  const walk = (dir) => {
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

// src/analyzers/coverage-delta.ts
var VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vite.config.ts",
  "vite.config.js"
];
function hasVitest(cwd) {
  if (VITEST_CONFIGS.some((f) => existsSync(join2(cwd, f)))) return true;
  const pkgPath = join2(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      return Boolean(pkg.dependencies?.vitest || pkg.devDependencies?.vitest);
    } catch {
      return false;
    }
  }
  return false;
}
function parseCoverageSummary(summaryPath, cwd) {
  const map = /* @__PURE__ */ new Map();
  const json = JSON.parse(readFileSync(summaryPath, "utf8"));
  for (const [abs, data] of Object.entries(json)) {
    if (abs === "total") continue;
    const pct = data?.lines?.pct;
    if (typeof pct === "number") map.set(toPosix(relative2(cwd, abs)), pct);
  }
  return map;
}
function compareCoverage(currentByFile, baseline, relFiles, config) {
  const out = [];
  const allowedDrop = config.thresholds.coverageDelta;
  for (const rel of relFiles) {
    const current = currentByFile.get(rel);
    if (current === void 0) continue;
    const base = baseline?.files[rel]?.metrics.coverage.percent ?? 0;
    if (base <= 0) continue;
    if (current < base - allowedDrop) {
      out.push({
        file: rel,
        violation: {
          analyzer: "coverage",
          location: rel,
          current: Math.round(current),
          threshold: Math.round(base - allowedDrop),
          baseline: Math.round(base),
          delta: Math.round(current - base),
          suggestion: `Coverage dropped from ${base.toFixed(1)}% to ${current.toFixed(1)}%. Add tests for the new code paths.`
        }
      });
    }
  }
  return out;
}
function collectCoverageForBaseline(cwd, timeoutMs) {
  const summary = join2(cwd, "coverage", "coverage-summary.json");
  try {
    if (existsSync(summary)) return parseCoverageSummary(summary, cwd);
    if (!hasVitest(cwd)) return null;
    execaSync("npx", ["vitest", "run", "--coverage", "--coverage.reporter=json-summary"], {
      cwd,
      reject: false,
      timeout: timeoutMs,
      stdio: "ignore"
    });
    if (!existsSync(summary)) return null;
    return parseCoverageSummary(summary, cwd);
  } catch {
    return null;
  }
}
async function analyzeCoverage(relFiles, cwd, baseline, config) {
  if (!hasVitest(cwd)) return { violations: [], skipped: true, reason: "no vitest config detected" };
  try {
    execaSync(
      "npx",
      ["vitest", "run", "--coverage", "--coverage.reporter=json-summary", "--changed=HEAD"],
      { cwd, reject: false, timeout: config.preCommit.timeoutMs, stdio: "ignore" }
    );
    const summary = join2(cwd, "coverage", "coverage-summary.json");
    if (!existsSync(summary)) return { violations: [], skipped: true, reason: "no coverage summary produced" };
    const current = parseCoverageSummary(summary, cwd);
    return { violations: compareCoverage(current, baseline, relFiles, config), skipped: false };
  } catch (err) {
    return { violations: [], skipped: true, reason: `coverage skipped: ${err.message}` };
  }
}

// src/analyzers/cyclomatic-complexity.ts
import { Node, SyntaxKind } from "ts-morph";

// src/analyzers/ts-project.ts
import { createHash } from "crypto";
import { Project, ts } from "ts-morph";
var sharedProject = null;
var cache = /* @__PURE__ */ new Map();
function getProject() {
  if (!sharedProject) {
    sharedProject = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ESNext
      }
    });
  }
  return sharedProject;
}
function createSourceFile(filePath, content) {
  const hash = createHash("sha1").update(content).digest("hex");
  const cached = cache.get(filePath);
  if (cached && cached.hash === hash) return cached.sourceFile;
  const sourceFile = getProject().createSourceFile(filePath, content, { overwrite: true });
  cache.set(filePath, { hash, sourceFile });
  return sourceFile;
}

// src/analyzers/cyclomatic-complexity.ts
var FUNCTION_LIKE_KINDS = /* @__PURE__ */ new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor
]);
var DECISION_KINDS = /* @__PURE__ */ new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.CatchClause
]);
var LOGICAL_TOKENS = /* @__PURE__ */ new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken
]);
function isFunctionLike(node) {
  return FUNCTION_LIKE_KINDS.has(node.getKind());
}
function countDecisions(fn) {
  let count = 0;
  fn.forEachDescendant((node, traversal) => {
    if (node !== fn && isFunctionLike(node)) {
      traversal.skip();
      return;
    }
    const kind = node.getKind();
    if (DECISION_KINDS.has(kind)) {
      count += 1;
    } else if (Node.isBinaryExpression(node) && LOGICAL_TOKENS.has(node.getOperatorToken().getKind())) {
      count += 1;
    }
  });
  return count;
}
function functionName(fn) {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    const name = fn.getName();
    if (name) return name;
  }
  if (Node.isConstructorDeclaration(fn)) return "constructor";
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return "<anonymous>";
}
function measureCyclomatic(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  return sourceFile.getDescendants().filter(isFunctionLike).map((fn) => ({
    name: functionName(fn),
    line: fn.getStartLineNumber(),
    score: 1 + countDecisions(fn)
  }));
}
async function analyzeCyclomatic(input) {
  const functions = measureCyclomatic(input.filePath, input.fileContent);
  const threshold = input.config.thresholds.cyclomaticComplexity;
  const perFunctionBaseline = input.fileBaseline?.metrics.cyclomaticComplexity.perFunction;
  const baselineMax = input.fileBaseline?.metrics.cyclomaticComplexity.max ?? 0;
  const violations = [];
  let max = 0;
  for (const fn of functions) {
    max = Math.max(max, fn.score);
    const baseline = functionBaselineFloor(fn.name, perFunctionBaseline, baselineMax, threshold);
    if (fn.score > threshold && fn.score > baseline) {
      violations.push({
        analyzer: "cyclomatic-complexity",
        location: `${fn.name}:${fn.line}`,
        current: fn.score,
        threshold,
        baseline: perFunctionBaseline ? baseline : void 0,
        delta: perFunctionBaseline ? fn.score - baseline : void 0,
        suggestion: `Function "${fn.name}" has cyclomatic complexity ${fn.score} (limit ${threshold}). Reduce branching or split into smaller functions.`
      });
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    metrics: { cyclomaticComplexityMax: max }
  };
}

// src/analyzers/duplication.ts
import { execaSync as execaSync2 } from "execa";
import { existsSync as existsSync2, mkdtempSync, readFileSync as readFileSync2, rmSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join as join3, relative as relative3 } from "path";
var TS_EXT = /\.(ts|tsx|mts|cts)$/;
var DTS_EXT2 = /\.d\.ts$/;
function jscpdBin() {
  const require2 = createRequire(import.meta.url);
  let dir = dirname(require2.resolve("jscpd"));
  for (let i = 0; i < 6; i += 1) {
    const pkg = join3(dir, "package.json");
    if (existsSync2(pkg)) {
      try {
        if (JSON.parse(readFileSync2(pkg, "utf8")).name === "jscpd") {
          return join3(dir, "bin", "jscpd");
        }
      } catch {
      }
    }
    dir = dirname(dir);
  }
  throw new Error("jscpd binary not found");
}
function analyzeDuplication(files, cwd, config) {
  const tsFiles = files.filter((f) => TS_EXT.test(f) && !DTS_EXT2.test(f));
  if (tsFiles.length === 0) return [];
  const minLines = config.thresholds.duplicationLines;
  const outDir = mkdtempSync(join3(tmpdir(), "qg-jscpd-"));
  try {
    execaSync2(
      "node",
      [
        jscpdBin(),
        "--silent",
        "--reporters",
        "json",
        "--output",
        outDir,
        "--min-lines",
        String(minLines),
        "--mode",
        "strict",
        "--absolute",
        ...tsFiles
      ],
      { cwd, reject: false, timeout: 3e4 }
    );
    const report = JSON.parse(readFileSync2(join3(outDir, "jscpd-report.json"), "utf8"));
    const out = [];
    for (const dup of report.duplicates ?? []) {
      const lines = dup.lines ?? 0;
      if (lines < minLines) continue;
      const firstRel = dup.firstFile?.name ? toPosix(relative3(cwd, dup.firstFile.name)) : "?";
      const secondRel = dup.secondFile?.name ? toPosix(relative3(cwd, dup.secondFile.name)) : "?";
      const violation = {
        analyzer: "duplication",
        location: `${firstRel}:${dup.firstFile?.start ?? "?"}`,
        current: lines,
        threshold: minLines,
        suggestion: `${lines} duplicated lines shared with ${secondRel}. Extract the block into a shared helper.`
      };
      out.push({ file: firstRel, violation });
    }
    return out;
  } catch {
    return [];
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// src/analyzers/migration-safety.ts
import { readFileSync as readFileSync3 } from "fs";
import { relative as relative4 } from "path";
var SQL_EXT = /\.sql$/i;
var PATTERNS = [
  {
    id: "drop-column",
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    describe: (m) => `DROP COLUMN ${m[1]}.${m[2]}`,
    suggestion: "Dropping a column is irreversible and breaks any deployed code still reading it. Run a two-step: (1) stop writing/reading the column and deploy, (2) drop the column in a later migration."
  },
  {
    id: "drop-table",
    regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
    describe: (m) => `DROP TABLE ${m[1]}`,
    suggestion: "Dropping a table is irreversible. Confirm no service reads it, archive the data, and consider RENAME-then-DROP across two deploys."
  },
  {
    id: "rename-column",
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+RENAME\s+(?:COLUMN\s+)?["'`]?(\w+)["'`]?\s+TO\s+["'`]?(\w+)["'`]?/gi,
    describe: (m) => `RENAME COLUMN ${m[1]}.${m[2]} \u2192 ${m[3]}`,
    suggestion: "Renaming a column breaks every reader until redeploy. Add the new column, dual-write, migrate readers, then drop the old one."
  },
  {
    id: "rename-table",
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+RENAME\s+TO\s+["'`]?(\w+)["'`]?/gi,
    describe: (m) => `RENAME TABLE ${m[1]} \u2192 ${m[2]}`,
    suggestion: "Renaming a table breaks every reader until redeploy. Create a view aliasing the old name during the transition, or use a two-step deploy."
  },
  {
    id: "alter-type",
    regex: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+ALTER\s+COLUMN\s+["'`]?(\w+)["'`]?\s+(?:SET\s+DATA\s+)?TYPE\s+/gi,
    describe: (m) => `ALTER COLUMN TYPE ${m[1]}.${m[2]}`,
    suggestion: "Changing a column type can fail mid-flight on incompatible values and may rewrite the whole table. Add a new typed column and backfill."
  }
];
var SET_NOT_NULL_RE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+ALTER\s+COLUMN\s+["'`]?(\w+)["'`]?\s+SET\s+NOT\s+NULL/gi;
function findSetNotNullWithoutDefault(sql) {
  const out = [];
  let m;
  while ((m = SET_NOT_NULL_RE.exec(sql)) !== null) {
    const line = lineOf(sql, m.index);
    const tail = sql.slice(m.index, m.index + 400);
    const stmt = tail.split(";")[0] ?? tail;
    const hasDefault = new RegExp(
      `ALTER\\s+COLUMN\\s+["'\`]?${m[2]}["'\`]?\\s+SET\\s+DEFAULT`,
      "i"
    ).test(stmt);
    if (!hasDefault) out.push({ line, describe: `SET NOT NULL ${m[1]}.${m[2]} (no DEFAULT)` });
  }
  return out;
}
function lineOf(content, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}
function readFromDisk(abs) {
  try {
    return readFileSync3(abs, "utf8");
  } catch {
    return null;
  }
}
function analyzeMigrationSafety(files, cwd, readContent = readFromDisk) {
  const sqlFiles = files.filter((f) => SQL_EXT.test(f));
  if (sqlFiles.length === 0) return [];
  const out = [];
  for (const abs of sqlFiles) {
    const sql = readContent(abs);
    if (sql === null) continue;
    const rel = toPosix(relative4(cwd, abs));
    const cleaned = sql.replace(/--.*$/gm, "");
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m;
      while ((m = pattern.regex.exec(cleaned)) !== null) {
        const violation = {
          analyzer: "migration-safety",
          location: `${rel}:${lineOf(cleaned, m.index)}`,
          current: 1,
          threshold: 0,
          severity: "security",
          suggestion: `${pattern.describe(m)}. ${pattern.suggestion}`
        };
        out.push({ file: rel, violation });
      }
    }
    for (const f of findSetNotNullWithoutDefault(cleaned)) {
      const violation = {
        analyzer: "migration-safety",
        location: `${rel}:${f.line}`,
        current: 1,
        threshold: 0,
        severity: "security",
        suggestion: `${f.describe}. Existing NULL rows will fail the constraint. Add a DEFAULT in the same ALTER or backfill in a prior migration.`
      };
      out.push({ file: rel, violation });
    }
  }
  return out;
}

// src/analyzers/new-dependency.ts
import { execaSync as execaSync3 } from "execa";
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "fs";
import { basename, dirname as dirname3, join as join5, relative as relative5 } from "path";

// src/analyzers/python.ts
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "fs";
import { dirname as dirname2, isAbsolute, join as join4, resolve } from "path";
var SUPPRESS = (kind) => new RegExp(`(?:cerberus|quality-gate)-allow:\\s*${kind}\\b`);
function parseLines(content) {
  return content.split("\n").map((text) => {
    const indent = text.length - text.trimStart().length;
    let code = text;
    let inS = null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (inS) {
        if (c === inS && text[i - 1] !== "\\") inS = null;
      } else if (c === '"' || c === "'") {
        inS = c;
      } else if (c === "#") {
        code = text.slice(0, i);
        break;
      }
    }
    return { text, indent, code: code.trimEnd() };
  });
}
function isBlankOrComment(l) {
  return l.code.trim().length === 0;
}
var EXCEPT_RE = /^\s*except\b[^:]*:\s*(.*)$/;
var NOOP_STMT = /^(?:pass|\.\.\.)$/;
var LOG_ONLY_STMT = /^(?:print|logging\.\w+|logger\.\w+|log\.\w+)\(.*\)$/;
function findPySilentCatches(content) {
  const lines = parseLines(content);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = EXCEPT_RE.exec(lines[i].code);
    if (!m) continue;
    if (SUPPRESS("silent-catch").test(lines[i].text)) continue;
    const indent = lines[i].indent;
    const inline = m[1].trim();
    const body = [];
    if (inline) {
      body.push(inline);
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
      out.push({ line: i + 1, detail: "except block swallows the error (pass/...)" });
    } else if (allLog) {
      out.push({ line: i + 1, detail: "except block only logs \u2014 logging is not handling" });
    }
  }
  return out;
}
async function analyzePySilentCatch(input) {
  const findings = findPySilentCatches(input.fileContent);
  const violations = findings.map((f) => ({
    analyzer: "silent-catch",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `${f.detail}. Re-raise (\`raise\`), return a typed error, or hand it to your error reporter. Suppress with \`# quality-gate-allow: silent-catch\` only when ignoring is provably safe.`
  }));
  return { passed: violations.length === 0, violations, metrics: { silentCatchCount: findings.length } };
}
function isDynamicPyArg(rest) {
  const arg = rest.trim();
  if (arg.length === 0) return false;
  if (/^(?:rf|fr|f)["'][^"']*\{/i.test(arg)) return true;
  if (/["']\s*\+/.test(arg) || /\+\s*["']/.test(arg)) return true;
  if (/["']\s*%\s*[\w(]/.test(arg)) return true;
  if (/["']\s*\.format\(/.test(arg)) return true;
  if (/^[A-Za-z_][\w.]*\s*[,)]/.test(arg)) return true;
  return false;
}
var PY_INJECTION_SINKS = [
  {
    id: "eval-exec",
    re: /(?<![\w.])(?:eval|exec)\(\s*(?<rest>[^)].*)$/,
    dynamicOnly: true,
    detail: "eval()/exec() with dynamic input",
    fix: "Code injection: replace with a dict lookup, json.loads, ast.literal_eval, or explicit logic."
  },
  {
    id: "os-system",
    re: /\bos\.system\(\s*(?<rest>.*)$/,
    dynamicOnly: true,
    detail: "os.system() with a dynamic command",
    fix: "Shell injection: use subprocess.run([cmd, *args]) with a list \u2014 never interpolate data into a shell string."
  },
  {
    id: "subprocess-shell",
    re: /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\(\s*(?<rest>.*shell\s*=\s*True.*)$/,
    dynamicOnly: true,
    detail: "subprocess with shell=True and a dynamic command",
    fix: "Shell injection: drop shell=True and pass the command as a list of arguments."
  },
  {
    id: "sql-execute",
    re: /\.(?:execute|executemany|executescript)\(\s*(?<rest>.*)$/,
    dynamicOnly: true,
    detail: "SQL built with f-string/concat/format instead of parameters",
    fix: 'SQL injection: use parameterized queries \u2014 cursor.execute("... WHERE id = %s", (id,)) / SQLAlchemy text() with bound params.'
  }
];
function findPyInjections(content) {
  const lines = parseLines(content);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const { code, text } = lines[i];
    if (!code.trim()) continue;
    if (SUPPRESS("injection").test(text)) continue;
    for (const sink of PY_INJECTION_SINKS) {
      const m = sink.re.exec(code);
      if (!m) continue;
      const rest = m.groups?.rest ?? "";
      if (sink.dynamicOnly && !isDynamicPyArg(rest)) continue;
      out.push({ line: i + 1, detail: sink.detail, fix: sink.fix });
      break;
    }
  }
  return out;
}
async function analyzePyInjection(input) {
  const findings = findPyInjections(input.fileContent);
  const violations = findings.map((f) => ({
    analyzer: "injection",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    severity: "security",
    suggestion: `${f.detail}. ${f.fix}`
  }));
  return { passed: violations.length === 0, violations, metrics: { injectionCount: findings.length } };
}
var PY_STDLIB = /* @__PURE__ */ new Set([
  "abc",
  "argparse",
  "array",
  "ast",
  "asyncio",
  "atexit",
  "base64",
  "bisect",
  "builtins",
  "calendar",
  "collections",
  "concurrent",
  "configparser",
  "contextlib",
  "contextvars",
  "copy",
  "csv",
  "ctypes",
  "dataclasses",
  "datetime",
  "decimal",
  "difflib",
  "dis",
  "email",
  "enum",
  "errno",
  "faulthandler",
  "fcntl",
  "filecmp",
  "fileinput",
  "fnmatch",
  "fractions",
  "functools",
  "gc",
  "getpass",
  "gettext",
  "glob",
  "graphlib",
  "gzip",
  "hashlib",
  "heapq",
  "hmac",
  "html",
  "http",
  "imaplib",
  "importlib",
  "inspect",
  "io",
  "ipaddress",
  "itertools",
  "json",
  "keyword",
  "linecache",
  "locale",
  "logging",
  "lzma",
  "mailbox",
  "math",
  "mimetypes",
  "mmap",
  "multiprocessing",
  "numbers",
  "operator",
  "os",
  "pathlib",
  "pdb",
  "pickle",
  "pkgutil",
  "platform",
  "plistlib",
  "poplib",
  "posixpath",
  "pprint",
  "profile",
  "pstats",
  "pty",
  "pwd",
  "py_compile",
  "queue",
  "quopri",
  "random",
  "re",
  "readline",
  "reprlib",
  "resource",
  "runpy",
  "sched",
  "secrets",
  "select",
  "selectors",
  "shelve",
  "shlex",
  "shutil",
  "signal",
  "site",
  "smtplib",
  "socket",
  "socketserver",
  "sqlite3",
  "ssl",
  "stat",
  "statistics",
  "string",
  "stringprep",
  "struct",
  "subprocess",
  "symtable",
  "sys",
  "sysconfig",
  "tarfile",
  "tempfile",
  "termios",
  "textwrap",
  "threading",
  "time",
  "timeit",
  "tkinter",
  "token",
  "tokenize",
  "tomllib",
  "trace",
  "traceback",
  "tracemalloc",
  "tty",
  "types",
  "typing",
  "unicodedata",
  "unittest",
  "urllib",
  "uuid",
  "venv",
  "warnings",
  "wave",
  "weakref",
  "webbrowser",
  "wsgiref",
  "xml",
  "xmlrpc",
  "zipapp",
  "zipfile",
  "zipimport",
  "zlib",
  "zoneinfo",
  "__future__"
]);
var PY_IMPORT_ALIASES = {
  yaml: "pyyaml",
  PIL: "pillow",
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  bs4: "beautifulsoup4",
  dotenv: "python-dotenv",
  dateutil: "python-dateutil",
  jose: "python-jose",
  OpenSSL: "pyopenssl",
  Crypto: "pycryptodome",
  fitz: "pymupdf",
  magic: "python-magic",
  github: "pygithub",
  jwt: "pyjwt",
  attr: "attrs",
  pkg_resources: "setuptools",
  serial: "pyserial",
  websocket: "websocket-client",
  zmq: "pyzmq",
  google: "google-api-python-client"
};
function normalizePyName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}
function extractDeclaredPyDeps(fileName, content) {
  const out = /* @__PURE__ */ new Set();
  if (/requirements[^/]*\.txt$/.test(fileName)) {
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("-")) continue;
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      if (m) out.add(normalizePyName(m[1]));
    }
    return out;
  }
  const reqString = /["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~;[\s]|["'])/g;
  let inDepArray = false;
  let inPoetryDeps = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (/^\[/.test(line)) {
      inPoetryDeps = /^\[tool\.poetry(?:\.group\.[\w-]+)?\.?(?:dev-)?dependencies\]/.test(line);
      inDepArray = false;
      continue;
    }
    if (/^(?:dependencies|optional-dependencies(?:\.[\w-]+)?|requires)\s*=\s*\[/.test(line)) {
      inDepArray = !line.includes("]");
      reqString.lastIndex = 0;
      let m;
      while ((m = reqString.exec(line)) !== null) out.add(normalizePyName(m[1]));
      continue;
    }
    if (inDepArray) {
      if (line.includes("]")) inDepArray = false;
      reqString.lastIndex = 0;
      let m;
      while ((m = reqString.exec(line)) !== null) out.add(normalizePyName(m[1]));
      continue;
    }
    if (inPoetryDeps) {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      if (m && m[1] !== "python") out.add(normalizePyName(m[1]));
    }
  }
  return out;
}
var PY_MANIFESTS = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "requirements_dev.txt"];
function collectPyDeclaredDeps(fromDir) {
  const declared = /* @__PURE__ */ new Set();
  let foundManifest = false;
  let rootDir = null;
  let dir = fromDir;
  for (let i = 0; i < 12; i += 1) {
    for (const name of PY_MANIFESTS) {
      const p = join4(dir, name);
      if (!existsSync3(p)) continue;
      foundManifest = true;
      if (!rootDir) rootDir = dir;
      try {
        for (const dep of extractDeclaredPyDeps(name, readFileSync4(p, "utf8"))) declared.add(dep);
      } catch {
      }
    }
    const parent = dirname2(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { declared, foundManifest, rootDir };
}
function isLocalPyModule(mod, fileDir, rootDir) {
  const candidates = [fileDir, rootDir, rootDir ? join4(rootDir, "src") : null].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync3(join4(dir, `${mod}.py`))) return true;
    if (existsSync3(join4(dir, mod, "__init__.py"))) return true;
    if (existsSync3(join4(dir, mod)) && existsSync3(join4(dir, mod, "__main__.py"))) return true;
  }
  return false;
}
var IMPORT_RE = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;
var FROM_RE = /^\s*from\s+([\w.]+)\s+import\b/;
async function analyzePyHallucinatedImport(input) {
  const absFilePath = isAbsolute(input.filePath) ? input.filePath : resolve(process.cwd(), input.filePath);
  const fileDir = dirname2(absFilePath);
  const { declared, foundManifest, rootDir } = collectPyDeclaredDeps(fileDir);
  if (!foundManifest) {
    return { passed: true, violations: [], metrics: { hallucinatedImportCount: 0 } };
  }
  const findings = [];
  const lines = parseLines(input.fileContent);
  const check = (mod, lineNo) => {
    const top = mod.split(".")[0];
    if (!top || PY_STDLIB.has(top)) return;
    const dist = PY_IMPORT_ALIASES[top] ?? top;
    if (declared.has(normalizePyName(dist)) || declared.has(normalizePyName(top))) return;
    if (isLocalPyModule(top, fileDir, rootDir)) return;
    findings.push({ line: lineNo, module: top });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const { code, text } = lines[i];
    if (SUPPRESS("hallucinated-import").test(text)) continue;
    const fromM = FROM_RE.exec(code);
    if (fromM) {
      if (!fromM[1].startsWith(".")) check(fromM[1], i + 1);
      continue;
    }
    const impM = IMPORT_RE.exec(code);
    if (impM) {
      for (const mod of impM[1].split(",")) check(mod.trim(), i + 1);
    }
  }
  const violations = findings.map((f) => ({
    analyzer: "hallucinated-import",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `Import "${f.module}" is not declared in pyproject.toml/requirements and is not a local module or stdlib. Likely an LLM hallucination \u2014 verify the package exists on PyPI (pip index versions ${f.module}) and declare it, or fix the import.`
  }));
  return {
    passed: violations.length === 0,
    violations,
    metrics: { hallucinatedImportCount: findings.length }
  };
}

// src/analyzers/new-dependency.ts
var LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];
var PY_LOCKFILES = ["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock"];
var DEP_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];
function depNames(pkg) {
  const out = /* @__PURE__ */ new Set();
  for (const block of DEP_BLOCKS) {
    const deps = pkg[block];
    if (deps) for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}
function parsePkg(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function headContent(cwd, relPath) {
  try {
    const { stdout } = execaSync3("git", ["show", `HEAD:${relPath}`], { cwd });
    return stdout;
  } catch {
    return null;
  }
}
function findLockfiles(fromDir, names = LOCKFILES) {
  const found = [];
  let dir = fromDir;
  for (let i = 0; i < 12; i += 1) {
    for (const name of names) {
      const p = join5(dir, name);
      if (existsSync4(p)) found.push(p);
    }
    const parent = dirname3(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
function lockfileHasPackage(lockContent, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`['"/]${escaped}['"@]`),
    // '/name@', '"name"', "'name'", '"name@'
    new RegExp(`^\\s*${escaped}@`, "m"),
    // yarn: name@^1.0.0:
    new RegExp(`^\\s*['"]?${escaped}['"]?:`, "m")
    // pnpm/yaml: name: or 'name':
  ];
  return patterns.some((re) => re.test(lockContent));
}
function readFromDisk2(abs) {
  try {
    return readFileSync5(abs, "utf8");
  } catch {
    return null;
  }
}
function analyzePyManifest(abs, cwd, readContent) {
  const out = [];
  const rel = toPosix(relative5(cwd, abs));
  const currentRaw = readContent(abs);
  if (currentRaw === null) return out;
  const current = extractDeclaredPyDeps("pyproject.toml", currentRaw);
  const head = headContent(cwd, rel);
  const before = head ? extractDeclaredPyDeps("pyproject.toml", head) : /* @__PURE__ */ new Set();
  const added = [...current].filter((n) => !before.has(n));
  if (added.length === 0) return out;
  const lockfiles = findLockfiles(dirname3(abs), PY_LOCKFILES);
  if (lockfiles.length === 0) return out;
  const lockContents = lockfiles.map((p) => {
    try {
      return readFileSync5(p, "utf8");
    } catch {
      return "";
    }
  });
  for (const name of added) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-_.]");
    const re = new RegExp(`(?:name\\s*=\\s*["']|["'])${escaped}["']`, "i");
    const inLock = lockContents.some((c) => re.test(c));
    if (inLock) continue;
    out.push({
      file: rel,
      violation: {
        analyzer: "new-dependency",
        location: `${rel}:1`,
        current: 1,
        threshold: 0,
        severity: "security",
        suggestion: `New dependency "${name}" was added to ${rel} but has no lockfile entry (poetry.lock/uv.lock/pdm.lock). Possible hallucinated/squatted package. Verify it on PyPI (pip index versions ${name}), run your installer so the lockfile resolves it, and stage the lockfile.`
      }
    });
  }
  return out;
}
function analyzeNewDependency(stagedFiles, cwd, readContent = readFromDisk2) {
  const out = [];
  const manifests = stagedFiles.filter((f) => basename(f) === "package.json");
  const pyManifests = stagedFiles.filter((f) => basename(f) === "pyproject.toml");
  for (const abs of pyManifests) out.push(...analyzePyManifest(abs, cwd, readContent));
  for (const abs of manifests) {
    const rel = toPosix(relative5(cwd, abs));
    const currentRaw = readContent(abs);
    if (currentRaw === null) continue;
    const current = parsePkg(currentRaw);
    if (!current) continue;
    const head = headContent(cwd, rel);
    const previous = head ? parsePkg(head) ?? {} : {};
    const before = depNames(previous);
    const added = [...depNames(current)].filter((n) => !before.has(n));
    if (added.length === 0) continue;
    const lockfiles = findLockfiles(dirname3(abs));
    if (lockfiles.length === 0) continue;
    const lockContents = lockfiles.map((p) => {
      try {
        return readFileSync5(p, "utf8");
      } catch {
        return "";
      }
    });
    for (const name of added) {
      const inLock = lockContents.some((c) => lockfileHasPackage(c, name));
      if (inLock) continue;
      const violation = {
        analyzer: "new-dependency",
        location: `${rel}:1`,
        current: 1,
        threshold: 0,
        severity: "security",
        suggestion: `New dependency "${name}" was added to ${rel} but has no lockfile entry. This is the slopsquatting signature: a hallucinated package name written straight into the manifest. Verify the package exists and is the one you mean (npm view ${name}), run your package manager's install so the lockfile resolves it, and stage the lockfile.`
      };
      out.push({ file: rel, violation });
    }
  }
  return out;
}

// src/analyzers/secret-in-diff.ts
import { readFileSync as readFileSync6 } from "fs";
import { basename as basename2, relative as relative6 } from "path";
var SUPPRESSION = /(?:cerberus|quality-gate)-allow:\s*secret\b/;
var PATTERNS2 = [
  {
    id: "anthropic-key",
    regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
    describe: () => "Anthropic API key"
  },
  {
    id: "openai-key",
    regex: /\bsk-(?!ant-)[A-Za-z0-9_\-]{20,}\b/g,
    describe: () => "OpenAI-style API key (sk-\u2026)"
  },
  {
    id: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    describe: (m) => `GitHub token (${m[0].slice(0, 4)}\u2026)`
  },
  {
    id: "slack-token",
    regex: /\bxox[abprso]-[A-Za-z0-9-]{10,}\b/g,
    describe: (m) => `Slack token (${m[0].slice(0, 5)}\u2026)`
  },
  {
    id: "aws-access-key",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    describe: () => "AWS access key id"
  },
  {
    id: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g,
    describe: () => "Google API key"
  },
  {
    id: "jwt",
    regex: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    describe: () => "JWT in source"
  },
  {
    id: "stripe-live-key",
    regex: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g,
    describe: () => "Stripe live key"
  },
  {
    id: "stripe-webhook-secret",
    regex: /\bwhsec_[A-Za-z0-9]{24,}\b/g,
    describe: () => "Stripe webhook signing secret"
  },
  {
    id: "npm-token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    describe: () => "npm access token"
  },
  {
    id: "gitlab-token",
    regex: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g,
    describe: () => "GitLab personal access token"
  },
  {
    id: "private-key-pem",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    describe: () => "Private key (PEM block)"
  },
  {
    id: "connection-string",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/([^\s:@/'"]+):([^\s@/'"]+)@/g,
    describe: () => "Connection string with embedded credentials"
  }
];
var PLACEHOLDER_PASSWORD = /^(?:pass(?:word)?|pwd|secret|changeme|example|xxx+|\*{3,}|<[^>]*>|\{\{[^}]*\}\}|\$\{[^}]*\}|\$[A-Z_]+|%[a-zA-Z_]+%?)$/i;
var ENV_FILE_RE = /^\.env(\.|$)/;
var ENV_ALLOWLIST = /\.(example|sample|template|dist)$/i;
function lineOf2(content, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}
function isSuppressed(content, idx) {
  let end = idx;
  while (end < content.length && content[end] !== "\n") end += 1;
  let start = idx;
  while (start > 0 && content[start - 1] !== "\n") start -= 1;
  return SUPPRESSION.test(content.slice(start, end));
}
function isEnvFile(name) {
  if (!ENV_FILE_RE.test(name)) return false;
  if (ENV_ALLOWLIST.test(name)) return false;
  return true;
}
function readFromDisk3(abs) {
  try {
    return readFileSync6(abs, "utf8");
  } catch {
    return null;
  }
}
function analyzeSecretInDiff(files, cwd, readContent = readFromDisk3) {
  const out = [];
  for (const abs of files) {
    const rel = toPosix(relative6(cwd, abs));
    const name = basename2(abs);
    if (isEnvFile(name)) {
      const violation = {
        analyzer: "secret-in-diff",
        location: `${rel}:1`,
        current: 1,
        threshold: 0,
        severity: "security",
        suggestion: `\`${name}\` should not be committed. Add it to .gitignore and use \`.env.example\` for documented defaults. If this was an accident, run \`git rm --cached ${rel}\` before re-committing.`
      };
      out.push({ file: rel, violation });
      continue;
    }
    const content = readContent(abs);
    if (content === null) continue;
    for (const pattern of PATTERNS2) {
      pattern.regex.lastIndex = 0;
      let m;
      while ((m = pattern.regex.exec(content)) !== null) {
        if (isSuppressed(content, m.index)) continue;
        if (pattern.id === "connection-string" && m[2] && PLACEHOLDER_PASSWORD.test(m[2])) continue;
        const violation = {
          analyzer: "secret-in-diff",
          location: `${rel}:${lineOf2(content, m.index)}`,
          current: 1,
          threshold: 0,
          severity: "security",
          suggestion: `${pattern.describe(m)} detected. Rotate the credential immediately (it's effectively public the moment a commit lands), move it to your secret manager / .env (gitignored), and reference via process.env. Suppress per-line with \`// quality-gate-allow: secret\` for test fixtures.`
        };
        out.push({ file: rel, violation });
      }
    }
  }
  return out;
}

// src/analyzers/type-safety.ts
import { Node as Node2, SyntaxKind as SyntaxKind2 } from "ts-morph";
var SUPPRESSION_RE = /(?:\/\/|\/\*|\*)\s*@ts-(?:ignore|expect-error|nocheck)\b/;
function measureTypeSafety(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const anyLines = [];
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind2.AnyKeyword)) {
    anyLines.push(node.getStartLineNumber());
  }
  const asUnknownAsLines = [];
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind2.AsExpression)) {
    const inner = node.getExpression();
    if (Node2.isAsExpression(inner) && inner.getType().isUnknown()) {
      asUnknownAsLines.push(node.getStartLineNumber());
    }
  }
  const tsIgnoreLines = [];
  fileContent.split("\n").forEach((line, idx) => {
    if (SUPPRESSION_RE.test(line)) tsIgnoreLines.push(idx + 1);
  });
  return {
    anyCount: anyLines.length,
    anyLines,
    asUnknownAsCount: asUnknownAsLines.length,
    asUnknownAsLines,
    tsIgnoreCount: tsIgnoreLines.length,
    tsIgnoreLines
  };
}
function fmtLines(lines) {
  return lines.map((l) => `L${l}`).join(", ");
}
async function analyzeTypeSafety(input) {
  if (JS_FILE_TYPES.has(input.fileType)) {
    return { passed: true, violations: [], metrics: {} };
  }
  const counts = measureTypeSafety(input.filePath, input.fileContent);
  const baseline = input.fileBaseline?.metrics.typeSafety;
  const violations = [];
  const checks = [
    {
      label: "any",
      current: counts.anyCount,
      lines: counts.anyLines,
      base: baseline?.anyCount ?? 0,
      allowedDelta: input.config.thresholds.newAnyCount,
      suggestion: "Replace `any` with an inferred or explicit type."
    },
    {
      label: "as-unknown-as",
      current: counts.asUnknownAsCount,
      lines: counts.asUnknownAsLines,
      base: baseline?.asUnknownAsCount ?? 0,
      allowedDelta: input.config.thresholds.newAnyCount,
      suggestion: "Avoid `as unknown as` double casts \u2014 narrow the type properly."
    },
    {
      label: "ts-ignore",
      current: counts.tsIgnoreCount,
      lines: counts.tsIgnoreLines,
      base: baseline?.tsIgnoreCount ?? 0,
      allowedDelta: input.config.thresholds.newTsIgnoreCount,
      suggestion: "Remove the suppression directive and fix the underlying type error."
    }
  ];
  for (const check of checks) {
    const delta = check.current - check.base;
    if (delta > check.allowedDelta) {
      violations.push({
        analyzer: "type-safety",
        location: fmtLines(check.lines) || `${check.label}`,
        current: check.current,
        threshold: check.base + check.allowedDelta,
        baseline: input.fileBaseline ? check.base : void 0,
        delta,
        suggestion: `${delta} new \`${check.label}\` (${fmtLines(check.lines)}). ${check.suggestion}`
      });
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    metrics: {
      anyCount: counts.anyCount,
      asUnknownAsCount: counts.asUnknownAsCount,
      tsIgnoreCount: counts.tsIgnoreCount
    }
  };
}

// src/attempts.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync5, readFileSync as readFileSync7, writeFileSync } from "fs";
import { join as join6 } from "path";
var ATTEMPTS_FILE = ".quality-gate-attempts.json";
var TTL_MS = 30 * 60 * 1e3;
function hashFileSet(files) {
  return createHash2("sha256").update([...files].sort().join("\n")).digest("hex").slice(0, 16);
}
function load(cwd) {
  const path = join6(cwd, ATTEMPTS_FILE);
  if (!existsSync5(path)) return {};
  try {
    return JSON.parse(readFileSync7(path, "utf8"));
  } catch {
    return {};
  }
}
function save(cwd, store) {
  writeFileSync(join6(cwd, ATTEMPTS_FILE), `${JSON.stringify(store, null, 2)}
`);
}
function prune(store, now) {
  const out = {};
  for (const [key, entry] of Object.entries(store)) {
    if (now - entry.firstAt < TTL_MS) out[key] = entry;
  }
  return out;
}
function incrementAttempt(cwd, hash, now = Date.now()) {
  const store = prune(load(cwd), now);
  const entry = store[hash] ?? { count: 0, firstAt: now };
  entry.count += 1;
  store[hash] = entry;
  save(cwd, store);
  return { count: entry.count };
}

// src/baseline.ts
import { existsSync as existsSync6, readFileSync as readFileSync8, writeFileSync as writeFileSync2 } from "fs";
import { join as join7 } from "path";
var BASELINE_FILE = ".cerberus-baseline.json";
var LEGACY_BASELINE_FILE = ".quality-gate-baseline.json";
function loadBaseline(cwd) {
  const cerberusPath = join7(cwd, BASELINE_FILE);
  const legacyPath = join7(cwd, LEGACY_BASELINE_FILE);
  const path = existsSync6(cerberusPath) ? cerberusPath : existsSync6(legacyPath) ? legacyPath : null;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync8(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid ${path}: ${err.message}`);
  }
}
function saveBaseline(cwd, baseline) {
  const sortedFiles = {};
  for (const key of Object.keys(baseline.files).sort()) {
    sortedFiles[key] = baseline.files[key];
  }
  const sorted = { ...baseline, files: sortedFiles };
  writeFileSync2(join7(cwd, BASELINE_FILE), `${JSON.stringify(sorted, null, 2)}
`);
}

// src/commit-detect.ts
var VALUE_OPTS = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/;
function tokenIsGit(token) {
  const stripped = token.replace(/^[!(){]+/, "");
  const base = stripped.split(/[/\\]/).pop() ?? stripped;
  return base === "git" || base === "git.exe";
}
function segmentIsCommit(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  for (let g = 0; g < tokens.length; g += 1) {
    if (!tokenIsGit(tokens[g])) continue;
    let i = g + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const opt = tokens[i];
      i += 1;
      if (VALUE_OPTS.test(opt)) i += 1;
    }
    if (tokens[i] === "commit") return true;
  }
  return false;
}
function isGitCommit(command) {
  return command.split(/&&|\|\||[;|&\n\r]/).some(segmentIsCommit);
}

// src/config.ts
import { existsSync as existsSync7, readFileSync as readFileSync9 } from "fs";
import { join as join8 } from "path";

// src/defaults.ts
function defaultConfig() {
  return {
    thresholds: {
      cognitiveComplexity: 15,
      cyclomaticComplexity: 10,
      newAnyCount: 0,
      newTsIgnoreCount: 0,
      coverageDelta: 0,
      duplicationLines: 30,
      functionLength: 80,
      parameterCount: 4
    },
    ignore: [
      "**/*.test.{ts,tsx}",
      "**/__tests__/**",
      "**/*.stories.{ts,tsx}",
      "**/migrations/**",
      "**/generated/**"
    ],
    maxRefactorAttempts: 2,
    preCommit: {
      enabled: [
        "cognitive",
        "cyclomatic",
        "type-safety",
        // 'coverage' is opt-in: it spawns a vitest run, too heavy for a default
        // pre-commit hook. Add it to preCommit.enabled when you want it.
        "duplication",
        "transaction-required",
        "revalidate-required",
        "n-plus-one-query",
        "migration-safety",
        "silent-catch",
        "hallucinated-import",
        "shallow-module",
        "function-length",
        "parameter-count",
        "secret-in-diff",
        "injection",
        "new-dependency"
      ],
      parallel: true,
      timeoutMs: 3e4
    },
    tsxOverrides: {
      cognitiveComplexity: 20,
      ignoreJsxExpressionContainerSimple: true
    }
  };
}

// src/presets/monorepo-turborepo.json
var monorepo_turborepo_default = {
  thresholds: {
    cognitiveComplexity: 15,
    cyclomaticComplexity: 10,
    newAnyCount: 0,
    newTsIgnoreCount: 0,
    coverageDelta: 0,
    duplicationLines: 30,
    functionLength: 80,
    parameterCount: 4
  },
  ignore: [
    "**/*.test.{ts,tsx}",
    "**/__tests__/**",
    "**/*.stories.{ts,tsx}",
    "**/migrations/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/dist/**",
    "**/generated/**"
  ],
  maxRefactorAttempts: 2,
  preCommit: {
    enabled: [
      "cognitive",
      "cyclomatic",
      "type-safety",
      "duplication",
      "transaction-required",
      "revalidate-required",
      "n-plus-one-query",
      "migration-safety",
      "silent-catch",
      "hallucinated-import",
      "shallow-module",
      "function-length",
      "parameter-count",
      "secret-in-diff",
      "injection",
      "new-dependency"
    ],
    parallel: true,
    timeoutMs: 3e4
  },
  tsxOverrides: {
    cognitiveComplexity: 20,
    ignoreJsxExpressionContainerSimple: true
  }
};

// src/presets/nextjs.json
var nextjs_default = {
  thresholds: {
    cognitiveComplexity: 15,
    cyclomaticComplexity: 10,
    newAnyCount: 0,
    newTsIgnoreCount: 0,
    coverageDelta: 0,
    duplicationLines: 30,
    functionLength: 80,
    parameterCount: 4
  },
  ignore: [
    "**/*.test.{ts,tsx}",
    "**/__tests__/**",
    "**/*.stories.{ts,tsx}",
    "**/migrations/**",
    "**/.next/**",
    "**/generated/**"
  ],
  maxRefactorAttempts: 2,
  preCommit: {
    enabled: [
      "cognitive",
      "cyclomatic",
      "type-safety",
      "duplication",
      "transaction-required",
      "revalidate-required",
      "n-plus-one-query",
      "migration-safety",
      "silent-catch",
      "hallucinated-import",
      "shallow-module",
      "function-length",
      "parameter-count",
      "secret-in-diff",
      "injection",
      "new-dependency"
    ],
    parallel: true,
    timeoutMs: 3e4
  },
  tsxOverrides: {
    cognitiveComplexity: 20,
    ignoreJsxExpressionContainerSimple: true
  }
};

// src/presets/node-cli.json
var node_cli_default = {
  thresholds: {
    cognitiveComplexity: 15,
    cyclomaticComplexity: 10,
    newAnyCount: 0,
    newTsIgnoreCount: 0,
    coverageDelta: 0,
    duplicationLines: 30,
    functionLength: 80,
    parameterCount: 4
  },
  ignore: [
    "**/*.test.ts",
    "**/__tests__/**",
    "**/dist/**",
    "**/migrations/**",
    "**/generated/**"
  ],
  maxRefactorAttempts: 2,
  preCommit: {
    enabled: [
      "cognitive",
      "cyclomatic",
      "type-safety",
      "duplication",
      "n-plus-one-query",
      "migration-safety",
      "silent-catch",
      "hallucinated-import",
      "shallow-module",
      "function-length",
      "parameter-count",
      "secret-in-diff",
      "injection",
      "new-dependency"
    ],
    parallel: true,
    timeoutMs: 3e4
  },
  tsxOverrides: {
    cognitiveComplexity: 15,
    ignoreJsxExpressionContainerSimple: false
  }
};

// src/config.ts
var PRESETS = {
  "@cerberus/nextjs": nextjs_default,
  "@quality-gate/nextjs": nextjs_default,
  nextjs: nextjs_default,
  "@cerberus/node-cli": node_cli_default,
  "@quality-gate/node-cli": node_cli_default,
  "node-cli": node_cli_default,
  "@cerberus/monorepo-turborepo": monorepo_turborepo_default,
  "@quality-gate/monorepo-turborepo": monorepo_turborepo_default,
  "monorepo-turborepo": monorepo_turborepo_default
};
var CONFIG_FILE = ".cerberus.json";
var LEGACY_CONFIG_FILE = ".quality-gate.json";
function merge(base, over) {
  return {
    thresholds: { ...base.thresholds, ...over.thresholds },
    ignore: over.ignore ?? base.ignore,
    maxRefactorAttempts: over.maxRefactorAttempts ?? base.maxRefactorAttempts,
    preCommit: { ...base.preCommit, ...over.preCommit },
    tsxOverrides: { ...base.tsxOverrides, ...over.tsxOverrides }
  };
}
function loadConfig(cwd) {
  const base = defaultConfig();
  const cerberusPath = join8(cwd, CONFIG_FILE);
  const legacyPath = join8(cwd, LEGACY_CONFIG_FILE);
  const path = existsSync7(cerberusPath) ? cerberusPath : existsSync7(legacyPath) ? legacyPath : null;
  if (!path) return base;
  let user;
  try {
    user = JSON.parse(readFileSync9(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid ${path}: ${err.message}`);
  }
  let merged = base;
  if (user.extends) {
    const preset = PRESETS[user.extends];
    if (!preset) {
      throw new Error(`Unknown preset "${user.extends}" in ${path}`);
    }
    merged = merge(merged, preset);
  }
  return merge(merged, user);
}

// src/drift.ts
import { existsSync as existsSync9, readFileSync as readFileSync11 } from "fs";
import { resolve as resolve3 } from "path";

// src/engine.ts
import { createHash as createHash3 } from "crypto";

// src/analyzers/function-shape.ts
import { Node as Node3, SyntaxKind as SyntaxKind3 } from "ts-morph";
var FUNCTION_LIKE_KINDS2 = /* @__PURE__ */ new Set([
  SyntaxKind3.FunctionDeclaration,
  SyntaxKind3.FunctionExpression,
  SyntaxKind3.ArrowFunction,
  SyntaxKind3.MethodDeclaration
]);
function functionName2(node) {
  if (Node3.isFunctionDeclaration(node) || Node3.isMethodDeclaration(node)) {
    return node.getName() ?? "<anonymous>";
  }
  const parent = node.getParent();
  if (parent && Node3.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node3.isPropertyAssignment(parent)) return parent.getName();
  return "<anonymous>";
}
function measureFunctionShapes(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const shapes = [];
  for (const node of sourceFile.getDescendants()) {
    if (!FUNCTION_LIKE_KINDS2.has(node.getKind())) continue;
    if (Node3.isMethodDeclaration(node) && node.isAbstract()) continue;
    let bodyLines = 0;
    if (Node3.isFunctionDeclaration(node) || Node3.isFunctionExpression(node) || Node3.isArrowFunction(node) || Node3.isMethodDeclaration(node)) {
      const body = node.getBody();
      if (!body) continue;
      if (Node3.isBlock(body)) {
        bodyLines = body.getEndLineNumber() - body.getStartLineNumber() + 1;
      } else {
        bodyLines = 1;
      }
    }
    let paramCount = 0;
    if (Node3.isFunctionDeclaration(node) || Node3.isFunctionExpression(node) || Node3.isArrowFunction(node) || Node3.isMethodDeclaration(node)) {
      paramCount = node.getParameters().length;
    }
    shapes.push({
      name: functionName2(node),
      line: node.getStartLineNumber(),
      bodyLines,
      paramCount
    });
  }
  return shapes;
}
async function analyzeFunctionShape(input) {
  const shapes = measureFunctionShapes(input.filePath, input.fileContent);
  const violations = [];
  const lengthLimit = input.config.thresholds.functionLength;
  const paramLimit = input.config.thresholds.parameterCount;
  const baselineLengths = input.fileBaseline?.metrics.functionLength?.perFunction ?? {};
  const baselineParams = input.fileBaseline?.metrics.parameterCount?.perFunction ?? {};
  const baselineMaxLen = input.fileBaseline?.metrics.functionLength?.max ?? 0;
  const baselineMaxParams = input.fileBaseline?.metrics.parameterCount?.max ?? 0;
  let worstLength = 0;
  let worstParams = 0;
  for (const s of shapes) {
    worstLength = Math.max(worstLength, s.bodyLines);
    worstParams = Math.max(worstParams, s.paramCount);
    const baseLen = functionBaselineFloor(s.name, baselineLengths, baselineMaxLen, 0);
    if (s.bodyLines > lengthLimit && s.bodyLines > baseLen) {
      violations.push({
        analyzer: "function-length",
        location: `${s.name}:${s.line}`,
        current: s.bodyLines,
        threshold: lengthLimit,
        baseline: baseLen > 0 ? baseLen : void 0,
        delta: baseLen > 0 ? s.bodyLines - baseLen : void 0,
        suggestion: `Function "${s.name}" is ${s.bodyLines} lines (limit ${lengthLimit}). Clean Code \xA73: "functions should be small, then smaller than that". Extract sub-steps into named helpers.`
      });
    }
    const baseParams = functionBaselineFloor(s.name, baselineParams, baselineMaxParams, 0);
    if (s.paramCount > paramLimit && s.paramCount > baseParams) {
      violations.push({
        analyzer: "parameter-count",
        location: `${s.name}:${s.line}`,
        current: s.paramCount,
        threshold: paramLimit,
        baseline: baseParams > 0 ? baseParams : void 0,
        delta: baseParams > 0 ? s.paramCount - baseParams : void 0,
        suggestion: `Function "${s.name}" takes ${s.paramCount} parameters (limit ${paramLimit}). Group related args into a parameter object \u2014 Clean Code \xA73.4 ("argument lists"). Flag booleans are a red flag of their own.`
      });
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    metrics: {
      maxFunctionLength: worstLength,
      maxParameterCount: worstParams
    }
  };
}

// src/analyzers/hallucinated-import.ts
import { existsSync as existsSync8, readFileSync as readFileSync10 } from "fs";
import { dirname as dirname4, isAbsolute as isAbsolute2, join as join9, resolve as resolve2 } from "path";
import { Node as Node4, SyntaxKind as SyntaxKind4 } from "ts-morph";
var NODE_BUILTINS = /* @__PURE__ */ new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);
function packageNameFromSpecifier(spec) {
  if (spec.startsWith("@")) {
    const [scope, pkg] = spec.split("/", 2);
    return pkg ? `${scope}/${pkg}` : scope;
  }
  return spec.split("/", 1)[0] ?? spec;
}
function isLocalSpecifier(spec) {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") return true;
  if (spec.startsWith("/")) return true;
  if (spec.startsWith("@/") || spec.startsWith("~/")) return true;
  return false;
}
function isBuiltin(name) {
  if (name.startsWith("node:")) return true;
  return NODE_BUILTINS.has(name);
}
function collectDeclaredDeps(fromDir) {
  const declared = /* @__PURE__ */ new Set();
  let foundPackageJson = false;
  let dir = fromDir;
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = join9(dir, "package.json");
    if (existsSync8(pkgPath)) {
      foundPackageJson = true;
      try {
        const pkg = JSON.parse(readFileSync10(pkgPath, "utf8"));
        for (const block of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
          if (block) for (const name of Object.keys(block)) declared.add(name);
        }
        if (pkg.name) declared.add(pkg.name);
      } catch {
      }
    }
    const parent = dirname4(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { declared, foundPackageJson };
}
async function analyzeHallucinatedImport(input) {
  const sourceFile = createSourceFile(input.filePath, input.fileContent);
  const absFilePath = isAbsolute2(input.filePath) ? input.filePath : resolve2(process.cwd(), input.filePath);
  const startDir = dirname4(absFilePath);
  const { declared, foundPackageJson } = collectDeclaredDeps(startDir);
  const findings = [];
  const collect = (spec, line) => {
    if (!spec) return;
    if (isLocalSpecifier(spec)) return;
    const pkg = packageNameFromSpecifier(spec);
    if (isBuiltin(pkg)) return;
    if (declared.has(pkg)) return;
    findings.push({ line, specifier: spec, packageName: pkg });
  };
  for (const imp of sourceFile.getImportDeclarations()) {
    collect(imp.getModuleSpecifierValue(), imp.getStartLineNumber());
  }
  for (const exp of sourceFile.getExportDeclarations()) {
    const mod = exp.getModuleSpecifierValue();
    if (mod) collect(mod, exp.getStartLineNumber());
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind4.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind4.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (arg && Node4.isStringLiteral(arg)) {
      collect(arg.getLiteralText(), call.getStartLineNumber());
    }
  }
  if (!foundPackageJson) {
    return { passed: true, violations: [], metrics: { hallucinatedImportCount: 0 } };
  }
  const violations = findings.map((f) => ({
    analyzer: "hallucinated-import",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `Import "${f.specifier}" resolves to package "${f.packageName}", which is not in any package.json on the path to repo root. Likely an LLM hallucination \u2014 verify the package exists on npm before installing, or use a real alternative.`
  }));
  return {
    passed: violations.length === 0,
    violations,
    metrics: { hallucinatedImportCount: findings.length }
  };
}

// src/analyzers/injection.ts
import { Node as Node5, SyntaxKind as SyntaxKind5 } from "ts-morph";
var SUPPRESSION2 = /(?:cerberus|quality-gate)-allow:\s*injection\b/;
var EXEC_NAMES = /* @__PURE__ */ new Set(["exec", "execSync"]);
var SPAWN_NAMES = /* @__PURE__ */ new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
var QUERY_METHODS = /* @__PURE__ */ new Set(["execute", "query", "raw"]);
var SANITIZER_HINT = /sanitiz/i;
function isInterpolatedTemplate(node) {
  return Node5.isTemplateExpression(node);
}
function isDynamicConcat(node) {
  if (!Node5.isBinaryExpression(node)) return false;
  if (node.getOperatorToken().getKind() !== SyntaxKind5.PlusToken) return false;
  const hasString = (n) => Node5.isStringLiteral(n) || Node5.isNoSubstitutionTemplateLiteral(n) || Node5.isBinaryExpression(n) && (hasString(n.getLeft()) || hasString(n.getRight()));
  const hasDynamic = (n) => Node5.isBinaryExpression(n) ? hasDynamic(n.getLeft()) || hasDynamic(n.getRight()) : !Node5.isStringLiteral(n) && !Node5.isNoSubstitutionTemplateLiteral(n);
  return hasString(node) && hasDynamic(node);
}
function isDynamicString(node) {
  if (Node5.isStringLiteral(node) || Node5.isNoSubstitutionTemplateLiteral(node)) return false;
  if (isInterpolatedTemplate(node)) return true;
  if (isDynamicConcat(node)) return true;
  return false;
}
function calleeName(call) {
  const expr = call.getExpression();
  if (Node5.isIdentifier(expr)) return { name: expr.getText() };
  if (Node5.isPropertyAccessExpression(expr)) {
    const root = expr.getExpression();
    return {
      name: expr.getName(),
      receiver: Node5.isIdentifier(root) ? root.getText() : root.getText()
    };
  }
  return { name: "" };
}
function hasShellTrueOption(call) {
  for (const arg of call.getArguments()) {
    if (!Node5.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.getProperties()) {
      if (Node5.isPropertyAssignment(prop) && prop.getName() === "shell" && prop.getInitializer()?.getKind() === SyntaxKind5.TrueKeyword) {
        return true;
      }
    }
  }
  return false;
}
function looksSanitized(node) {
  if (Node5.isCallExpression(node)) {
    return SANITIZER_HINT.test(node.getExpression().getText());
  }
  return false;
}
function checkCall(call, out) {
  const line = call.getStartLineNumber();
  const { name, receiver } = calleeName(call);
  const firstArg = call.getArguments()[0];
  if (name === "eval" && !receiver && call.getArguments().length > 0) {
    out.push({ line, kind: "eval", detail: "eval() executes arbitrary code" });
    return;
  }
  if (EXEC_NAMES.has(name) && firstArg && isDynamicString(firstArg)) {
    out.push({
      line,
      kind: "shell",
      detail: `${name}() with an interpolated command string`
    });
    return;
  }
  if (SPAWN_NAMES.has(name) && firstArg && isDynamicString(firstArg) && hasShellTrueOption(call)) {
    out.push({
      line,
      kind: "shell",
      detail: `${name}() with { shell: true } and an interpolated command`
    });
    return;
  }
  if (name === "raw" && receiver === "sql") {
    if (firstArg && !Node5.isStringLiteral(firstArg) && !Node5.isNoSubstitutionTemplateLiteral(firstArg)) {
      out.push({ line, kind: "sql", detail: "sql.raw() with a non-literal argument" });
    }
    return;
  }
  if (QUERY_METHODS.has(name) && receiver && firstArg && isDynamicString(firstArg)) {
    out.push({
      line,
      kind: "sql",
      detail: `${receiver}.${name}() with an interpolated string (use a tagged template / parameterized query)`
    });
  }
}
function checkNewFunction(node, out) {
  if (!Node5.isNewExpression(node)) return;
  const expr = node.getExpression();
  if (Node5.isIdentifier(expr) && expr.getText() === "Function" && (node.getArguments().length ?? 0) > 0) {
    out.push({
      line: node.getStartLineNumber(),
      kind: "eval",
      detail: "new Function() compiles arbitrary code"
    });
  }
}
function checkDangerousHtml(node, out) {
  if (!Node5.isJsxAttribute(node)) return;
  if (node.getNameNode().getText() !== "dangerouslySetInnerHTML") return;
  const init = node.getInitializer();
  if (!init || !Node5.isJsxExpression(init)) return;
  const obj = init.getExpression();
  if (!obj || !Node5.isObjectLiteralExpression(obj)) return;
  for (const prop of obj.getProperties()) {
    if (!Node5.isPropertyAssignment(prop) || prop.getName() !== "__html") continue;
    const value = prop.getInitializer();
    if (!value) continue;
    if (Node5.isStringLiteral(value) || Node5.isNoSubstitutionTemplateLiteral(value)) continue;
    if (looksSanitized(value)) continue;
    out.push({
      line: node.getStartLineNumber(),
      kind: "xss",
      detail: "dangerouslySetInnerHTML with unsanitized dynamic content"
    });
  }
}
function isSuppressed2(lines, line) {
  const text = lines[line - 1];
  return text !== void 0 && SUPPRESSION2.test(text);
}
function findInjections(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const out = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind5.CallExpression)) {
    checkCall(call, out);
  }
  for (const ne of sourceFile.getDescendantsOfKind(SyntaxKind5.NewExpression)) {
    checkNewFunction(ne, out);
  }
  for (const attr of sourceFile.getDescendantsOfKind(SyntaxKind5.JsxAttribute)) {
    checkDangerousHtml(attr, out);
  }
  const lines = fileContent.split("\n");
  return out.filter((f) => !isSuppressed2(lines, f.line));
}
var SUGGESTIONS = {
  eval: "Code injection: never build executable code from data. Replace with a lookup table, JSON.parse, or explicit logic.",
  shell: "Shell injection: pass arguments as an array (execFile(cmd, [args])) or use execa without a shell. Never interpolate user/runtime data into a command string.",
  sql: "SQL injection: use a parameterized query or a tagged template (db.execute(sql`... ${x} ...`)) so values are bound, not concatenated.",
  xss: "XSS: sanitize with DOMPurify.sanitize(...) before injecting HTML, or render as text. Suppress with `// quality-gate-allow: injection` only if the content is provably static."
};
async function analyzeInjection(input) {
  const findings = findInjections(input.filePath, input.fileContent);
  const violations = findings.map((f) => ({
    analyzer: "injection",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    severity: "security",
    suggestion: `${f.detail}. ${SUGGESTIONS[f.kind] ?? ""}`.trim()
  }));
  return {
    passed: violations.length === 0,
    violations,
    metrics: { injectionCount: findings.length }
  };
}

// src/analyzers/n-plus-one-query.ts
import { Node as Node6, SyntaxKind as SyntaxKind6 } from "ts-morph";
var DB_RECEIVERS = /* @__PURE__ */ new Set(["db", "tx", "trx", "database"]);
var ARRAY_ITERATOR_METHODS = /* @__PURE__ */ new Set(["map", "forEach", "flatMap", "filter", "reduce"]);
var LOOP_KINDS = /* @__PURE__ */ new Set([
  SyntaxKind6.ForStatement,
  SyntaxKind6.ForInStatement,
  SyntaxKind6.ForOfStatement,
  SyntaxKind6.WhileStatement,
  SyntaxKind6.DoStatement
]);
var FUNCTION_LIKE_KINDS3 = /* @__PURE__ */ new Set([
  SyntaxKind6.FunctionDeclaration,
  SyntaxKind6.FunctionExpression,
  SyntaxKind6.ArrowFunction,
  SyntaxKind6.MethodDeclaration
]);
function rootReceiver(node) {
  let cur = node;
  while (true) {
    if (Node6.isPropertyAccessExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node6.isCallExpression(cur)) {
      cur = cur.getExpression();
    } else {
      break;
    }
  }
  return cur;
}
function isDbAccess(call) {
  const root = rootReceiver(call.getExpression());
  return Node6.isIdentifier(root) && DB_RECEIVERS.has(root.getText());
}
function dbReceiverName(call) {
  const root = rootReceiver(call.getExpression());
  return Node6.isIdentifier(root) ? root.getText() : "db";
}
function isInsideLoop(node) {
  let cur = node.getParent();
  while (cur) {
    const kind = cur.getKind();
    if (FUNCTION_LIKE_KINDS3.has(kind)) {
      const parent = cur.getParent();
      if (parent && Node6.isCallExpression(parent) && isArrayIteratorCall(parent)) {
        return { kind: "loop", line: parent.getStartLineNumber() };
      }
      return null;
    }
    if (LOOP_KINDS.has(kind)) {
      return { kind: "loop", line: cur.getStartLineNumber() };
    }
    cur = cur.getParent();
  }
  return null;
}
function isArrayIteratorCall(call) {
  const expr = call.getExpression();
  if (!Node6.isPropertyAccessExpression(expr)) return false;
  return ARRAY_ITERATOR_METHODS.has(expr.getName());
}
function findNPlusOne(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const findings = [];
  for (const awaitExpr of sourceFile.getDescendantsOfKind(SyntaxKind6.AwaitExpression)) {
    const inner = awaitExpr.getExpression();
    if (!Node6.isCallExpression(inner)) continue;
    if (!isDbAccess(inner)) continue;
    const loop = isInsideLoop(awaitExpr);
    if (!loop) continue;
    findings.push({
      line: awaitExpr.getStartLineNumber(),
      loopLine: loop.line,
      receiver: dbReceiverName(inner)
    });
  }
  return findings;
}
async function analyzeNPlusOneQuery(input) {
  const findings = findNPlusOne(input.filePath, input.fileContent);
  const violations = findings.map((f) => ({
    analyzer: "n-plus-one-query",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `\`await ${f.receiver}.*\` runs once per iteration of the loop at L${f.loopLine}. Hoist the query out of the loop (use \`inArray()\` or a relational \`with:\` query to batch).`
  }));
  return {
    passed: violations.length === 0,
    violations,
    metrics: { nPlusOneCount: findings.length }
  };
}

// src/analyzers/revalidate-required.ts
import { Node as Node7, SyntaxKind as SyntaxKind7 } from "ts-morph";
var MUTATION_METHODS = /* @__PURE__ */ new Set(["insert", "update", "delete"]);
var REVALIDATORS = /* @__PURE__ */ new Set(["revalidatePath", "revalidateTag", "redirect"]);
var FUNCTION_LIKE_KINDS4 = /* @__PURE__ */ new Set([
  SyntaxKind7.FunctionDeclaration,
  SyntaxKind7.FunctionExpression,
  SyntaxKind7.ArrowFunction,
  SyntaxKind7.MethodDeclaration
]);
function isUseServerFile(content) {
  const head = content.split("\n").slice(0, 12).join("\n");
  return /^\s*['"]use server['"]\s*;?/m.test(head);
}
function isFunctionLike2(node) {
  return FUNCTION_LIKE_KINDS4.has(node.getKind());
}
function isDrizzleMutationCall(call) {
  const expr = call.getExpression();
  if (!Node7.isPropertyAccessExpression(expr)) return false;
  return MUTATION_METHODS.has(expr.getName());
}
function isRevalidatorCall(call) {
  const expr = call.getExpression();
  if (Node7.isIdentifier(expr)) return REVALIDATORS.has(expr.getText());
  if (Node7.isPropertyAccessExpression(expr)) return REVALIDATORS.has(expr.getName());
  return false;
}
function functionName3(fn) {
  if (Node7.isFunctionDeclaration(fn) || Node7.isMethodDeclaration(fn)) {
    return fn.getName() ?? "<anonymous>";
  }
  const parent = fn.getParent();
  if (parent && Node7.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node7.isPropertyAssignment(parent)) return parent.getName();
  return "<anonymous>";
}
function isExportedActionLike(fn) {
  if (Node7.isFunctionDeclaration(fn)) {
    return fn.isExported() && fn.isAsync();
  }
  const varDecl = fn.getParent();
  if (varDecl && Node7.isVariableDeclaration(varDecl)) {
    const stmt = varDecl.getFirstAncestorByKind(SyntaxKind7.VariableStatement);
    if (!stmt || !stmt.isExported()) return false;
    if (Node7.isArrowFunction(fn) || Node7.isFunctionExpression(fn)) return fn.isAsync();
  }
  return false;
}
function auditActions(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const actions = sourceFile.getDescendants().filter(isFunctionLike2).filter(isExportedActionLike);
  const audits = [];
  for (const fn of actions) {
    let hasMutation = false;
    let hasRevalidator = false;
    fn.forEachDescendant((node, traversal) => {
      if (node !== fn && isFunctionLike2(node)) {
        traversal.skip();
        return;
      }
      if (!Node7.isCallExpression(node)) return;
      if (isDrizzleMutationCall(node)) hasMutation = true;
      if (isRevalidatorCall(node)) hasRevalidator = true;
    });
    audits.push({
      name: functionName3(fn),
      line: fn.getStartLineNumber(),
      hasMutation,
      hasRevalidator
    });
  }
  return audits;
}
async function analyzeRevalidateRequired(input) {
  if (!isUseServerFile(input.fileContent)) {
    return { passed: true, violations: [], metrics: { mutatingActions: 0 } };
  }
  const audits = auditActions(input.filePath, input.fileContent);
  const violations = [];
  let mutatingActions = 0;
  for (const a of audits) {
    if (!a.hasMutation) continue;
    mutatingActions += 1;
    if (!a.hasRevalidator) {
      violations.push({
        analyzer: "revalidate-required",
        location: `${a.name}:${a.line}`,
        current: 0,
        threshold: 1,
        suggestion: `Server Action "${a.name}" mutates data but never calls revalidatePath/revalidateTag (or redirect). Cached pages will show stale data \u2014 add revalidation before returning.`
      });
    }
  }
  return { passed: violations.length === 0, violations, metrics: { mutatingActions } };
}

// src/analyzers/shallow-module.ts
import { Node as Node8 } from "ts-morph";
var SUPPRESSION3 = /(?:cerberus|quality-gate)-allow:\s*shallow-module\b/;
function isPureDelegationBody(fn) {
  const body = fn.getBody();
  if (!body || !Node8.isBlock(body)) {
    return true;
  }
  const stmts = body.getStatements();
  if (stmts.length === 0) return false;
  if (stmts.length > 2) return false;
  if (stmts.length === 1) {
    const s = stmts[0];
    if (Node8.isReturnStatement(s)) {
      const expr = s.getExpression();
      if (!expr) return false;
      return Node8.isCallExpression(expr) || Node8.isPropertyAccessExpression(expr) || Node8.isIdentifier(expr);
    }
    if (Node8.isExpressionStatement(s)) {
      const expr = s.getExpression();
      return Node8.isCallExpression(expr);
    }
    return false;
  }
  const [first, second] = stmts;
  if (Node8.isVariableStatement(first) && Node8.isReturnStatement(second)) {
    const decls = first.getDeclarationList().getDeclarations();
    if (decls.length !== 1) return false;
    const init = decls[0].getInitializer();
    const ret = second.getExpression();
    if (!init || !ret) return false;
    if (!Node8.isCallExpression(init)) return false;
    return Node8.isIdentifier(ret) && ret.getText() === decls[0].getName();
  }
  return false;
}
function hasSuppression(node) {
  const ranges = node.getLeadingCommentRanges();
  for (const r of ranges) {
    if (SUPPRESSION3.test(r.getText())) return true;
  }
  return false;
}
function findShallowModules(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const out = [];
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    if (hasSuppression(fn)) continue;
    if (!isPureDelegationBody(fn)) continue;
    const name = fn.getName() ?? "<anonymous>";
    out.push({
      name,
      line: fn.getStartLineNumber(),
      reason: "exported function is a one-statement pass-through"
    });
  }
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    if (hasSuppression(stmt)) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      if (!Node8.isArrowFunction(init) && !Node8.isFunctionExpression(init)) continue;
      if (!isPureDelegationBody(init)) continue;
      out.push({
        name: decl.getName(),
        line: decl.getStartLineNumber(),
        reason: "exported arrow/function expression is a one-statement pass-through"
      });
    }
  }
  return out;
}
async function analyzeShallowModule(input) {
  const findings = findShallowModules(input.filePath, input.fileContent);
  const violations = findings.map((f) => ({
    analyzer: "shallow-module",
    location: `${f.name}:${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: `"${f.name}" \u2014 ${f.reason}. Either inline the call at the caller (Ousterhout, *A Philosophy of Software Design* ch. 4), or move real abstraction inside (validation, error mapping, default values). Suppress with \`// quality-gate-allow: shallow-module\` if the indirection is intentional (e.g. testing seam).`
  }));
  return {
    passed: violations.length === 0,
    violations,
    metrics: { shallowModuleCount: findings.length }
  };
}

// src/analyzers/silent-catch.ts
import { Node as Node9, SyntaxKind as SyntaxKind8 } from "ts-morph";
var CONSOLE_RECEIVERS = /* @__PURE__ */ new Set(["console", "logger", "log"]);
function isConsoleCall(node) {
  if (!Node9.isCallExpression(node)) return false;
  const expr = node.getExpression();
  if (!Node9.isPropertyAccessExpression(expr)) return false;
  const root = expr.getExpression();
  return Node9.isIdentifier(root) && CONSOLE_RECEIVERS.has(root.getText());
}
function statementIsConsoleCall(stmt) {
  if (!Node9.isExpressionStatement(stmt)) return false;
  return isConsoleCall(stmt.getExpression());
}
function classifyCatch(clause) {
  const block = clause.getBlock();
  const statements = block.getStatements();
  const line = clause.getStartLineNumber();
  if (statements.length === 0) return { line, kind: "empty" };
  const allConsole = statements.every(statementIsConsoleCall);
  if (allConsole) return { line, kind: "console-only" };
  return null;
}
function findSilentCatches(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const out = [];
  for (const clause of sourceFile.getDescendantsOfKind(SyntaxKind8.CatchClause)) {
    const finding = classifyCatch(clause);
    if (finding) out.push(finding);
  }
  return out;
}
function measureSilentCatch(filePath, fileContent) {
  return findSilentCatches(filePath, fileContent).length;
}
async function analyzeSilentCatch(input) {
  const findings = findSilentCatches(input.filePath, input.fileContent);
  const baseCount = input.fileBaseline?.metrics.silentCatch?.count ?? 0;
  const flagged = findings.length > baseCount ? findings : [];
  const violations = flagged.map((f) => ({
    analyzer: "silent-catch",
    location: `L${f.line}`,
    current: 1,
    threshold: 0,
    suggestion: f.kind === "empty" ? `Empty catch at L${f.line} swallows the error. Either rethrow (\`throw e\`), report it (Sentry/logger.error), or document with a comment why ignoring is safe and include the caught binding.` : `Catch at L${f.line} only logs to console. Logging is not handling \u2014 rethrow, return a typed error, or hand it to your error reporter.`
  }));
  return {
    passed: violations.length === 0,
    violations,
    metrics: { silentCatchCount: findings.length }
  };
}

// src/analyzers/transaction-required.ts
import { Node as Node10, SyntaxKind as SyntaxKind9 } from "ts-morph";
var MUTATION_METHODS2 = /* @__PURE__ */ new Set(["insert", "update", "delete"]);
var FUNCTION_LIKE_KINDS5 = /* @__PURE__ */ new Set([
  SyntaxKind9.FunctionDeclaration,
  SyntaxKind9.FunctionExpression,
  SyntaxKind9.ArrowFunction,
  SyntaxKind9.MethodDeclaration
]);
function isUseServerFile2(content) {
  const head = content.split("\n").slice(0, 12).join("\n");
  return /^\s*['"]use server['"]\s*;?/m.test(head);
}
function isDrizzleMutationCall2(call) {
  const expr = call.getExpression();
  if (!Node10.isPropertyAccessExpression(expr)) return false;
  return MUTATION_METHODS2.has(expr.getName());
}
function isTransactionCall(call) {
  const expr = call.getExpression();
  if (!Node10.isPropertyAccessExpression(expr)) return false;
  return expr.getName() === "transaction";
}
function isFunctionLike3(node) {
  return FUNCTION_LIKE_KINDS5.has(node.getKind());
}
function functionName4(fn) {
  if (Node10.isFunctionDeclaration(fn) || Node10.isMethodDeclaration(fn)) {
    return fn.getName() ?? "<anonymous>";
  }
  const parent = fn.getParent();
  if (parent && Node10.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node10.isPropertyAssignment(parent)) return parent.getName();
  return "<anonymous>";
}
function auditFunctions(filePath, fileContent) {
  const sourceFile = createSourceFile(filePath, fileContent);
  const fns = sourceFile.getDescendants().filter(isFunctionLike3);
  const audits = [];
  for (const fn of fns) {
    let mutationCount = 0;
    let allWrapped = true;
    const fnIsInsideTransaction = hasTransactionAncestor(fn);
    fn.forEachDescendant((node, traversal) => {
      if (node !== fn && isFunctionLike3(node)) {
        traversal.skip();
        return;
      }
      if (!Node10.isCallExpression(node)) return;
      if (!isDrizzleMutationCall2(node)) return;
      mutationCount += 1;
      if (!fnIsInsideTransaction && !hasTransactionAncestorUpTo(node, fn)) {
        allWrapped = false;
      }
    });
    audits.push({
      name: functionName4(fn),
      line: fn.getStartLineNumber(),
      mutationCount,
      wrappedInTransaction: mutationCount === 0 ? true : allWrapped || fnIsInsideTransaction
    });
  }
  return audits;
}
function hasTransactionAncestorUpTo(node, stopAt) {
  let cur = node.getParent();
  while (cur && cur !== stopAt) {
    if (Node10.isCallExpression(cur) && isTransactionCall(cur)) return true;
    cur = cur.getParent();
  }
  return false;
}
function hasTransactionAncestor(node) {
  let cur = node.getParent();
  while (cur) {
    if (Node10.isCallExpression(cur) && isTransactionCall(cur)) return true;
    cur = cur.getParent();
  }
  return false;
}
async function analyzeTransactionRequired(input) {
  if (!isUseServerFile2(input.fileContent)) {
    return { passed: true, violations: [], metrics: { mutationFunctions: 0 } };
  }
  const audits = auditFunctions(input.filePath, input.fileContent);
  const violations = [];
  let mutationFunctions = 0;
  for (const a of audits) {
    if (a.mutationCount >= 2) mutationFunctions += 1;
    if (a.mutationCount >= 2 && !a.wrappedInTransaction) {
      violations.push({
        analyzer: "transaction-required",
        location: `${a.name}:${a.line}`,
        current: a.mutationCount,
        threshold: 1,
        suggestion: `Function "${a.name}" performs ${a.mutationCount} Drizzle mutations without a transaction. Wrap with \`db.transaction(async (tx) => { ... })\` to avoid partial writes on failure.`
      });
    }
  }
  return { passed: violations.length === 0, violations, metrics: { mutationFunctions } };
}

// src/engine.ts
var IMPLEMENTED_ANALYZERS = [
  "cognitive",
  "cyclomatic",
  "type-safety",
  "transaction-required",
  "revalidate-required",
  "n-plus-one-query",
  "silent-catch",
  "hallucinated-import",
  "shallow-module",
  "function-length",
  "parameter-count",
  "injection"
];
function hashContent(content) {
  return createHash3("sha256").update(content).digest("hex");
}
function maxScore(scores) {
  return scores.reduce((m, s) => Math.max(m, s.score), 0);
}
async function analyzeFile(filePath, fileContent, config, fileBaseline) {
  const input = {
    filePath,
    fileContent,
    config,
    fileBaseline,
    fileType: fileTypeFromPath(filePath)
  };
  const enabled = new Set(
    config.preCommit.enabled.filter((a) => IMPLEMENTED_ANALYZERS.includes(a))
  );
  const results = [];
  if (enabled.has("cognitive")) results.push(await analyzeCognitive(input));
  if (enabled.has("cyclomatic")) results.push(await analyzeCyclomatic(input));
  if (enabled.has("type-safety")) results.push(await analyzeTypeSafety(input));
  if (enabled.has("transaction-required")) results.push(await analyzeTransactionRequired(input));
  if (enabled.has("revalidate-required")) results.push(await analyzeRevalidateRequired(input));
  if (enabled.has("n-plus-one-query")) results.push(await analyzeNPlusOneQuery(input));
  if (enabled.has("silent-catch")) results.push(await analyzeSilentCatch(input));
  if (enabled.has("hallucinated-import")) results.push(await analyzeHallucinatedImport(input));
  if (enabled.has("shallow-module")) results.push(await analyzeShallowModule(input));
  if (enabled.has("injection")) results.push(await analyzeInjection(input));
  if (enabled.has("function-length") || enabled.has("parameter-count")) {
    const result = await analyzeFunctionShape(input);
    const filtered = {
      passed: true,
      violations: result.violations.filter(
        (v) => v.analyzer === "function-length" ? enabled.has("function-length") : enabled.has("parameter-count")
      ),
      metrics: result.metrics
    };
    filtered.passed = filtered.violations.length === 0;
    results.push(filtered);
  }
  const violations = results.flatMap((r) => r.violations);
  const metrics = Object.assign({}, ...results.map((r) => r.metrics));
  return { file: filePath, passed: violations.length === 0, violations, metrics };
}
async function analyzePythonFile(filePath, fileContent, config) {
  const input = {
    filePath,
    fileContent,
    config,
    fileType: "ts"
    // unused by the Python analyzers; satisfies AnalyzerInput
  };
  const enabled = new Set(config.preCommit.enabled);
  const results = [];
  if (enabled.has("silent-catch")) results.push(await analyzePySilentCatch(input));
  if (enabled.has("injection")) results.push(await analyzePyInjection(input));
  if (enabled.has("hallucinated-import")) results.push(await analyzePyHallucinatedImport(input));
  const violations = results.flatMap((r) => r.violations);
  const metrics = Object.assign({}, ...results.map((r) => r.metrics));
  return { file: filePath, passed: violations.length === 0, violations, metrics };
}
function computeFileBaseline(filePath, fileContent) {
  const cognitive = measureCognitive(filePath, fileContent);
  const cyclomatic = measureCyclomatic(filePath, fileContent);
  const typeSafety = measureTypeSafety(filePath, fileContent);
  const shapes = measureFunctionShapes(filePath, fileContent);
  const cognitivePer = {};
  for (const fn of cognitive) cognitivePer[baselineKey(fn)] = fn.score;
  const cyclomaticPer = {};
  for (const fn of cyclomatic) cyclomaticPer[baselineKey(fn)] = fn.score;
  const lengthPer = {};
  const paramPer = {};
  let maxLen = 0;
  let maxParams = 0;
  for (const s of shapes) {
    const key = s.name === "<anonymous>" ? `${s.name}:${s.line}` : s.name;
    lengthPer[key] = s.bodyLines;
    paramPer[key] = s.paramCount;
    if (s.bodyLines > maxLen) maxLen = s.bodyLines;
    if (s.paramCount > maxParams) maxParams = s.paramCount;
  }
  return {
    fileHash: hashContent(fileContent),
    metrics: {
      cognitiveComplexity: { max: maxScore(cognitive), perFunction: cognitivePer },
      cyclomaticComplexity: { max: maxScore(cyclomatic), perFunction: cyclomaticPer },
      typeSafety: {
        anyCount: typeSafety.anyCount,
        tsIgnoreCount: typeSafety.tsIgnoreCount,
        asUnknownAsCount: typeSafety.asUnknownAsCount
      },
      coverage: { percent: 0 },
      functionLength: { max: maxLen, perFunction: lengthPer },
      parameterCount: { max: maxParams, perFunction: paramPer },
      silentCatch: { count: measureSilentCatch(filePath, fileContent) }
    }
  };
}

// src/drift.ts
function listDrift(cwd) {
  const baseline = loadBaseline(cwd);
  if (!baseline) return [];
  const out = [];
  for (const [rel, fb] of Object.entries(baseline.files)) {
    const abs = resolve3(cwd, rel);
    if (!existsSync9(abs)) continue;
    const content = readFileSync11(abs, "utf8");
    if (hashContent(content) === fb.fileHash) continue;
    const current = computeFileBaseline(rel, content);
    const deltas = {
      cognitiveMax: current.metrics.cognitiveComplexity.max - fb.metrics.cognitiveComplexity.max,
      cyclomaticMax: current.metrics.cyclomaticComplexity.max - fb.metrics.cyclomaticComplexity.max,
      anyCount: current.metrics.typeSafety.anyCount - fb.metrics.typeSafety.anyCount,
      tsIgnoreCount: current.metrics.typeSafety.tsIgnoreCount - fb.metrics.typeSafety.tsIgnoreCount
    };
    const sum = deltas.cognitiveMax + deltas.cyclomaticMax + deltas.anyCount + deltas.tsIgnoreCount;
    const direction = sum > 0 ? "degraded" : sum < 0 ? "improved" : "flat";
    out.push({ file: rel, baseline: fb, current, deltas, direction });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// src/git-diff.ts
import { execaSync as execaSync4 } from "execa";
import { readFileSync as readFileSync12 } from "fs";
function getStagedFiles(cwd, filter = "ACMR") {
  try {
    const { stdout } = execaSync4("git", ["diff", "--cached", "--name-only", `--diff-filter=${filter}`], {
      cwd
    });
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function getChangedFiles(cwd, baseRef, filter = "ACMR") {
  try {
    const { stdout } = execaSync4(
      "git",
      ["diff", "--name-only", `--diff-filter=${filter}`, `${baseRef}...HEAD`],
      { cwd }
    );
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function getFileContent(filePath) {
  return readFileSync12(filePath, "utf8");
}
function getStagedContent(cwd, relPath) {
  try {
    const { stdout } = execaSync4("git", ["show", `:${relPath}`], { cwd, stripFinalNewline: false });
    return stdout;
  } catch {
    return null;
  }
}

// src/injector.ts
import { execaSync as execaSync5 } from "execa";
import { readFileSync as readFileSync13, writeFileSync as writeFileSync3 } from "fs";
import { resolve as resolve4 } from "path";
function buildTodoComment(v, attempt) {
  return `// TODO: cerberus(${v.analyzer}=${v.current}, limit=${v.threshold}, attempt=${attempt})`;
}
function targetLine(v) {
  const colon = v.location.match(/:(\d+)\s*$/);
  if (colon) return Number(colon[1]);
  const lmark = v.location.match(/L(\d+)/);
  if (lmark) return Number(lmark[1]);
  return 1;
}
function injectTodos(content, violations, attempt) {
  const lines = content.split("\n");
  const byLine = /* @__PURE__ */ new Map();
  for (const v of violations) {
    const ln = targetLine(v);
    const comment = buildTodoComment(v, attempt);
    const arr = byLine.get(ln) ?? [];
    if (!arr.includes(comment)) arr.push(comment);
    byLine.set(ln, arr);
  }
  for (const ln of [...byLine.keys()].sort((a, b) => b - a)) {
    const idx = Math.min(Math.max(ln - 1, 0), lines.length);
    const indent = lines[idx]?.match(/^\s*/)?.[0] ?? "";
    const aboveText = lines[idx - 1] ?? "";
    const comments = byLine.get(ln).filter((c) => !aboveText.includes(c)).map((c) => indent + c);
    if (comments.length > 0) lines.splice(idx, 0, ...comments);
  }
  return lines.join("\n");
}
function applyTodoInjection(cwd, report, attempt) {
  const abs = resolve4(cwd, report.file);
  const content = readFileSync13(abs, "utf8");
  const updated = injectTodos(content, report.violations, attempt);
  if (updated === content) return false;
  writeFileSync3(abs, updated);
  return true;
}
function stageFiles(cwd, files) {
  if (files.length === 0) return;
  execaSync5("git", ["add", "--", ...files], { cwd, reject: false });
}

// src/install-hooks.ts
import { execaSync as execaSync6 } from "execa";
import { chmodSync, existsSync as existsSync10, mkdirSync, readFileSync as readFileSync14, renameSync, writeFileSync as writeFileSync4 } from "fs";
import { join as join10, resolve as resolve5 } from "path";
var MARKER = "# quality-gate-hook";
function gitHooksDir(cwd) {
  try {
    const { stdout } = execaSync6("git", ["rev-parse", "--git-path", "hooks"], { cwd });
    return resolve5(cwd, stdout.trim());
  } catch {
    return null;
  }
}
function cliInvocation() {
  return `node "${process.argv[1]}"`;
}
function isHuskyRepo(cwd) {
  return existsSync10(join10(cwd, ".husky", "_")) || existsSync10(join10(cwd, ".husky", "pre-commit"));
}
function detectInstalledHook(cwd) {
  if (isHuskyRepo(cwd)) {
    const path2 = join10(cwd, ".husky", "pre-commit");
    const hasMarker2 = existsSync10(path2) && readFileSync14(path2, "utf8").includes(MARKER);
    return { kind: "husky", path: path2, hasMarker: hasMarker2 };
  }
  const hooksDir = gitHooksDir(cwd);
  if (!hooksDir) return { kind: "none" };
  const path = join10(hooksDir, "pre-commit");
  if (!existsSync10(path)) return { kind: "none" };
  const hasMarker = readFileSync14(path, "utf8").includes(MARKER);
  return { kind: "git", path, hasMarker };
}
function installHuskyHook(cwd) {
  const hookPath = join10(cwd, ".husky", "pre-commit");
  let content = existsSync10(hookPath) ? readFileSync14(hookPath, "utf8") : "";
  if (content.includes(MARKER)) return { hookPath, wrapped: true, husky: true };
  const hadContent = content.trim().length > 0;
  if (!hadContent) {
    content = "#!/usr/bin/env sh\nset -e\n";
  } else {
    if (!content.endsWith("\n")) content += "\n";
    if (!/^\s*set -e\b/m.test(content)) {
      const lines = content.split("\n");
      lines.splice(lines[0].startsWith("#!") ? 1 : 0, 0, "set -e");
      content = `${lines.join("\n")}`;
      if (!content.endsWith("\n")) content += "\n";
    }
  }
  const block = `${MARKER}
${cliInvocation()} check --staged --mode pre-commit --format human || exit 1
`;
  writeFileSync4(hookPath, content + block, { mode: 493 });
  return { hookPath, wrapped: hadContent, husky: true };
}
function installGitHook(cwd) {
  if (isHuskyRepo(cwd)) return installHuskyHook(cwd);
  const hooksDir = gitHooksDir(cwd);
  if (!hooksDir) {
    throw new Error('Not a git repository \u2014 run "git init" first or install Husky.');
  }
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join10(hooksDir, "pre-commit");
  let preamble = "";
  let wrapped = false;
  if (existsSync10(hookPath)) {
    const existing = readFileSync14(hookPath, "utf8");
    if (!existing.includes(MARKER)) {
      const backup = join10(hooksDir, "pre-commit.backup-quality-gate");
      renameSync(hookPath, backup);
      chmodSync(backup, 493);
      preamble = `if [ -x "${backup}" ]; then
  "${backup}" "$@" || exit $?
fi
`;
      wrapped = true;
    }
  }
  const content = `#!/usr/bin/env sh
${MARKER}
${preamble}${cliInvocation()} check --staged --mode pre-commit --format human
`;
  writeFileSync4(hookPath, content, { mode: 493 });
  chmodSync(hookPath, 493);
  return { hookPath, wrapped, husky: false };
}
function registerClaudeHook(cwd) {
  const claudeDir = join10(cwd, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join10(claudeDir, "settings.json");
  let settings = {};
  if (existsSync10(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync14(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }
  const hooks = settings.hooks ?? {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  if (!JSON.stringify(preToolUse).includes("claude-hook")) {
    preToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: `${cliInvocation()} claude-hook` }]
    });
  }
  hooks.PreToolUse = preToolUse;
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  if (!JSON.stringify(postToolUse).includes("claude-post-edit-hook")) {
    postToolUse.push({
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: `${cliInvocation()} claude-post-edit-hook` }]
    });
  }
  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;
  writeFileSync4(settingsPath, `${JSON.stringify(settings, null, 2)}
`);
  return settingsPath;
}

// src/reporter.ts
import chalk from "chalk";
function reportJson(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
}
function lineFromLocation(location) {
  const m = /(?:^L|:)(\d+)$/.exec(location);
  return m ? Number(m[1]) : 1;
}
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function reportGithub(report) {
  let count = 0;
  for (const f of report.files) {
    for (const v of f.violations) {
      count += 1;
      const security = isSecurityViolation(v);
      const title = `cerberus: ${v.analyzer}${security ? " [SECURITY]" : ""}`;
      const line = lineFromLocation(v.location);
      process.stdout.write(
        `::error file=${escapeProperty(f.file)},line=${line},title=${escapeProperty(title)}::${escapeData(v.suggestion)}
`
      );
    }
  }
  process.stderr.write(
    count === 0 ? "\u2713 cerberus: all checks passed\n" : `\u2717 cerberus: ${count} violation(s) annotated on the diff
`
  );
}
function reportHuman(report) {
  for (const note of report.notes ?? []) {
    process.stderr.write(chalk.dim(`  note: ${note}
`));
  }
  const failed = report.files.filter((f) => !f.passed);
  if (report.status === "PASS_WITH_TODO") {
    process.stderr.write(
      chalk.yellow(
        `\u26A0 cerberus: ${failed.length} file(s) still failing after ${report.attempt} attempts \u2014 letting the commit through (debt flagged).
`
      )
    );
    for (const f of failed) writeFileBlock(f);
    return;
  }
  if (failed.length === 0) {
    process.stderr.write(chalk.green("\u2713 cerberus: all checks passed\n"));
    return;
  }
  const attemptStr = report.attempt ? chalk.dim(` (attempt ${report.attempt})`) : "";
  process.stderr.write(chalk.red(`\u2717 cerberus: ${failed.length} file(s) with violations`) + attemptStr + "\n");
  for (const f of failed) writeFileBlock(f);
}
function writeFileBlock(f) {
  process.stderr.write("\n" + chalk.underline(f.file) + "\n");
  for (const v of f.violations) {
    const deltaStr = v.delta !== void 0 ? chalk.dim(` (baseline ${v.baseline}, \u0394+${v.delta})`) : "";
    const sevTag = isSecurityViolation(v) ? chalk.bgRed.white(" SECURITY ") + " " : "";
    process.stderr.write(
      `  ${sevTag}${chalk.yellow(v.analyzer)} ${chalk.cyan(v.location)} \u2014 ${v.current} > ${v.threshold}${deltaStr}
`
    );
    process.stderr.write(`    ${chalk.dim(v.suggestion)}
`);
  }
}

// src/cli.ts
var JSON_SCHEMA_VERSION = 1;
var SQL_EXT2 = /\.sql$/i;
var PY_EXT = /\.py$/;
function relKey(cwd, absPath) {
  return toPosix(relative7(cwd, absPath));
}
function toAbs(cwd, p) {
  return isAbsolute3(p) ? p : resolve6(cwd, p);
}
function isTsAnalyzable(absPath) {
  return CODE_EXT.test(absPath) && !DTS_EXT.test(absPath);
}
function isMigrationSql(absPath) {
  return SQL_EXT2.test(absPath);
}
function isPyAnalyzable(absPath) {
  return PY_EXT.test(absPath);
}
function isAnalyzable(absPath) {
  return isTsAnalyzable(absPath) || isMigrationSql(absPath) || isPyAnalyzable(absPath);
}
function bypassActive() {
  return process.env.CERBERUS_BYPASS === "1" || process.env.QUALITY_GATE_BYPASS === "1";
}
async function performCheck(opts) {
  const { cwd } = opts;
  const fullConfig = loadConfig(cwd);
  const enabledWithSecurity = [
    .../* @__PURE__ */ new Set([...fullConfig.preCommit.enabled, ...SECURITY_ANALYZERS])
  ];
  const config = {
    ...fullConfig,
    preCommit: {
      ...fullConfig.preCommit,
      enabled: opts.securityOnly ? enabledWithSecurity.filter((a) => SECURITY_ANALYZERS.has(a)) : enabledWithSecurity
    }
  };
  const isIgnored = makeIgnoreMatcher(fullConfig.ignore);
  const skipQuality = (abs) => {
    const rel = relKey(cwd, abs);
    return isIgnored(rel) || isBuildArtifactPath(rel);
  };
  const securityConfig = {
    ...config,
    preCommit: {
      ...config.preCommit,
      enabled: config.preCommit.enabled.filter((a) => SECURITY_ANALYZERS.has(a))
    }
  };
  const readStagedOrDisk = (abs) => {
    const staged = getStagedContent(cwd, relKey(cwd, abs));
    if (staged !== null) return staged;
    try {
      return readFileSync15(abs, "utf8");
    } catch {
      return null;
    }
  };
  const readSecuritySource = opts.staged ? readStagedOrDisk : void 0;
  const baseline = loadBaseline(cwd);
  const allStaged = opts.files.filter((f) => existsSync11(f));
  const files = allStaged.filter(isAnalyzable);
  const reports = [];
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
      qualitySkipped ? void 0 : baseline?.files[rel]
    );
    reports.push(report);
  }
  for (const abs of pyFiles) {
    const rel = relKey(cwd, abs);
    reports.push(
      await analyzePythonFile(rel, getFileContent(abs), skipQuality(abs) ? securityConfig : config)
    );
  }
  const notes = [];
  const enabled = new Set(config.preCommit.enabled);
  const setViolations = [];
  if (opts.mode === "pre-commit") {
    const tsQualityFiles = tsFiles.filter((f) => !skipQuality(f));
    if (enabled.has("duplication")) {
      setViolations.push(...analyzeDuplication(tsQualityFiles, cwd, config));
    }
    if (enabled.has("coverage")) {
      const cov = await analyzeCoverage(
        tsQualityFiles.map((f) => relKey(cwd, f)),
        cwd,
        baseline,
        config
      );
      if (cov.skipped && cov.reason) notes.push(`coverage: ${cov.reason}`);
      setViolations.push(...cov.violations);
    }
  }
  if (enabled.has("migration-safety") && sqlFiles.length > 0) {
    setViolations.push(...analyzeMigrationSafety(sqlFiles, cwd, readSecuritySource));
  }
  if (enabled.has("secret-in-diff") && allStaged.length > 0) {
    setViolations.push(...analyzeSecretInDiff(allStaged, cwd, readSecuritySource));
  }
  if (enabled.has("new-dependency") && allStaged.length > 0) {
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
  let status = anyViolation ? "QUALITY_GATE_FAIL" : "PASS";
  let exitCode = anyViolation ? 1 : 0;
  let attempt;
  if (anyViolation && opts.mode === "pre-commit") {
    const max = config.maxRefactorAttempts;
    const { count } = incrementAttempt(cwd, hashFileSet(files.map((f) => relKey(cwd, f))));
    attempt = `${count}/${max}`;
    const hasSecurityViolation = reports.some((r) => r.violations.some(isSecurityViolation));
    if (count > max && !hasSecurityViolation) {
      status = "PASS_WITH_TODO";
      exitCode = 0;
      const failing = reports.filter((r) => !r.passed);
      for (const r of failing) applyTodoInjection(cwd, r, attempt);
      stageFiles(cwd, failing.map((r) => r.file));
    } else if (count > max && hasSecurityViolation) {
      notes.push("security violations present \u2014 anti-doom-loop pass-through disabled");
    }
  }
  return {
    report: { status, passed: exitCode === 0, attempt, files: reports, notes: notes.length ? notes : void 0 },
    exitCode
  };
}
async function runCheck(args) {
  const cwd = process.cwd();
  const securityOnly = bypassActive();
  if (securityOnly) {
    process.stderr.write(
      chalk2.dim("quality-gate: QUALITY_GATE_BYPASS=1 \u2014 quality checks skipped, security checks still enforced\n")
    );
  }
  const staged = !args.file && !args.base;
  const files = args.file ? [toAbs(cwd, args.file)] : args.base ? getChangedFiles(cwd, args.base).map((f) => toAbs(cwd, f)) : getStagedFiles(cwd).map((f) => toAbs(cwd, f));
  const { report, exitCode } = await performCheck({ cwd, files, mode: args.mode, securityOnly, staged });
  if (args.format === "json") reportJson(report);
  else if (args.format === "github") reportGithub(report);
  else reportHuman(report);
  process.exit(exitCode);
}
async function runClaudeHook() {
  let payload;
  try {
    payload = JSON.parse(readFileSync15(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const command = payload.tool_input?.command ?? "";
  const cwd = payload.cwd ?? process.cwd();
  if (payload.tool_name !== "Bash" || !isGitCommit(command)) process.exit(0);
  const securityOnly = /\[skip-cerberus\]/.test(command) || /\[skip-quality\]/.test(command) || /\bCERBERUS_BYPASS=1\b/.test(command) || /\bQUALITY_GATE_BYPASS=1\b/.test(command) || bypassActive();
  const files = getStagedFiles(cwd).map((f) => toAbs(cwd, f));
  if (files.length === 0) process.exit(0);
  const { report, exitCode } = await performCheck({ cwd, files, mode: "pre-commit", securityOnly, staged: true });
  if (exitCode === 0) process.exit(0);
  const failing = report.files.filter((f) => !f.passed);
  const hasSecurity = failing.some((f) => f.violations.some(isSecurityViolation));
  const lines = failing.flatMap(
    (f) => f.violations.map(
      (v) => `  ${f.file} \u2014 ${v.analyzer} ${v.location}: ${v.current} > ${v.threshold}
    fix: ${v.suggestion}`
    )
  );
  process.stderr.write(
    `quality-gate blocked this commit (${failing.length} file(s)):
${lines.join("\n")}
` + (hasSecurity ? "Security violations must be fixed \u2014 they cannot be bypassed or deferred.\n" : "Fix the violations above and retry the commit.\n")
  );
  process.exit(2);
}
async function runClaudePostEditHook() {
  let payload;
  try {
    payload = JSON.parse(readFileSync15(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const toolName = payload.tool_name ?? "";
  if (!["Edit", "Write", "MultiEdit"].includes(toolName)) process.exit(0);
  const filePath = payload.tool_input?.file_path;
  if (!filePath) process.exit(0);
  const cwd = payload.cwd ?? process.cwd();
  const abs = toAbs(cwd, filePath);
  if (!existsSync11(abs)) process.exit(0);
  const { report, exitCode } = await performCheck({ cwd, files: [abs], mode: "post-edit" });
  if (exitCode === 0) process.exit(0);
  const failing = report.files.filter((f) => !f.passed);
  const lines = failing.flatMap(
    (f) => f.violations.map((v) => `  ${v.analyzer} ${v.location}: ${v.suggestion}`)
  );
  process.stderr.write(
    `quality-gate found issues in the file you just edited (fix them now \u2014 the commit will be blocked otherwise):
${lines.join("\n")}
`
  );
  process.exit(2);
}
function runInstallHooks(args) {
  const cwd = process.cwd();
  const existing = detectInstalledHook(cwd);
  if (existing.kind !== "none" && existing.hasMarker) {
    process.stdout.write(
      chalk2.green(`\u2713 already installed (${existing.kind}: ${existing.path})
`)
    );
    process.stdout.write(chalk2.dim("Use --force to re-install (not implemented yet).\n"));
    return;
  }
  if (args.dryRun) {
    let plan;
    if (existing.kind === "none") {
      const hooksDir = gitHooksDir(cwd);
      plan = hooksDir ? `would write fresh hook at ${hooksDir}/pre-commit` : 'not a git repository \u2014 would refuse to install (run "git init" or use Husky)';
    } else {
      plan = `would ${existing.kind === "husky" ? "append to" : "wrap"} ${existing.path}`;
    }
    process.stdout.write(chalk2.cyan(`(dry-run) ${plan}
`));
    process.stdout.write(chalk2.dim("Run without --dry-run to apply.\n"));
    return;
  }
  const { hookPath, wrapped, husky } = installGitHook(cwd);
  const settingsPath = registerClaudeHook(cwd);
  const suffix = husky ? " (appended to husky hook)" : wrapped ? " (wrapped existing hook)" : "";
  process.stdout.write(chalk2.green(`\u2713 git pre-commit hook: ${hookPath}${suffix}
`));
  process.stdout.write(chalk2.green(`\u2713 Claude Code PreToolUse hook: ${settingsPath}
`));
  process.stdout.write(chalk2.dim("Test with: git commit --allow-empty -m test\n"));
}
function runBaseline(args) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  if (existsSync11(resolve6(cwd, BASELINE_FILE)) && !args.force) {
    process.stderr.write(chalk2.red(`${BASELINE_FILE} already exists. Use --force to overwrite.
`));
    process.exit(1);
  }
  const files = walkTsFiles(cwd, config.ignore);
  const baseline = { version: 1, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), files: {} };
  for (const abs of files) {
    const rel = relKey(cwd, abs);
    baseline.files[rel] = computeFileBaseline(rel, readFileSync15(abs, "utf8"));
  }
  const coverage = collectCoverageForBaseline(cwd, config.preCommit.timeoutMs);
  if (coverage) {
    let covered = 0;
    for (const [rel, pct] of coverage) {
      if (baseline.files[rel]) {
        baseline.files[rel].metrics.coverage.percent = pct;
        covered += 1;
      }
    }
    process.stdout.write(chalk2.dim(`coverage baseline: ${covered} file(s)
`));
  } else {
    process.stdout.write(chalk2.dim("coverage baseline: skipped (no vitest/coverage data)\n"));
  }
  saveBaseline(cwd, baseline);
  process.stdout.write(
    chalk2.green(`\u2713 baseline: ${Object.keys(baseline.files).length} files \u2192 ${BASELINE_FILE}
`)
  );
}
function runRefreshBaseline(args) {
  const cwd = process.cwd();
  let targets = [];
  if (args.allDrifted) {
    targets = listDrift(cwd).map((d) => d.file);
    if (targets.length === 0) {
      process.stdout.write(chalk2.green("\u2713 no drift \u2014 nothing to refresh\n"));
      return;
    }
  } else if (args.stdin) {
    targets = readFileSync15(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  } else if (args.file && args.file.length) {
    targets = args.file;
  } else {
    process.stderr.write(
      chalk2.red("Provide --file <path> (repeatable), --all-drifted, or --stdin\n")
    );
    process.exit(1);
  }
  const baseline = loadBaseline(cwd) ?? {
    version: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    files: {}
  };
  let updated = 0;
  for (const p of targets) {
    const abs = toAbs(cwd, p);
    if (!existsSync11(abs)) {
      process.stderr.write(chalk2.yellow(`skip (not found): ${p}
`));
      continue;
    }
    const rel = relKey(cwd, abs);
    baseline.files[rel] = computeFileBaseline(rel, readFileSync15(abs, "utf8"));
    process.stdout.write(chalk2.green(`\u2713 re-baselined ${rel}
`));
    updated += 1;
  }
  if (updated > 0) {
    baseline.generatedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveBaseline(cwd, baseline);
  }
  process.stdout.write(chalk2.dim(`${updated} file(s) updated
`));
}
function runAudit(args) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const root = args.path ? toAbs(cwd, args.path) : cwd;
  const top = args.top ?? 10;
  const rows = walkTsFiles(root, config.ignore).map((abs) => {
    const rel = relKey(cwd, abs);
    const content = readFileSync15(abs, "utf8");
    const cognitive = measureCognitive(rel, content).reduce((m, s) => Math.max(m, s.score), 0);
    const cyclomatic = measureCyclomatic(rel, content).reduce((m, s) => Math.max(m, s.score), 0);
    const ts2 = measureTypeSafety(rel, content);
    return {
      file: rel,
      cognitive,
      cyclomatic,
      any: ts2.anyCount,
      worst: Math.max(cognitive, cyclomatic)
    };
  });
  rows.sort((a, b) => b.worst - a.worst);
  const shown = rows.slice(0, top);
  if (args.format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: JSON_SCHEMA_VERSION,
          scanned: rows.length,
          top: shown.length,
          rows: shown
        },
        null,
        2
      )}
`
    );
    return;
  }
  process.stdout.write(
    chalk2.bold(`
Top ${shown.length} files by complexity (of ${rows.length} scanned)

`)
  );
  process.stdout.write(chalk2.dim("  cog  cyc  any  file\n"));
  for (const r of shown) {
    process.stdout.write(
      `  ${String(r.cognitive).padStart(3)}  ${String(r.cyclomatic).padStart(3)}  ${String(r.any).padStart(3)}  ${r.file}
`
    );
  }
  process.stdout.write("\n");
}
function runDoctor(args) {
  const cwd = process.cwd();
  const verbose = args.verbose ?? false;
  const json = args.format === "json";
  const hasConfig = existsSync11(resolve6(cwd, CONFIG_FILE));
  const baseline = loadBaseline(cwd);
  const drifted = baseline ? listDrift(cwd) : [];
  const hook = detectInstalledHook(cwd);
  const bypass = bypassActive();
  let ok = true;
  const lines = [];
  const line = (good, msg) => {
    lines.push({ good, msg });
    if (!good) ok = false;
  };
  line(hasConfig, hasConfig ? `${CONFIG_FILE} found` : `${CONFIG_FILE} missing (using defaults)`);
  if (!baseline) {
    line(false, `${BASELINE_FILE} missing \u2014 run "quality-gate baseline"`);
  } else {
    const total = Object.keys(baseline.files).length;
    line(true, `${BASELINE_FILE}: ${total} files`);
    if (drifted.length === 0) {
      line(true, "baseline up to date");
    } else {
      line(
        false,
        `${drifted.length} file(s) drifted from baseline \u2014 see "quality-gate drift"`
      );
    }
  }
  if (hook.kind === "none") {
    line(false, 'git pre-commit hook missing \u2014 run "quality-gate install-hooks"');
  } else if (!hook.hasMarker) {
    line(
      false,
      `pre-commit hook present (${hook.kind}: ${hook.path}) but quality-gate not wired \u2014 run "quality-gate install-hooks"`
    );
  } else {
    line(true, `pre-commit hook installed (${hook.kind}: ${hook.path})`);
  }
  if (bypass) line(false, "QUALITY_GATE_BYPASS=1 is active \u2014 gate disabled this session");
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: JSON_SCHEMA_VERSION,
          ok,
          config: { found: hasConfig, path: CONFIG_FILE },
          baseline: baseline ? { found: true, total: Object.keys(baseline.files).length, drifted: drifted.length } : { found: false, total: 0, drifted: 0 },
          drifted: drifted.map((d) => ({
            file: d.file,
            direction: d.direction,
            deltas: d.deltas
          })),
          hook,
          bypass
        },
        null,
        2
      )}
`
    );
    process.exit(0);
  }
  process.stdout.write(chalk2.bold("\nquality-gate doctor\n\n"));
  for (const l of lines) {
    process.stdout.write(`  ${l.good ? chalk2.green("\u2713") : chalk2.yellow("\u2022")} ${l.msg}
`);
  }
  if (drifted.length > 0) {
    const limit = verbose ? drifted.length : Math.min(20, drifted.length);
    process.stdout.write("\n");
    for (const d of drifted.slice(0, limit)) {
      const arrow = d.direction === "degraded" ? chalk2.yellow("\u2191") : d.direction === "improved" ? chalk2.green("\u2193") : chalk2.dim("\xB7");
      process.stdout.write(`      ${arrow} ${d.file}
`);
    }
    if (drifted.length > limit) {
      process.stdout.write(
        chalk2.dim(`      \u2026 and ${drifted.length - limit} more (use --verbose)
`)
      );
    }
  }
  process.stdout.write(
    `
${ok ? chalk2.green("All good.") : chalk2.yellow("Some checks need attention.")}

`
  );
  process.exit(0);
}
function runDrift(args) {
  const cwd = process.cwd();
  const drifted = listDrift(cwd);
  if (args.format === "json") {
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
              anyCount: d.baseline.metrics.typeSafety.anyCount
            },
            current: {
              cognitiveMax: d.current.metrics.cognitiveComplexity.max,
              cyclomaticMax: d.current.metrics.cyclomaticComplexity.max,
              anyCount: d.current.metrics.typeSafety.anyCount
            }
          }))
        },
        null,
        2
      )}
`
    );
    return;
  }
  if (drifted.length === 0) {
    process.stdout.write(chalk2.green("\u2713 no drift \u2014 baseline matches working tree\n"));
    return;
  }
  const cell = (curr, delta) => {
    const d = delta === 0 ? " 0" : delta > 0 ? `+${delta}` : `${delta}`;
    return `${String(curr).padStart(3)} (${d.padStart(3)})`;
  };
  process.stdout.write(chalk2.bold(`
${drifted.length} file(s) drifted

`));
  process.stdout.write(chalk2.dim("  dir   cog (\u0394)    cyc (\u0394)    any (\u0394)   file\n"));
  for (const d of drifted) {
    const arrow = d.direction === "degraded" ? chalk2.yellow("\u2191") : d.direction === "improved" ? chalk2.green("\u2193") : chalk2.dim("\xB7");
    process.stdout.write(
      `  ${arrow}   ${cell(d.current.metrics.cognitiveComplexity.max, d.deltas.cognitiveMax)}  ${cell(d.current.metrics.cyclomaticComplexity.max, d.deltas.cyclomaticMax)}  ${cell(d.current.metrics.typeSafety.anyCount, d.deltas.anyCount)}  ${d.file}
`
    );
  }
  process.stdout.write(
    "\n" + chalk2.dim("Refresh: quality-gate refresh-baseline --all-drifted\n")
  );
}
function runDiff(args) {
  const cwd = process.cwd();
  const baseline = loadBaseline(cwd);
  if (!baseline) {
    process.stderr.write(chalk2.red('No baseline \u2014 run "quality-gate baseline" first.\n'));
    process.exit(1);
  }
  const drift = listDrift(cwd);
  const detailed = drift.map((d) => {
    const cogBase = baseline.files[d.file].metrics.cognitiveComplexity.perFunction;
    const cogCurr = d.current.metrics.cognitiveComplexity.perFunction;
    const cycBase = baseline.files[d.file].metrics.cyclomaticComplexity.perFunction;
    const cycCurr = d.current.metrics.cyclomaticComplexity.perFunction;
    const fnNames = /* @__PURE__ */ new Set([
      ...Object.keys(cogBase),
      ...Object.keys(cogCurr),
      ...Object.keys(cycBase),
      ...Object.keys(cycCurr)
    ]);
    const functions = [...fnNames].map((name) => ({
      name,
      cognitive: {
        baseline: cogBase[name] ?? 0,
        current: cogCurr[name] ?? 0,
        delta: (cogCurr[name] ?? 0) - (cogBase[name] ?? 0)
      },
      cyclomatic: {
        baseline: cycBase[name] ?? 0,
        current: cycCurr[name] ?? 0,
        delta: (cycCurr[name] ?? 0) - (cycBase[name] ?? 0)
      }
    })).filter((f) => f.cognitive.delta !== 0 || f.cyclomatic.delta !== 0).sort((a, b) => Math.abs(b.cognitive.delta) - Math.abs(a.cognitive.delta));
    return { file: d.file, direction: d.direction, functions };
  });
  if (args.format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        { schemaVersion: JSON_SCHEMA_VERSION, files: detailed },
        null,
        2
      )}
`
    );
    return;
  }
  if (detailed.length === 0) {
    process.stdout.write(chalk2.green("\u2713 no diff \u2014 working tree matches baseline\n"));
    return;
  }
  for (const f of detailed) {
    process.stdout.write("\n" + chalk2.underline(f.file) + chalk2.dim(`  (${f.direction})
`));
    if (f.functions.length === 0) {
      process.stdout.write(chalk2.dim("  (content changed but no per-function metric delta)\n"));
      continue;
    }
    for (const fn of f.functions) {
      const cogD = fn.cognitive.delta;
      const cycD = fn.cyclomatic.delta;
      const tag = (label, base, curr, d) => {
        if (d === 0) return "";
        const sign = d > 0 ? chalk2.yellow(`+${d}`) : chalk2.green(`${d}`);
        return `${chalk2.dim(label)}: ${base}\u2192${curr} (${sign})  `;
      };
      process.stdout.write(
        `  ${chalk2.cyan(fn.name)}  ${tag("cog", fn.cognitive.baseline, fn.cognitive.current, cogD)}${tag("cyc", fn.cyclomatic.baseline, fn.cyclomatic.current, cycD)}
`
      );
    }
  }
  process.stdout.write("\n");
}
await yargs(hideBin(process.argv)).scriptName("quality-gate").command(
  "check",
  "Run analyzers against staged files or a single file",
  (y) => y.option("file", { type: "string", describe: "Analyze a single file" }).option("staged", { type: "boolean", describe: "Analyze staged files" }).option("base", {
    type: "string",
    describe: "CI mode: analyze files changed vs. a base ref (e.g. origin/main)"
  }).option("mode", {
    choices: ["pre-commit", "post-edit"],
    describe: "Enforcement mode (pre-commit counts attempts)"
  }).option("format", { choices: ["json", "human", "github"], default: "human" }).check((a) => {
    if (!a.file && !a.staged && !a.base) {
      throw new Error("Provide --file <path>, --staged, or --base <ref>");
    }
    return true;
  }),
  (a) => runCheck(a)
).command(
  "baseline",
  "Snapshot current metrics into the baseline file",
  (y) => y.option("force", { type: "boolean", describe: "Overwrite an existing baseline" }),
  (a) => runBaseline(a)
).command(
  "refresh-baseline",
  "Recompute the baseline for one or more files",
  (y) => y.option("file", {
    type: "string",
    array: true,
    describe: "File(s) to re-baseline (repeatable)"
  }).option("all-drifted", {
    type: "boolean",
    describe: "Re-baseline every drifted file"
  }).option("stdin", {
    type: "boolean",
    describe: "Read newline-separated paths from stdin"
  }),
  (a) => runRefreshBaseline(a)
).command(
  "audit [path]",
  "List the worst files by complexity",
  (y) => y.positional("path", { type: "string", describe: "Directory to scan (default: cwd)" }).option("top", { type: "number", default: 10, describe: "How many files to show" }).option("format", { choices: ["json", "human"], default: "human" }),
  (a) => runAudit(a)
).command(
  "drift",
  "List files whose content drifted from the baseline",
  (y) => y.option("format", { choices: ["json", "human"], default: "human" }),
  (a) => runDrift(a)
).command(
  "diff",
  "Show per-function deltas between working tree and baseline",
  (y) => y.option("format", { choices: ["json", "human"], default: "human" }),
  (a) => runDiff(a)
).command(
  "doctor",
  "Diagnose config, baseline and hook state",
  (y) => y.option("format", { choices: ["json", "human"], default: "human" }).option("verbose", { type: "boolean", default: false, describe: "Show all drifted files" }),
  (a) => runDoctor(a)
).command(
  "install-hooks",
  "Install the git pre-commit hook and register the Claude Code hook",
  (y) => y.option("dry-run", {
    type: "boolean",
    describe: "Print planned action and exit without writing"
  }),
  (a) => runInstallHooks(a)
).command("claude-hook", false, {}, () => runClaudeHook()).command("claude-post-edit-hook", false, {}, () => runClaudePostEditHook()).demandCommand(1).strict().help().parseAsync();
