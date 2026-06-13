---
description: List files whose content drifted from the baseline (with deltas)
---

Run `npx quality-gate drift` to see which files have changed since the baseline was taken, and by how much (cog/cyc/any deltas).

Useful when:
- `doctor` reports drifted files and you want to know which.
- After a refactor branch, before refreshing the baseline.
- To distinguish "drifted but flat" from "drifted and worse".

For each drifted file, classify:
- **flat** — content changed but metrics identical (formatting, comments, equivalent rewrite).
- **improved** — complexity dropped (good refactor).
- **degraded** — complexity rose. Worth inspecting before re-baselining.

Do not refresh the baseline unless I ask. Just report.
