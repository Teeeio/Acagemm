# Round Preflight Service Contract

Combines generation-attempt settlement and runtime workspace preflight before starting an iteration round. Inputs are `{ state, goal, retryMode }`; output is `{ blocked, state, mission, preflight }`. It performs no persistence or HTTP work and delegates policy and preflight decisions to injected functions.
