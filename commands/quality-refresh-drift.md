---
description: Re-baseline every drifted file in one shot (after a deliberate refactor)
---

Run `pnpm exec cerberus refresh-baseline --all-drifted`.

Before running:

1. Run `pnpm exec cerberus drift` and show me the list.
2. For any file marked **degraded**, ask me to confirm — re-baselining "blesses" the new floor.
3. Only then run the refresh and report how many files were updated.

This command is irreversible without git. Treat it as a deliberate state change.
