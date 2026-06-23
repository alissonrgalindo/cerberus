---
name: cerberus
description: Use when working in a repository guarded by Cerberus, responding to Cerberus failures, installing or checking the gate, refreshing baselines, deciding on suppressions, or explaining Cerberus results to a user.
---

# Cerberus

Cerberus is a deterministic quality and security gate for agent-generated code. Treat it as an enforcement tool, not as advice the agent can negotiate away.

## First Checks

Use these commands from the repository root:

- `pnpm exec cerberus doctor` - setup, baseline, hook, and drift health.
- `pnpm exec cerberus check --staged` - pre-commit view of staged files.
- `pnpm exec cerberus check --base origin/main --format human` - PR/CI-style diff gate.
- `pnpm exec cerberus drift` - files whose content no longer matches baseline.
- `pnpm exec cerberus diff` - per-function metric changes for drifted files.
- `pnpm exec cerberus audit --top 20` - worst files by complexity. For audit/refactor planning, use the `quality-audit` skill.

If the binary is not installed locally, use the project's documented package manager command. Do not fall back to the public npm package named `cerberus`; this project is distributed as a pinned git dependency or Claude Code plugin.

## When Cerberus Blocks

1. Read every reported violation, file, line, analyzer, and suggestion.
2. Fix the code that caused the violation.
3. Re-run the narrowest relevant check, then the repository's normal validation.
4. Summarize the blocker and fix in user-facing terms.

Security analyzers are non-bypassable: secrets, injection, unsafe migrations, and new undeclared dependencies must be fixed. Do not suggest `--no-verify`, config edits, or hook edits as a solution.

Quality analyzers can be skipped only when the user explicitly accepts that tradeoff or the project policy allows it. `CERBERUS_BYPASS=1` downgrades quality checks to security-only; it does not disable security.

## Baselines

The baseline is the accepted floor for existing code. Do not refresh it just to make a failure disappear.

Refresh baseline only when the user intentionally accepts the new floor, such as after a deliberate refactor or flat documentation/string-only drift:

1. Run `pnpm exec cerberus drift`.
2. Classify each drifted file as `flat`, `improved`, or `degraded`.
3. Ask before blessing any degraded drift.
4. Run `pnpm exec cerberus refresh-baseline --file <path>` or `--all-drifted`.
5. Re-run `pnpm exec cerberus doctor`.

## Suppressions

Use `cerberus-allow` only for test fixtures, provably static content, or documented false positives. Mention suppressions to the user.

Examples:

- TypeScript/JavaScript: `// cerberus-allow: secret`
- Python: `# cerberus-allow: injection`

Do not add suppressions for real secrets, user-controlled injection sinks, unsafe migrations, or dependency uncertainty.

## Agent Guardrails

Never edit `.cerberus.json`, `.cerberus-baseline.json`, hook files, or `.claude/settings.json` to get a commit through. Only edit them when the user asked for Cerberus setup/configuration or explicitly approved a baseline refresh.

When reporting results, include the command, pass/fail state, and the actionable findings. Avoid dumping full logs unless the user asks.

For setup in a new repository, follow the `/quality-setup` command or `INSTALL.md` exactly: install, create config, snapshot baseline, install hooks, add CI, smoke-test a fake secret, then report the outcome.
