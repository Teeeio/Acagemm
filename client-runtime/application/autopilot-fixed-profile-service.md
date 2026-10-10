# Autopilot Fixed Profile Service Contract

Advances fixed operator profiles after baseline completion. Optional experience research is asynchronous and non-blocking; failures are recorded without changing baseline policy. When the Agent is idle, it starts the next candidate round with correctness-repair mode when required.

This service leads the tick but does not own it exclusively: `advance` returns
`action: 'none'` when it has no work of its own, and `autopilot-service` then
falls through to the shared candidate/validation table, which applies the
generated candidate and starts the candidate test. Without that fall-through a
fixed Profile candidate is generated and never applied. The fall-through adds no
budget authority — see `autopilot-service.md`.

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

## Unified research policy

The experience research start goes through `resolveAutomaticResearch({ trigger: 'experience' })`,
so the phase (`experience`) and budget are explicit and the default-off switch is honoured at this
entry too. The research direction is derived from the current frozen Mission contract (title/operator,
hardware, language) and no longer hardcodes historical hardware such as C550. Not having automatic
research enabled emits one idempotent `research.skipped_disabled` event per Mission and never starts a run;
local experience and reviewed KernelWiki retrieval are unaffected because they are not this path.
