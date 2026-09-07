# Autopilot Fixed Profile Service Contract

Advances fixed operator profiles after baseline completion. Optional experience research is asynchronous and non-blocking; failures are recorded without changing baseline policy. When the Agent is idle, it starts the next candidate round with correctness-repair mode when required.

This service does not grant new-round budget authority or reset fixed counters.
For a fixed manual POST, Run Service validates remaining limits and persists an
active frozen budget before returning armed. The downstream AgentRound only
consumes that identity and prepares its matching experience context; a completed
budget cannot be implicitly renewed by this service. Legacy untracked first
starts retain the canonical AgentRound initialization behavior.

Automatic continuation after counted, correctness-passed evidence is separately
admitted by iteration-loop using an exact completedRoundId. Neither ordinary
Autopilot observation nor generation/Correctness repair carries this permission.

Verification: node tests/run-service-test.mjs traverses the actual fixed manual
route/service to this module and AgentRound using injected effect doubles. The
automatic fixed evidence cases in tests/round-budget-test.mjs cover a different
entry point. Neither suite is live network/model/GPU acceptance.
