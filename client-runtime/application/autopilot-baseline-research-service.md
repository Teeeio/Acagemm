# Autopilot Baseline Research Service Contract

Coordinates research when a candidate Mission lacks a complete baseline. It starts managed-runtime research, waits for active runs, and projects unresolved terminal research into `needs_human` with stable event/audit effects. Returns `{ state, action }` or `null` when no branch applies.
