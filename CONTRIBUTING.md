# Contributing to Cerberus

Thanks for helping guard the gate. This is a small, focused tool; contributions that keep it **deterministic, fast, and low-false-positive** are very welcome.

## Ground rules

- **Determinism over cleverness.** Every analyzer must give the same verdict for the same input. No network calls, no LLM, no clocks or randomness in the analysis path.
- **Delta, not absolute, for quality.** Quality analyzers compare a touched file against its baseline. Security analyzers are absolute and always-on — they never get a config vote (see [the security tier](./docs/ci-and-languages.md#security-tier-non-bypassable)).
- **Conservative on security.** Prefer a missed exotic format over a false positive that trains users to ignore the gate. New secret/injection patterns need a distinctive signature and tests for both the hit and the near-miss.

## Setup

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint src/
pnpm build         # tsup → dist/cli.js
```

Node 20+. The prebuilt `dist/` is committed (Cerberus ships as a git dependency), so **rebuild and commit `dist/` whenever you change `src/`** — CI and consumers run the committed bundle.

## Adding or changing an analyzer

1. Implement under `src/analyzers/`. AST-based (ts-morph) for TS/JS; line/indent heuristics for Python.
2. Wire it into `src/engine.ts` (per-file) or `src/cli.ts` `performCheck` (set-level), and add its name to `src/types.ts`.
3. If it's a security analyzer, add it to `SECURITY_ANALYZERS` in `src/types.ts` so it can't be bypassed.
4. Add tests under `tests/` — at minimum a true positive, a true negative, and a suppression case (`// cerberus-allow: <rule>`).
5. Document it in `docs/analyzers.md`.

## Pull requests

- Keep PRs scoped to one analyzer or one fix.
- `pnpm test`, `pnpm typecheck`, and `pnpm lint` must pass, and `dist/` must be rebuilt.
- Describe the failure mode you're catching and why the heuristic won't false-positive on common code.

Security issues: do not open a public PR/issue — see [SECURITY.md](./SECURITY.md).
