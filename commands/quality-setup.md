---
description: Wire the quality gate into this project (config, baseline, hooks, CI)
---

Set up code-quality-gate in the current repository, end to end. Follow these steps in order — full reference in the plugin's INSTALL.md.

1. **Detect the stack.** Check for `package.json` (TypeScript/Node), `pyproject.toml`/`requirements.txt` (Python), or both. Confirm this is a git repo (`git rev-parse`); if not, stop and ask.

2. **Create `.quality-gate.json`** at the repo root if missing. Pick the preset by stack: Next.js app → `@quality-gate/nextjs`; turborepo monorepo → `@quality-gate/monorepo-turborepo`; anything else (including Python-only) → `@quality-gate/node-cli`. Add `ignore` globs for test/generated/migration paths you see in the repo. Do not list security analyzers in `preCommit.enabled` overrides — they are always on regardless.

3. **Snapshot the baseline:** run `npx quality-gate baseline` (use `--force` only after confirming with me if one already exists). Stage `.quality-gate-baseline.json`.

4. **Install hooks:** run `npx quality-gate install-hooks`, then `npx quality-gate doctor` and show me the output. All lines should be ✓.

5. **Add the CI gate.** Create `.github/workflows/quality-gate.yml` running `npx quality-gate check --base "origin/${{ github.base_ref }}" --format github` on `pull_request`, with `fetch-depth: 0` on checkout and Node 20. If the repo uses another CI system, adapt the same command.

6. **Smoke-test:** create a throwaway file containing `const k = "sk-ant-test1234567890test1234567890";` (or `eval(x)` in a `.py`), stage it, attempt a commit, and confirm the gate blocks it. Then remove the file. Report the result.

7. **Commit** the config, baseline, workflow, and `.claude/settings.json` with message `chore: wire code-quality-gate`.

Never weaken the setup to make a step pass: no editing thresholds to avoid violations, no skipping the smoke test, no `--no-verify`. If a step fails, show me the error and ask.
