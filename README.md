# Cerberus

> Formerly `code-quality-gate`. Renamed with **full backward compatibility** — the old
> binary name (`quality-gate`), config files (`.quality-gate.json`), presets
> (`@quality-gate/*`), suppress comments (`// quality-gate-allow:`), and `QUALITY_GATE_BYPASS`
> all still work as aliases. See [PUBLISH-CERBERUS.md](./PUBLISH-CERBERUS.md) for the rename map.

The deterministic **quality & security gate** for AI-agent-generated **TypeScript,
JavaScript, and Python** — the engine half of the **Cerberus** suite (the orchestrator half
is [`no-mistakes`](./decisions/0001-no-mistakes-integration-be-safe.md)). It measures quality
on the **files you touch** (not the whole repo) and blocks commits that regress past
configurable thresholds — using **delta vs. a baseline**, so legacy code isn't forced to
refactor.

> Private / internal tool. Consumed by the product repos as a git devDependency.

Canonical names: binary `cerberus`, config `.cerberus.json`, baseline `.cerberus-baseline.json`,
presets `@cerberus/{nextjs,monorepo-turborepo,node-cli}`, suppress `// cerberus-allow: <rule>`,
bypass `CERBERUS_BYPASS=1` / `[skip-cerberus]`.

## What it checks

| Analyzer | What it flags | Default limit |
|---|---|---|
| Cognitive complexity | Hard-to-follow functions (Sonar metric) | 15 (.ts) / 20 (.tsx) |
| Cyclomatic complexity | Too many branches (McCabe) | 10 |
| Type safety | New `any`, `as unknown as`, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` | 0 new |
| Coverage delta | Coverage dropping below baseline (vitest) | no drop |
| Duplication | Copy-paste blocks (jscpd, staged files only) | 30 lines |
| Transaction required | 2+ Drizzle mutations in a `'use server'` function without `db.transaction(...)` (DDIA ch.7) | 1 mutation |
| Revalidate required | Server Action that mutates without `revalidatePath`/`revalidateTag`/`redirect` | — |
| N+1 query | `await db.*` inside a `for`/`while`/`.map`/`.forEach` over an array (DDIA ch.2) | 0 |
| Migration safety | `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN/TABLE`, `ALTER COLUMN TYPE`, `SET NOT NULL` without DEFAULT in staged `.sql` (DDIA ch.4) | 0 |
| Silent catch | `catch {}` or `catch (e) { console.log(e) }` — error swallowing (Clean Code §7) | 0 |
| Hallucinated import | Import of a package not present in any reachable `package.json` (LLM anti-pattern) | 0 |
| Shallow module | Exported function that's a one-statement pass-through (Ousterhout, *A Philosophy of Software Design* ch.4) | 0 new |
| Function length | Function body lines (Clean Code §3 — "functions should be small") | 80 lines |
| Parameter count | Number of parameters per function (Clean Code §3.4) | 4 |
| Secret in diff | OpenAI/Anthropic/GitHub/GitLab/Slack/AWS/Google/Stripe/npm keys, JWTs, PEM private keys, connection strings with credentials, `.env` files in staged | 0 |
| Injection | `eval`/`new Function`, `exec()` with interpolated commands, `sql.raw()`/`.execute()`/`.query()` with interpolated SQL, unsanitized `dangerouslySetInnerHTML` | 0 |
| New dependency | Dependency added to `package.json` with no lockfile entry (slopsquatting guard) | 0 |

Complexity, type-safety, transaction-required, revalidate-required, n-plus-one-query, silent-catch, hallucinated-import, shallow-module, function-length and parameter-count run per file; coverage, duplication, migration-safety and secret-in-diff run once over the staged set. Coverage/duplication run only at commit time; migration-safety runs whenever staged `.sql` is present; secret-in-diff scans every staged file regardless of extension.

### Notes on the DDIA-inspired analyzers

- **transaction-required** only fires in files starting with `'use server'`. A single mutation is allowed (atomic by definition). 2+ mutations must live inside a `db.transaction(async (tx) => ...)` callback (or the enclosing function must itself already be inside one).
- **revalidate-required** only audits exported async functions in `'use server'` files (the Server Action surface). A mutating action that calls `revalidatePath`, `revalidateTag`, or `redirect` is considered fine.
- **n-plus-one-query** matches `await <db|tx|trx|database>.*` inside loop bodies and inside callbacks passed to `map`/`forEach`/`flatMap`/`filter`/`reduce`. Accepts a small false-positive risk in exchange for catching the dominant LLM anti-pattern; suppress with `[skip-quality]` when needed.
- **migration-safety** parses staged `.sql` files (typically `packages/db/drizzle/*.sql`) with focused regexes. Comments are stripped, so doc-only mentions of `DROP COLUMN` do not trigger. `SET NOT NULL` is allowed when the same statement also `SET DEFAULT`s the column.

### Notes on the AI-agent-specific analyzers

- **silent-catch** flags empty catch blocks and catches whose body is only `console.*` calls — the #1 way an LLM "fixes" a failing test. Rethrows, returns, assignments, or any call beyond `console.*`/`logger.*`/`log.*` count as real handling.
- **hallucinated-import** walks up to the repo root collecting every `package.json`'s declared dependency names and checks each import specifier against that union. Local paths (`./`, `../`, `@/`, `~/`) and node builtins are skipped. If no `package.json` is found at all, the analyzer no-ops (the file is being analyzed outside a project).
- **shallow-module** only fires on `export`ed top-level functions whose body is a single return-of-call, a single call statement, or a `const x = call(); return x` pair. Suppress with a `// quality-gate-allow: shallow-module` line comment when the indirection is intentional (testing seam, public API stability).
- **function-length / parameter-count** are delta-aware: a function already over the limit in the baseline isn't blocked unless the change makes it worse. New functions are held to the absolute threshold.
- **secret-in-diff** runs on every staged path (not just `.ts`/`.sql`). It matches distinctive prefixes only (`sk-`, `ghp_`, `glpat-`, `xox?-`, `AKIA`, `AIza`, `sk_live_`, `whsec_`, `npm_`, `eyJ…`, PEM `-----BEGIN … PRIVATE KEY-----`, and `scheme://user:password@` connection strings with non-placeholder passwords) and blocks any committed `.env` / `.env.*` file (except `.env.example` / `.env.sample` / `.env.template`). Suppress per line with `// quality-gate-allow: secret` for test fixtures.
- **injection** flags the injection sinks LLMs most often produce: `eval`/`new Function`, `exec`/`execSync` with interpolated commands (and `spawn` with `{ shell: true }`), `sql.raw()` with non-literals, `.execute()`/`.query()` with interpolated/concatenated SQL, and `dangerouslySetInnerHTML` with unsanitized dynamic content. Tagged templates (``db.execute(sql`…`)``) are parameterized and never flagged. Suppress per line with `// quality-gate-allow: injection`.
- **new-dependency** guards against slopsquatting: a dep that is new in a staged `package.json` must already have a lockfile entry (i.e., a registry actually resolved it during an install). A name written straight into the manifest with no lockfile entry is exactly how a hallucinated/squatted package lands. No lockfile in the project → the analyzer stays quiet.

## How it works

- **Delta, not absolute.** `quality-gate baseline` snapshots current metrics into `.quality-gate-baseline.json`. The gate only blocks when a touched file gets *worse* than its baseline. New files (no baseline) are held to the absolute threshold.
- **Anti-doom-loop.** After `maxRefactorAttempts` (default 2) failed commits on the same file set within 30 min, the gate lets the commit through, injecting `// TODO: quality-gate(...)` flags so the debt is tracked instead of looping forever. **Quality violations only** — see the security tier below.
- **Four triggers, one CLI.** A Claude Code `PostToolUse(Edit|Write)` hook gives the agent feedback seconds after it writes the code; a git `pre-commit` hook catches terminal commits; a Claude Code `PreToolUse(Bash)` hook catches an agent's `git commit`; `check --base <ref>` runs in CI as the PR-blocking enforcement point.

## Python support

`.py` files flow through the same gate. v1 covers the presence-based analyzers — same names, same config, same severity tier as the TS versions:

- **silent-catch**: `except: pass` / `except: ...` and except bodies that only `print`/`logging.*`.
- **injection** (security): `eval`/`exec` with dynamic input, `os.system` / `subprocess(shell=True)` with f-strings or concatenation, `cursor.execute()` with f-string/`%`/`.format()` SQL instead of parameterized queries.
- **hallucinated-import**: imports not declared in `pyproject.toml` (PEP 621 or Poetry) / `requirements*.txt`, with stdlib, local-module, and alias (`yaml`→`pyyaml`, `cv2`→`opencv-python`, …) handling.
- **new-dependency** (security): new deps in a staged `pyproject.toml` must have a `poetry.lock`/`uv.lock`/`pdm.lock` entry.
- **secret-in-diff** already scans every staged file, including `.py`.

Complexity/function-shape metrics for Python (with baseline support) are a planned follow-up. Suppressions use the comment form: `# quality-gate-allow: injection`.

## JavaScript support

`.js`, `.mjs`, `.jsx`, and `.cjs` files flow through the **same gate as TypeScript** — no rename required, which is what makes a `checkJs` + JSDoc codebase enforceable. Source is parsed to an AST with `allowJs`, so **every analyzer except `type-safety` runs on `.js` exactly as on `.ts`** — same metrics, limits, security tier, and delta-vs-baseline grandfathering. That covers the complexity/shape analyzers (cognitive- & cyclomatic-complexity, function-length, parameter-count, shallow-module), the presence-based ones (silent-catch, injection, hallucinated-import, n-plus-one-query, transaction/revalidate-required), and the staged-set passes (duplication, secret-in-diff, new-dependency, migration-safety).

- **type-safety is a no-op on JavaScript** — it's the only analyzer that needs the TS type-checker. A `checkJs` + JSDoc migration keeps its `@ts-expect-error` / `@ts-ignore` deferrals and `@type {any}` JSDoc in `.js` files, and the gate does **not** flag them as new-`any` regressions (they're a typing-migration tool, not a TS escape hatch).
- **`.d.ts`** files are excluded from analysis (still scanned by secret-in-diff).
- Anonymous functions are grandfathered against the file's baseline maximum, so adding `// @ts-check` + JSDoc (which shifts line numbers) never produces a false complexity/length regression.
- Suppressions use the same line-comment form as TS: `// quality-gate-allow: shallow-module`.

## Security tier (non-bypassable)

`secret-in-diff`, `migration-safety`, `injection`, and `new-dependency` are **security analyzers**, and every escape hatch is closed for them:

- The anti-doom-loop never passes a security violation through — a leaked key with a `// TODO` is still leaked.
- `QUALITY_GATE_BYPASS=1` and `[skip-quality]` downgrade the gate to security-only instead of disabling it.
- They cannot be disabled via `.quality-gate.json` — the config lives in the repo, which a blocked agent can edit, so it doesn't get a vote on security.
- The error messages shown to a blocked agent contain **no bypass instructions**.

Per-line suppressions (`// quality-gate-allow: secret` / `injection`) still work — they are visible in the diff, so a human reviewer sees every exception.

## CI mode (the real gate)

Pre-commit hooks are advisory — anything local can be bypassed with `--no-verify`. The PR is the enforcement point:

```yaml
# .github/workflows/quality-gate.yml (consumer project)
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- run: npx quality-gate check --base "origin/${{ github.base_ref }}" --format github
```

`--format github` emits workflow commands, so every violation shows up as an **inline annotation on the PR diff** (with a `[SECURITY]` tag where applicable) instead of a log line nobody opens.

`check --base <ref>` analyzes every file changed vs. the merge-base (`ref...HEAD`), exactly what the PR diff shows. See this repo's own `.github/workflows/quality-gate.yml` for a complete example.

## Quickstart

> Full installation guide (including CI, Python notes, and agent rules): **[INSTALL.md](./INSTALL.md)**. With the plugin installed, the `/quality-setup` command walks an agent through the whole setup.

```bash
# 1. From the project root, create a config (pick a preset)
echo '{ "extends": "@quality-gate/nextjs" }' > .quality-gate.json

# 2. Snapshot the current state as the floor
npx quality-gate baseline

# 3. Install the git + Claude Code hooks
npx quality-gate install-hooks

# 4. Commit as usual — the gate runs automatically
git commit -m "..."
```

`install-hooks` is idempotent and **wraps** any existing `pre-commit` hook (backing it up to `pre-commit.backup-quality-gate`). It also registers two Claude Code hooks in `.claude/settings.json`: `PreToolUse(Bash)` (blocks failing agent commits) and `PostToolUse(Edit|Write|MultiEdit)` (runs the gate on each file the agent edits and feeds violations back immediately — the cheapest point to fix).

## Commands

| Command | Purpose |
|---|---|
| `quality-gate baseline [--force]` | Snapshot metrics into `.quality-gate-baseline.json` |
| `quality-gate check --staged [--mode pre-commit] [--format json\|human]` | Run the gate on staged files |
| `quality-gate check --file <path>` | Run the gate on one file (fast, no coverage/duplication) |
| `quality-gate check --base <ref>` | CI mode: run the gate on files changed vs. a base ref |
| `quality-gate audit [path] [--top N]` | List the worst files by complexity |
| `quality-gate refresh-baseline --file <path>` | Re-baseline one file after a deliberate refactor |
| `quality-gate install-hooks` | Install the git pre-commit + Claude Code hooks |
| `quality-gate doctor` | Diagnose config, baseline drift, and hook state |

Slash commands (`/quality-check`, `/quality-baseline`) and the `/quality-audit` skill are available when installed as a Claude Code plugin.

## Config

`.quality-gate.json` at the project root. Extend a preset and override only what you need:

```json
{
  "extends": "@quality-gate/nextjs",
  "ignore": ["**/*.test.{ts,tsx}", "**/migrations/**"],
  "preCommit": { "enabled": ["cognitive", "cyclomatic", "type-safety"] }
}
```

Presets: `@quality-gate/nextjs`, `@quality-gate/monorepo-turborepo`, `@quality-gate/node-cli`.

## Bypasses (quality analyzers only)

- `QUALITY_GATE_BYPASS=1 git commit ...` — skip the quality analyzers for one command/session.
- `[skip-quality]` in the commit message — quality analyzers skipped by the Claude Code hook.

Both bypasses keep the security analyzers running (see "Security tier"). There is no flag that skips a secret scan.

## Troubleshooting

- **Baseline drift** — `quality-gate doctor` lists files whose content diverged from the baseline; `refresh-baseline --file <path>` re-snapshots one.
- **Coverage skipped** — coverage only runs when vitest is detected and a meaningful baseline exists; otherwise it's silently skipped (never fails the gate).
- **False positive on legacy code** — that file likely isn't in the baseline. Run `quality-gate baseline` (or `refresh-baseline --file`).

## Distribution (internal)

`pnpm pack:plugin` produces `code-quality-gate.plugin` (a zip of `plugin.json`, `hooks/`, `skills/`, `commands/`, `dist/`, `README.md`). The CLI bundles its own analyzers but invokes `jscpd` as a subprocess and resolves `ts-morph` from disk, so the install location must have the plugin's `node_modules` available.

## Requirements

- Node 20+
- A git repository
- (Optional) `vitest` in the consumer project for the coverage analyzer
