# TUI Decoupling Handoff

## Current Boundary

Production behavior remains `TUI -> HTTP API -> application services -> domain/ports -> adapters`. The legacy standalone workflow is removed. Runtime application services cover HTTP use cases, source/research/round orchestration, complete Baseline orchestration, Autopilot decisions/actions, runtime projection/advance, Benchmark projection, and repository adoption.

## Completed Extraction Scope

There is no remaining transitional surface in the scoped TUI decoupling work. `client-runtime/local-server.mjs` is the composition root and contains no inline Autopilot, Baseline, main-round, or loaded-state projection decision table. The former `iterationDeps` object is replaced by the immutable `iterationService`; `iterationPorts` is only the documented effect-port mapping used to construct it.

`runtime-state-pipeline-service.mjs` owns the ordered loaded-state pipeline. `main-round-orchestration-service.mjs`, `baseline-orchestration-service.mjs`, and `autopilot-service.mjs` own their complete use-case decisions. The unused parallel Autopilot Baseline research implementation was removed, so production has one workflow path.

`stateRepository.update` is the atomic boundary for independent commands that load state inside the operation. `loadRuntimeState` projects an already-loaded snapshot while its caller owns `runExclusive`; it therefore intentionally uses serialized `persist`. Calling `update` from this path would recursively enter the exclusive queue and deadlock. This is the final repository contract, not an outstanding migration.

## Module Development Rule

Before editing, read `ARCHITECTURE.md`, the nearest directory `README.md`, and the target module's same-name `.md` contract. Every application module has a same-name contract defining its function, inputs, outputs, ownership, and side-effect boundary. Contract changes require the implementation, contract, focused test, module-boundary assertion, and release-script entry in the same change. Do not add deep imports across documented boundaries. Simulation evidence remains non-publishable live-hardware evidence.

## Verification

Run focused service tests during development and `npm run verify:local-c500-release` before merging cross-module changes. On 2026-09-03 the complete release gate passed: `PASS: 90 checks completed`.
