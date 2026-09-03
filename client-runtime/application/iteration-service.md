# Iteration Service Contract

`Iteration Service` is the application boundary for iteration ports consumed by `iteration-loop` and Autopilot. It exposes research start/cancel, source registration/counting, main-round start, baseline start, and research workspace resolution. Implementations must preserve serialized execution, state version checks, fixed-profile semantics, strict-zero-source rules, and injected side effects.
