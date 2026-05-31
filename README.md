# code-quality-gate

A **pre-commit quality gate** for AI-agent-generated TypeScript. It measures quality on the **files you touch** (not the whole repo) and blocks commits that regress past configurable thresholds — using **delta vs. a baseline**, so legacy code isn't forced to refactor.

> Private / internal tool. Not published to npm.

## What it checks

| Analyzer | What it flags | Default limit |
|---|---|---|
| Cognitive complexity | Hard-to-follow functions (Sonar metric) | 15 (.ts) / 20 (.tsx) |
| Cyclomatic complexity | Too many branches (McCabe) | 10 |
| Type safety | New `any`, `as unknown as`, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` | 0 new |
| Coverage delta | Coverage dropping below baseline (vitest) | no drop |
| Duplication | Copy-paste blocks (jscpd, staged files only) | 30 lines |

Complexity/type-safety run per file; coverage and duplication run once over the staged set, only at commit time.

## How it works

- **Delta, not absolute.** `quality-gate baseline` snapshots current metrics into `.quality-gate-baseline.json`. The gate only blocks when a touched file gets *worse* than its baseline. New files (no baseline) are held to the absolute threshold.
- **Anti-doom-loop.** After `maxRefactorAttempts` (default 2) failed commits on the same file set within 30 min, the gate lets the commit through, injecting `// TODO: quality-gate(...)` flags so the debt is tracked instead of looping forever.
- **Two triggers, one CLI.** A git `pre-commit` hook catches terminal commits; a Claude Code `PreToolUse(Bash)` hook catches an agent's `git commit` and feeds back structured violations.

## Quickstart

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

`install-hooks` is idempotent and **wraps** any existing `pre-commit` hook (backing it up to `pre-commit.backup-quality-gate`).

## Commands

| Command | Purpose |
|---|---|
| `quality-gate baseline [--force]` | Snapshot metrics into `.quality-gate-baseline.json` |
| `quality-gate check --staged [--mode pre-commit] [--format json\|human]` | Run the gate on staged files |
| `quality-gate check --file <path>` | Run the gate on one file (fast, no coverage/duplication) |
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

## Bypasses

- `QUALITY_GATE_BYPASS=1 git commit ...` — skip the gate for one command/session.
- `[skip-quality]` in the commit message — skipped by the Claude Code hook.

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
