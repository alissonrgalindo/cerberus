# Configuration & CLI

For the list of analyzers see [analyzers.md](./analyzers.md); for CI and language support see [ci-and-languages.md](./ci-and-languages.md).

## Config file

`.cerberus.json` at the project root (legacy `.quality-gate.json` still honored).
Extend a preset and override only what you need:

```json
{
  "extends": "@cerberus/nextjs",
  "ignore": ["**/*.test.{ts,tsx}", "**/migrations/**"],
  "preCommit": { "enabled": ["cognitive", "cyclomatic", "type-safety"] }
}
```

Presets: `@cerberus/nextjs`, `@cerberus/monorepo-turborepo`, `@cerberus/node-cli` (legacy `@quality-gate/*` aliases still resolve).

`ignore` is a **quality knob only**: matched files are dropped from the baseline and from every quality analyzer (complexity, type-safety, duplication, coverage, shape, …). The **security tier still runs on ignored files** — `secret-in-diff`, `injection`, `migration-safety`, and `new-dependency` cannot be silenced by widening `ignore`, the same way they can't be disabled by editing `preCommit.enabled` (see [the security tier](./ci-and-languages.md#security-tier-non-bypassable)).

### `binaryAssets` — non-source artifacts skipped everywhere

`binaryAssets` is the one exception to "security runs on everything": non-source **binary / design artifacts** are skipped by *every* tier, including `secret-in-diff` and `new-dependency`. These are file *types* that can't carry a meaningful source-level credential leak — images, fonts, media, archives, and design files like `.pen` (Pencil). Reading a multi-MB asset as utf8 to look for `sk-…` tokens is pure cost and false-positive surface, not security.

```json
{
  "extends": "@cerberus/monorepo-turborepo",
  "binaryAssets": ["**/*.glb", "**/*.parquet"]
}
```

Two safeguards keep this from becoming a hole in the non-bypassable security tier:

- **Extension globs only.** Each entry must target a concrete file extension (`**/*.pen`, `*.png`, `**/*.{woff,woff2}`). A pattern that could match arbitrary files (`**/*`, `*`, `**/*.*`) is rejected with a warning — so the list can only ever exempt a file *type*, never "everything".
- **`.env` is never exemptable.** Env files are scanned unconditionally even if their extension is listed, since they're the single most sensitive thing to leak.

The config value **adds to** the built-in defaults (it does not replace them). Defaults already cover `.pen`, common image/font/media/archive extensions, and `.pdf/.psd/.sketch/.fig`.

## Commands

| Command | Purpose |
|---|---|
| `cerberus baseline [--force]` | Snapshot metrics into `.cerberus-baseline.json` |
| `cerberus check --staged [--mode pre-commit] [--format json\|human]` | Run the gate on staged files |
| `cerberus check --file <path>` | Run the gate on one file (fast, no coverage/duplication) |
| `cerberus check --base <ref>` | CI mode: run the gate on files changed vs. a base ref |
| `cerberus audit [path] [--top N]` | List the worst files by complexity |
| `cerberus refresh-baseline --file <path>` | Re-baseline one file after a deliberate refactor |
| `cerberus install-hooks` | Install the git pre-commit + Claude Code hooks |
| `cerberus doctor` | Diagnose config, baseline drift, and hook state |

The legacy binary name `quality-gate` is kept as an alias for every command.

Slash commands (`/quality-check`, `/quality-baseline`) and the `cerberus` / `quality-audit` skills are available when installed as a Claude Code plugin.

## Hooks

`install-hooks` is idempotent and **wraps** any existing `pre-commit` hook (backing it up to `pre-commit.backup-quality-gate`).
It also registers two Claude Code hooks in `.claude/settings.json`: `PreToolUse(Bash)` (blocks failing agent commits) and `PostToolUse(Edit|Write|MultiEdit)` (runs the gate on each file the agent edits and feeds violations back immediately, the cheapest point to fix).

## Bypasses (quality analyzers only)

- `CERBERUS_BYPASS=1 git commit ...`: skip the quality analyzers for one command/session (legacy `QUALITY_GATE_BYPASS=1` still works).
- `[skip-cerberus]` in the commit message: quality analyzers skipped by the Claude Code hook (legacy `[skip-quality]` still works).

Both bypasses keep the **security analyzers running** (see [the security tier](./ci-and-languages.md#security-tier-non-bypassable)).
There is no flag that skips a secret scan.

## Troubleshooting

- **Baseline drift.** `cerberus doctor` lists files whose content diverged from the baseline; `refresh-baseline --file <path>` re-snapshots one.
- **Coverage skipped.** Coverage only runs when vitest is detected and a meaningful baseline exists; otherwise it's silently skipped (never fails the gate).
- **False positive on legacy code.** That file likely isn't in the baseline. Run `cerberus baseline` (or `refresh-baseline --file`).

## Requirements

- Node 20+
- A git repository
- (Optional) `vitest` in the consumer project for the coverage analyzer
