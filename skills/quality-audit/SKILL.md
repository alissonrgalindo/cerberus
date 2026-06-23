---
name: quality-audit
description: Run a full code quality audit on the current project — complexity, type-safety, coverage, duplication. Use when starting a refactor, before planning a sprint, or when suspecting accumulated technical debt.
---

# Quality Audit

Run `pnpm exec cerberus audit --top 20` to see the worst files by complexity.

Then for the top 3 files:

1. Read each file and identify which functions/components are problematic (high cognitive or cyclomatic complexity, `any` usage, suppressions).
2. For each, propose a concrete refactor: extract a function, split a component, replace `any` with an inferred or explicit type, remove a `@ts-ignore` by fixing the underlying error.
3. Output a markdown report grouped by **file → function → issue → suggested fix**.

Do NOT run refactors yourself unless the user explicitly asks. The deliverable is the audit report so the user can decide what to tackle first.

## Useful commands

- `pnpm exec cerberus audit --top N` — worst N files by complexity.
- `pnpm exec cerberus check --file <path>` — detailed violations for one file.
- `pnpm exec cerberus doctor` — config/baseline/hook health and baseline drift.
