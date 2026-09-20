# Source Service Contract

`source-service.mjs` registers Git repositories under a Mission source root and reports source entry counts.

Inputs are `{ state, mission }`; outputs are transport-neutral `{ count, references?, errors? }`. Missing roots are reported as stable errors and never throw. Git metadata is read through the injected workspace port; the service does not mutate Mission state or format HTTP responses.

## Per-run accounting

`countSources` reports the whole Source Registry directory count (registry scale only) and must never be
presented as this run's harvest. `countRunSources({ state })` returns this `researchRun`'s own
acquisition result (`{ count, failures, runId }`), so historical registry directories cannot inflate the
reported research output. Source counts and usable-material counts are reported separately.
