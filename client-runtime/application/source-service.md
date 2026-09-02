# Source Service Contract

`source-service.mjs` registers Git repositories under a Mission source root and reports source entry counts.

Inputs are `{ state, mission }`; outputs are transport-neutral `{ count, references?, errors? }`. Missing roots are reported as stable errors and never throw. Git metadata is read through the injected workspace port; the service does not mutate Mission state or format HTTP responses.
