---
description: Recompute the quality baseline for this project
---

A baseline snapshots current metrics so the gate only blocks **regressions**, not pre-existing debt.

1. Check whether `.cerberus-baseline.json` already exists.
2. If it does, confirm with me before overwriting — re-baselining accepts the current state as the new floor.
3. Run `pnpm exec cerberus baseline --force` and report how many files were captured.
