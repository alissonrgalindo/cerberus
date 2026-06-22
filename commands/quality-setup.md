---
description: Wire the quality gate into this project (config, baseline, hooks, CI)
---

Set up code-quality-gate in the current repository, end to end. Follow these steps in order — full reference in the plugin's INSTALL.md.

1. **Detect the stack.** Check for `package.json` (TypeScript/Node), `pyproject.toml`/`requirements.txt` (Python), or both. Confirm this is a git repo (`git rev-parse`); if not, stop and ask.

2. **Install Cerberus** if it isn't already a dependency: `pnpm add -D github:alissonrgalindo/cerberus#v0.3.0` (or the npm/yarn equivalent). The prebuilt `dist/` is committed, so there's no build step. (Skip this if the project uses the Claude Code plugin instead.)

3. **Create `.cerberus.json`** at the repo root if missing. Pick the preset by stack: Next.js app → `@cerberus/nextjs`; turborepo monorepo → `@cerberus/monorepo-turborepo`; anything else (including Python-only) → `@cerberus/node-cli`. Add `ignore` globs for test/generated/migration paths you see in the repo (quality only — security still runs on them). Do not list security analyzers in `preCommit.enabled` overrides — they are always on regardless.

4. **Snapshot the baseline:** run `pnpm exec cerberus baseline` (use `--force` only after confirming with me if one already exists). Stage `.cerberus-baseline.json`.

5. **Install hooks:** run `pnpm exec cerberus install-hooks`, then `pnpm exec cerberus doctor` and show me the output. All lines should be ✓.

6. **Add the CI gate.** Create `.github/workflows/cerberus.yml` running `pnpm exec cerberus check --base "origin/${{ github.base_ref }}" --format github` on `pull_request`, with `pnpm install --frozen-lockfile` first, `fetch-depth: 0` on checkout, and Node 20. If the repo uses another CI system, adapt the same command.

7. **Smoke-test:** create a throwaway file containing a fake Anthropic key — e.g. `const k = "sk-ant-" + 30 random chars` (or `eval(x)` in a `.py`), stage it, attempt a commit, and confirm the gate blocks it. Then remove the file. Report the result.

8. **Commit** the config, baseline, workflow, and `.claude/settings.json` with message `chore: wire cerberus`.

Never weaken the setup to make a step pass: no editing thresholds to avoid violations, no skipping the smoke test, no `--no-verify`. If a step fails, show me the error and ask.
