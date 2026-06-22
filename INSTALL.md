# Installing Cerberus into a project

Step-by-step for wiring **Cerberus** into a consumer repo (TypeScript, JavaScript, Python, or any mix).
Written so a human **or a coding agent** can execute it top to bottom.

## 0. Requirements

- Node 20+ available in the project (the CLI is Node-based even for Python repos)
- A git repository

## 1. Install Cerberus (git dependency)

Cerberus is distributed as a **git dependency** — it is not published to the public npm registry, so don't `npx cerberus` (that name belongs to an unrelated package).
Pin a tag and add it as a dev dependency:

```bash
pnpm add -D github:alissonrgalindo/cerberus#v0.3.0
# npm:  npm i -D github:alissonrgalindo/cerberus#v0.3.0
# yarn: yarn add -D github:alissonrgalindo/cerberus#v0.3.0
```

The prebuilt `dist/` is committed, so there is no build step on install.
Run the CLI through your package manager: `pnpm exec cerberus <cmd>` (or `npx cerberus <cmd>` resolves to the **local** install once it's a dependency).
Claude Code plugin users can instead `/plugin install code-quality-gate` and skip the dependency.

## 2. Create the config

At the **repo root**:

```bash
echo '{ "extends": "@cerberus/nextjs" }' > .cerberus.json
```

Pick the preset that fits: `@cerberus/nextjs`, `@cerberus/monorepo-turborepo`, `@cerberus/node-cli`. For a Python-only repo, any preset works (the TS-specific analyzers simply never fire); `node-cli` is the leanest.

Override only what you need, e.g.:

```json
{
  "extends": "@cerberus/node-cli",
  "ignore": ["**/*.test.{ts,tsx}", "**/tests/**", "**/migrations/**"],
  "thresholds": { "functionLength": 100 }
}
```

`ignore` excludes files from the **quality** analyzers only.
The security analyzers (`secret-in-diff`, `migration-safety`, `injection`, `new-dependency`) are **always on**: listing or omitting them in `preCommit.enabled`, or matching a file with `ignore`, has no effect on them. Don't try to disable them; it won't work by design.

## 3. Snapshot the baseline

```bash
pnpm exec cerberus baseline
git add .cerberus-baseline.json && git commit -m "chore: cerberus baseline"
```

This records current metrics so **legacy code is never blocked** — the gate only stops regressions. If vitest + coverage data exist, per-file coverage floors are captured too. Commit the baseline file; it's shared by the team.

## 4. Install the hooks

```bash
pnpm exec cerberus install-hooks
```

This wires three things (idempotent; wraps/preserves any existing pre-commit hook):

1. **git `pre-commit`** — blocks terminal commits that fail the gate.
2. **Claude Code `PreToolUse(Bash)`** (`.claude/settings.json`) — blocks an agent's `git commit` and feeds violations back.
3. **Claude Code `PostToolUse(Edit|Write|MultiEdit)`** — runs the gate on each file the agent edits and feeds violations back immediately, before anything is committed.

Verify with:

```bash
pnpm exec cerberus doctor
```

## 5. Add the CI gate (the real enforcement point)

Local hooks are advisory (`--no-verify` exists). The PR check is what actually guarantees nothing lands:

```yaml
# .github/workflows/cerberus.yml
name: cerberus
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # required: --base needs the merge-base
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: pnpm install --frozen-lockfile   # installs Cerberus from the git dependency
      - run: pnpm exec cerberus check --base "origin/${{ github.base_ref }}" --format github
```

`--format github` renders each violation as an inline annotation on the PR diff (security ones tagged `[SECURITY]`). Make the job a required status check in branch protection.

## 6. Smoke-test

```bash
# should fail with secret-in-diff:
echo 'const k = "sk-ant-test1234567890test1234567890";' > smoke.ts
git add smoke.ts && git commit -m "smoke" # → blocked
git rm --cached smoke.ts && rm smoke.ts
```

For Python repos, same idea with `eval(x)` in a `.py` file (blocked by `injection`).

## Per-language notes

**TypeScript** — full analyzer set: complexity (delta vs. baseline), type-safety, coverage delta, duplication, transaction/revalidate/N+1 (Next.js+Drizzle), silent-catch, hallucinated-import, shallow-module, function shape, injection, secrets, new-dependency (package.json vs. npm/pnpm/yarn/bun lockfile).

**JavaScript** (`.js`/`.mjs`/`.jsx`/`.cjs`) — same set as TypeScript **minus type-safety** (the only type-checker-based analyzer; no-op on JS). Complexity/shape metrics use the baseline exactly like `.ts`. Parsed with `allowJs`; `.d.ts` excluded (still secret-scanned). Lets a `checkJs` + JSDoc codebase be gated without renaming to `.ts`.

**Python** — presence-based set: silent-catch (`except: pass` / log-only), injection (`eval`/`exec`, `os.system`/`subprocess(shell=True)` dynamic, non-parameterized SQL), hallucinated-import (vs. `pyproject.toml`/`requirements*.txt`), new-dependency (pyproject vs. poetry/uv/pdm lock), secrets. No baseline needed for Python files in v1.

**SQL** — staged `.sql` files get migration-safety (DROP/RENAME/ALTER TYPE/SET NOT NULL without DEFAULT) regardless of language.

## Day-2 operations

| Situation | Command |
|---|---|
| Deliberate refactor changed metrics | `pnpm exec cerberus refresh-baseline --file <path>` (or `--all-drifted`) |
| See what drifted | `pnpm exec cerberus drift` / `cerberus diff` |
| Worst files to refactor next | `pnpm exec cerberus audit --top 20` |
| Diagnose setup | `pnpm exec cerberus doctor` |
| Skip quality checks once (security still runs) | `CERBERUS_BYPASS=1 git commit ...` |
| False-positive on a specific line | `// cerberus-allow: secret` / `injection` / `shallow-module` (TS) · `# cerberus-allow: ...` (Python) |

## Rules for agents working in a gated repo

- If the gate blocks you, **fix the violations** — each one comes with a concrete suggestion. Do not look for bypasses; security violations cannot be bypassed at all.
- Never edit `.cerberus.json`, `.cerberus-baseline.json`, hook files, or `.claude/settings.json` to get a commit through.
- Per-line `cerberus-allow` suppressions are acceptable **only** for test fixtures / provably-static content, and should be mentioned to the user.
- After 2 failed attempts on quality (non-security) violations, the gate will let the commit through with `// TODO: cerberus(...)` markers — leave those markers in place; they are the debt trail.
