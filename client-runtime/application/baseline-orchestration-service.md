# Baseline Orchestration Service Contract

Owns complete Baseline application orchestration: matrix resolution, fixed-profile recovery, active-research gating, source selection, semantic fallback, strict source inspection, Materializer policy/recovery/command, and baseline benchmark submission. Input is `{ state, mission, reason }`; output is updated state. Effects are accessed only through injected services.
