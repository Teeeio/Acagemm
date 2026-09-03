# TUI Decoupling Handoff

## Current Boundary

Production behavior remains `TUI -> HTTP API -> application services -> domain/ports -> adapters`. The legacy standalone workflow is removed. Runtime application services now cover Projects, Missions, Queries, Semantic, Research, Run, Review, Decision, Candidate Validation, Baseline, Operator Test, Mission Control, Knowledge, Runtime Query/State, Reset, Source, round preflight/recovery/artifact guards, Agent round launch, baseline source/materializer policy, benchmark projection, repository adoption, and Autopilot candidate/context/action/validation boundaries.

## Remaining Transitional Surface

`client-runtime/local-server.mjs` still assembles `iterationDeps` and retains a compatibility decision table around Autopilot. Fixed Profile, strict-source, candidate-baseline, candidate actions, and validation branches now delegate to application services. The file still owns `loadRuntimeState` orchestration; these are transitional facades, not new public APIs.

`stateRepository.update` is the atomic command boundary for mutations that can load state inside the operation. `loadRuntimeState` currently projects a previously-read snapshot and therefore must continue using its serialized `persist` path until projection is moved into an `update` callback; replacing it mechanically would overwrite concurrent projection changes.

## Module Development Rule

Every extracted module requires a local README/contract, focused test, module-boundary assertion, and release-script entry. Do not add deep imports across documented boundaries. Simulation evidence remains non-publishable live-hardware evidence.

## Verification

Run focused service tests during development and `npm run verify:local-c500-release` before merging cross-module changes. The expected release output is a `PASS` line with the current check count.
