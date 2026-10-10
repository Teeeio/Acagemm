# Mission Objective Contract

## Responsibility and public API

Normalize Mission objective policy without loading Runtime state.

- `inferMissionObjectiveMode(mission = {}, overrides = {})`: chooses a valid
  explicit mode, then text inference; returns `smoke | threshold | maximize`.
- `normalizeMissionObjective(objective = {}, mission = {})`: returns mode,
  metric, direction, completion policy, optional numeric relative-improvement
  target and the inferred flag.
- `isMaximizeMission(mission = {})`: boolean query using the same normalization.

Defaults, explicit-field precedence and text matching retain the existing
behavior. Missing mode normally falls back to threshold; maximize defaults to
budget-or-plateau completion. This module does not normalize Mission budgets,
enforce the Gate or advance iterations.

## Effects and dependencies

None: no imports, input mutation, I/O or provider calls. It accepts the existing
Mission/objective shape; malformed values retain existing JS behavior.
State-store re-exports all three functions for compatibility; new policy callers,
including iteration-loop, import this module directly.

## Verification

Run `npm run test:state-domain-boundary`, `npm run test:loop` and
`npm run test:strict-zero-source`. Update inference tests and consumers when
objective semantics change; do not weaken fixed Profile acceptance.
