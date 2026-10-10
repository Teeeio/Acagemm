# Runtime Maintenance Service Contract

Owns the runtime-mode-dependent state policy formerly hidden in state-store loading.
`advance({ state, runtimeMode })` returns `{ state, changed }`.

It preserves the existing order: Knowledge maintenance, eligible policy adoption,
reference-fixture Benchmark projection, then reference-fixture Agent projection.
Managed three-layer Projects remain owned by repository adoption; fixture projection
must never advance a real `cli_` run. Fixed Profile, Gate and evidence rules are
unchanged and delegated to the injected domain operations.

All dependencies are state-only ports: `isManagedWorkspaceRuntimeMode`,
`runKnowledgeMaintenance`, `runAutomaticAdoption`, `isMaximizeMission`,
`refreshReferenceBenchmark`, and `refreshReferenceAgent`. The service does not
load/save state, operate workspaces or launch Agents. It is invoked only by the
explicit advancement pipeline, never a query.

Verification: `test:runtime-maintenance-service`, `test:smoke`, `test:journal`.

Best source binding runs through pure `bindAutomaticBestCandidate(state)` after policy adoption and before reference Benchmark projection. Its return value contributes to `changed`; rebinding the same manifest/test run is a no-op. The local server wraps the repository and policy adoption ports too, so same-tick round archival cannot discard the source reference. No filesystem reader is added to this service.
