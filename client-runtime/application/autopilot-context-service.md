# Autopilot Context Service Contract

Builds the automatic iteration context from runtime state: enabled flag, active Mission, selected candidate, and fixed-profile classification. The composition root injects `autoTick` (`'1'` by default); `prepare(state, { autoTick? })`
may override it for deterministic tests. Automatic candidate actions require `'1'`
and an unpaused Mission. The service never reads environment variables itself.
The production root uses `OPERATOR_AUTO_TICK=0` to disable both the timer and these
automatic candidate actions, preserving deterministic manual harness behavior.
Explicit advancement still performs recovery, projection and iteration settlement. The service is pure and performs no state mutation or I/O.
