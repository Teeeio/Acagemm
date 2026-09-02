# Agent Round Service Contract

Starts one iteration Agent round after preflight and recovery checks. It resets mission run state, restores reference fixtures when applicable, records managed-runtime checkpoints, and delegates to the Agent runtime. Inputs are `{ state, mission, goal, workspace, runtimeMode }`; output is the resulting state. Persistence, HTTP, and policy decisions remain outside this service.
