# Autopilot Context Service Contract

Builds the automatic iteration context from runtime state: enabled flag, active Mission, selected candidate, and fixed-profile classification. Auto tick is disabled unless `OPERATOR_AUTO_TICK=1` and the Mission is not paused. The service is pure and performs no state mutation or I/O.
