# Analyzers

The full list of what Cerberus checks, the limits, and the design notes behind each one.
For configuration and CLI usage see [configuration.md](./configuration.md); for CI and language support see [ci-and-languages.md](./ci-and-languages.md).

| Analyzer | What it flags | Default limit |
|---|---|---|
| Cognitive complexity | Hard-to-follow functions (Sonar metric) | 15 (.ts) / 20 (.tsx) |
| Cyclomatic complexity | Too many branches (McCabe) | 10 |
| Type safety | New `any`, `as unknown as`, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` | 0 new |
| Coverage delta | Coverage dropping below baseline (vitest) — **opt-in** | no drop |
| Duplication | Copy-paste blocks (jscpd, staged files only) | 30 lines |
| Transaction required | 2+ Drizzle mutations in a `'use server'` function without `db.transaction(...)` (DDIA ch.7) | 1 mutation |
| Revalidate required | Server Action that mutates without `revalidatePath`/`revalidateTag`/`redirect` | n/a |
| N+1 query | `await db.*` inside a `for`/`while`/`.map`/`.forEach` over an array (DDIA ch.2) | 0 |
| Migration safety | `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN/TABLE`, `ALTER COLUMN TYPE`, `SET NOT NULL` without DEFAULT in staged `.sql` (DDIA ch.4) | 0 |
| Silent catch | `catch {}` / `catch (e) { console.log(e) }` that swallows errors (Clean Code §7) | 0 |
| Hallucinated import | Import of a package not present in any reachable `package.json` (LLM anti-pattern) | 0 |
| Shallow module | Exported function that's a one-statement pass-through (Ousterhout, *A Philosophy of Software Design* ch.4) | 0 new |
| Function length | Function body lines (Clean Code §3, "functions should be small") | 80 lines |
| Parameter count | Number of parameters per function (Clean Code §3.4) | 4 |
| Secret in diff | OpenAI/Anthropic/GitHub/GitLab/Slack/AWS/Google/Stripe/npm keys, JWTs, PEM private keys, connection strings with credentials, `.env` files in staged | 0 |
| Injection | `eval`/`new Function`, `exec()` with interpolated commands, `sql.raw()`/`.execute()`/`.query()` with interpolated SQL, unsanitized `dangerouslySetInnerHTML` | 0 |
| New dependency | Dependency added to `package.json` with no lockfile entry (slopsquatting guard) | 0 |

Complexity, type-safety, transaction-required, revalidate-required, n-plus-one-query, silent-catch, hallucinated-import, shallow-module, function-length and parameter-count run per file; coverage, duplication, migration-safety and secret-in-diff run once over the staged set.
Duplication runs at commit time; migration-safety runs whenever staged `.sql` is present; secret-in-diff scans every staged file regardless of extension.
**Coverage is opt-in** — it spawns a `vitest` run, which is too heavy for a default pre-commit hook, so it ships disabled. Add `"coverage"` to `preCommit.enabled` (and run `cerberus baseline` with vitest data present) to turn it on.

## Notes on the DDIA-inspired analyzers

- **transaction-required** only fires in files starting with `'use server'`. A single mutation is allowed (atomic by definition). 2+ mutations must live inside a `db.transaction(async (tx) => ...)` callback (or the enclosing function must itself already be inside one).
- **revalidate-required** only audits exported async functions in `'use server'` files (the Server Action surface). A mutating action that calls `revalidatePath`, `revalidateTag`, or `redirect` is considered fine.
- **n-plus-one-query** matches `await <db|tx|trx|database>.*` inside loop bodies and inside callbacks passed to `map`/`forEach`/`flatMap`/`filter`/`reduce`. Accepts a small false-positive risk in exchange for catching the dominant LLM anti-pattern; suppress with `[skip-cerberus]` when needed.
- **migration-safety** parses staged `.sql` files (typically `packages/db/drizzle/*.sql`) with focused regexes. Comments are stripped, so doc-only mentions of `DROP COLUMN` do not trigger. `SET NOT NULL` is allowed when the same statement also `SET DEFAULT`s the column.

## Notes on the AI-agent-specific analyzers

- **silent-catch** flags empty catch blocks and catches whose body is only `console.*` calls, the most common way an LLM "fixes" a failing test. Rethrows, returns, assignments, or any call beyond `console.*`/`logger.*`/`log.*` count as real handling.
- **hallucinated-import** walks up to the repo root collecting every `package.json`'s declared dependency names and checks each import specifier against that union. Local paths (`./`, `../`, `@/`, `~/`) and node builtins are skipped. If no `package.json` is found at all, the analyzer no-ops (the file is being analyzed outside a project).
- **shallow-module** only fires on `export`ed top-level functions whose body is a single return-of-call, a single call statement, or a `const x = call(); return x` pair. It is **delta-aware**: legacy pass-throughs captured in the baseline are grandfathered (a touched utils file full of one-line exports won't flood the gate); only a file gaining more shallow modules than its snapshot is blocked. New files (no baseline) are held to the absolute threshold. Suppress with a `// cerberus-allow: shallow-module` line comment when an individual indirection is intentional (testing seam, public API stability).
- **function-length / parameter-count** are delta-aware: a function already over the limit in the baseline isn't blocked unless the change makes it worse. New functions are held to the absolute threshold.
- **secret-in-diff** runs on every staged path (not just `.ts`/`.sql`). It matches distinctive prefixes only (`sk-`, `ghp_`, `glpat-`, `xox?-`, `AKIA`, `AIza`, `sk_live_`, `whsec_`, `npm_`, `eyJ...`, PEM `-----BEGIN ... PRIVATE KEY-----`, and `scheme://user:password@` connection strings with non-placeholder passwords) and blocks any committed `.env` / `.env.*` file (except `.env.example` / `.env.sample` / `.env.template`). Suppress per line with `// cerberus-allow: secret` for test fixtures.
- **injection** flags the injection sinks LLMs most often produce: `eval`/`new Function`, `exec`/`execSync` with interpolated commands (and `spawn` with `{ shell: true }`), `sql.raw()` with non-literals, `.execute()`/`.query()` with interpolated/concatenated SQL, and `dangerouslySetInnerHTML` with unsanitized dynamic content. Tagged templates (``db.execute(sql`...`)``) are parameterized and never flagged. Suppress per line with `// cerberus-allow: injection`.
- **new-dependency** guards against slopsquatting: a dep that is new in a staged `package.json` must already have a lockfile entry (i.e., a registry actually resolved it during an install). A name written straight into the manifest with no lockfile entry is exactly how a hallucinated/squatted package lands. No lockfile in the project means the analyzer stays quiet.

## How the gate decides

- **Delta, not absolute.** `cerberus baseline` snapshots current metrics into `.cerberus-baseline.json`. The gate only blocks when a touched file gets *worse* than its baseline. New files (no baseline) are held to the absolute threshold.
- **Anti-doom-loop.** After `maxRefactorAttempts` (default 2) failed commits on the same file set within 30 min, the gate lets the commit through, injecting `// TODO: cerberus(...)` flags so the debt is tracked instead of looping forever. **Quality violations only**: security violations never pass (see [the security tier](./ci-and-languages.md#security-tier-non-bypassable)).
- **Four triggers, one CLI.** A Claude Code `PostToolUse(Edit|Write)` hook gives the agent feedback seconds after it writes the code; a git `pre-commit` hook catches terminal commits; a Claude Code `PreToolUse(Bash)` hook catches an agent's `git commit`; `check --base <ref>` runs in CI as the PR-blocking enforcement point.
