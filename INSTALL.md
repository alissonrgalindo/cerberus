# Installing the quality gate into a project

Step-by-step for wiring `code-quality-gate` into a consumer repo (TypeScript, Python, or both). Written so a human **or a coding agent** can execute it top to bottom.

## 0. Requirements

- Node 20+ available in the project (the CLI is Node-based even for Python repos)
- A git repository
- The plugin installed (Claude Code: `/plugin install code-quality-gate`) or this repo's `dist/cli.js` reachable via `npx quality-gate` / `node <path>/dist/cli.js`

## 1. Create the config

At the **repo root**:

```bash
echo '{ "extends": "@quality-gate/nextjs" }' > .quality-gate.json
```

Pick the preset that fits: `@quality-gate/nextjs`, `@quality-gate/monorepo-turborepo`, `@quality-gate/node-cli`. For a Python-only repo, any preset works (the TS-specific analyzers simply never fire); `node-cli` is the leanest.

Override only what you need, e.g.:

```json
{
  "extends": "@quality-gate/node-cli",
  "ignore": ["**/*.test.{ts,tsx}", "**/tests/**", "**/migrations/**"],
  "thresholds": { "functionLength": 100 }
}
```

Note: the security analyzers (`secret-in-diff`, `migration-safety`, `injection`, `new-dependency`) are **always on** — listing or omitting them in `preCommit.enabled` has no effect. Don't try to disable them; it won't work by design.

## 2. Snapshot the baseline

```bash
npx quality-gate baseline
git add .quality-gate-baseline.json && git commit -m "chore: quality-gate baseline"
```

This records current metrics so **legacy code is never blocked** — the gate only stops regressions. If vitest + coverage data exist, per-file coverage floors are captured too. Commit the baseline file; it's shared by the team.

## 3. Install the hooks

```bash
npx quality-gate install-hooks
```

This wires three things (idempotent; wraps/preserves any existing pre-commit hook):

1. **git `pre-commit`** — blocks terminal commits that fail the gate.
2. **Claude Code `PreToolUse(Bash)`** (`.claude/settings.json`) — blocks an agent's `git commit` and feeds violations back.
3. **Claude Code `PostToolUse(Edit|Write|MultiEdit)`** — runs the gate on each file the agent edits and feeds violations back immediately, before anything is committed.

Verify with:

```bash
npx quality-gate doctor
```

## 4. Add the CI gate (the real enforcement point)

Local hooks are advisory (`--no-verify` exists). The PR check is what actually guarantees nothing lands:

```yaml
# .github/workflows/quality-gate.yml
name: quality-gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # required: --base needs the merge-base
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx quality-gate check --base "origin/${{ github.base_ref }}" --format github
```

`--format github` renders each violation as an inline annotation on the PR diff (security ones tagged `[SECURITY]`). Make the job a required status check in branch protection.

## 5. Smoke-test

```bash
# should fail with secret-in-diff:
echo 'const k = "sk-ant-test1234567890test1234567890";' > smoke.ts
git add smoke.ts && git commit -m "smoke" # → blocked
git rm --cached smoke.ts && rm smoke.ts
```

For Python repos, same idea with `eval(x)` in a `.py` file (blocked by `injection`).

## Per-language notes

**TypeScript** — full analyzer set: complexity (delta vs. baseline), type-safety, coverage delta, duplication, transaction/revalidate/N+1 (Next.js+Drizzle), silent-catch, hallucinated-import, shallow-module, function shape, injection, secrets, new-dependency (package.json vs. npm/pnpm/yarn/bun lockfile).

**Python** — presence-based set: silent-catch (`except: pass` / log-only), injection (`eval`/`exec`, `os.system`/`subprocess(shell=True)` dynamic, non-parameterized SQL), hallucinated-import (vs. `pyproject.toml`/`requirements*.txt`), new-dependency (pyproject vs. poetry/uv/pdm lock), secrets. No baseline needed for Python files in v1.

**SQL** — staged `.sql` files get migration-safety (DROP/RENAME/ALTER TYPE/SET NOT NULL without DEFAULT) regardless of language.

## Day-2 operations

| Situation | Command |
|---|---|
| Deliberate refactor changed metrics | `npx quality-gate refresh-baseline --file <path>` (or `--all-drifted`) |
| See what drifted | `npx quality-gate drift` / `quality-gate diff` |
| Worst files to refactor next | `npx quality-gate audit --top 20` |
| Diagnose setup | `npx quality-gate doctor` |
| Skip quality checks once (security still runs) | `QUALITY_GATE_BYPASS=1 git commit ...` |
| False-positive on a specific line | `// quality-gate-allow: secret` / `injection` / `shallow-module` (TS) · `# quality-gate-allow: ...` (Python) |

## Rules for agents working in a gated repo

- If the gate blocks you, **fix the violations** — each one comes with a concrete suggestion. Do not look for bypasses; security violations cannot be bypassed at all.
- Never edit `.quality-gate.json`, `.quality-gate-baseline.json`, hook files, or `.claude/settings.json` to get a commit through.
- Per-line `quality-gate-allow` suppressions are acceptable **only** for test fixtures / provably-static content, and should be mentioned to the user.
- After 2 failed attempts on quality (non-security) violations, the gate will let the commit through with `// TODO: quality-gate(...)` markers — leave those markers in place; they are the debt trail.
