# CI mode, security tier & language support

For analyzers see [analyzers.md](./analyzers.md); for config/CLI see [configuration.md](./configuration.md).

## CI mode (the real gate)

Pre-commit hooks are advisory: anything local can be bypassed with `--no-verify`.
The PR is the enforcement point:

```yaml
# .github/workflows/cerberus.yml (consumer project)
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- run: pnpm install --frozen-lockfile   # Cerberus comes from the git dependency
- run: pnpm exec cerberus check --base "origin/${{ github.base_ref }}" --format github
```

`--format github` emits workflow commands, so every violation shows up as an **inline annotation on the PR diff** (with a `[SECURITY]` tag where applicable) instead of a log line nobody opens.

`check --base <ref>` analyzes every file changed vs. the merge-base (`ref...HEAD`), exactly what the PR diff shows.

## Security tier (non-bypassable)

`secret-in-diff`, `migration-safety`, `injection`, and `new-dependency` are **security analyzers**, and every escape hatch is closed for them:

- The anti-doom-loop never passes a security violation through. A leaked key with a `// TODO` is still leaked.
- `CERBERUS_BYPASS=1` and `[skip-cerberus]` downgrade the gate to security-only instead of disabling it.
- They cannot be disabled via `.cerberus.json`: the config lives in the repo, which a blocked agent can edit, so it doesn't get a vote on security.
- The error messages shown to a blocked agent contain **no bypass instructions**.

Per-line suppressions (`// cerberus-allow: secret` / `injection`) still work: they stay visible in the diff, so a human reviewer sees every exception.

## Python support

`.py` files flow through the same gate.
v1 covers the presence-based analyzers, with the same names, config, and severity tier as the TS versions:

- **silent-catch**: `except: pass` / `except: ...` and except bodies that only `print`/`logging.*`.
- **injection** (security): `eval`/`exec` with dynamic input, `os.system` / `subprocess(shell=True)` with f-strings or concatenation, `cursor.execute()` with f-string/`%`/`.format()` SQL instead of parameterized queries.
- **hallucinated-import**: imports not declared in `pyproject.toml` (PEP 621 or Poetry) / `requirements*.txt`, with stdlib, local-module, and alias (`yaml`→`pyyaml`, `cv2`→`opencv-python`, ...) handling.
- **new-dependency** (security): new deps in a staged `pyproject.toml` must have a `poetry.lock`/`uv.lock`/`pdm.lock` entry.
- **secret-in-diff** already scans every staged file, including `.py`.

Complexity/function-shape metrics for Python (with baseline support) are a planned follow-up.
Suppressions use the comment form: `# cerberus-allow: injection`.

## JavaScript support

`.js`, `.mjs`, `.jsx`, and `.cjs` files flow through the **same gate as TypeScript**, no rename required, which is what makes a `checkJs` + JSDoc codebase enforceable.
Source is parsed to an AST with `allowJs`, so **every analyzer except `type-safety` runs on `.js` exactly as on `.ts`**: same metrics, limits, security tier, and delta-vs-baseline grandfathering.
That covers the complexity/shape analyzers (cognitive- & cyclomatic-complexity, function-length, parameter-count, shallow-module), the presence-based ones (silent-catch, injection, hallucinated-import, n-plus-one-query, transaction/revalidate-required), and the staged-set passes (duplication, secret-in-diff, new-dependency, migration-safety).

- **type-safety is a no-op on JavaScript.** It's the only analyzer that needs the TS type-checker. A `checkJs` + JSDoc migration keeps its `@ts-expect-error` / `@ts-ignore` deferrals and `@type {any}` JSDoc in `.js` files, and the gate does **not** flag them as new-`any` regressions.
- **`.d.ts`** files are excluded from analysis (still scanned by secret-in-diff).
- Anonymous functions are grandfathered against the file's baseline maximum, so adding `// @ts-check` + JSDoc (which shifts line numbers) never produces a false complexity/length regression.
- Suppressions use the same line-comment form as TS: `// cerberus-allow: shallow-module`.
