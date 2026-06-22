---
description: Show per-function complexity deltas between working tree and baseline
---

Run `pnpm exec cerberus diff` to see, for every drifted file, which **functions** moved and by how much.

Use this before committing a refactor to confirm the change you intended is the change the gate sees. Output is grouped by file → function → delta.

Important:
- A function with `delta: +N` got more complex (cognitive or cyclomatic).
- A function with `delta: -N` got simpler (good).
- If a file shows "content changed but no per-function metric delta", the edit was likely formatting or a string change.
- Read-only. Doesn't touch the baseline.
