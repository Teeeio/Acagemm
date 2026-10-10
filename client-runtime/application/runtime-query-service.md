# Runtime Query Service Contract

Owns read-only Runtime state, Mission preflight, and active Mission Workspace projections.

| Method | Input | Output | Stable errors |
|---|---|---|---|
| `buildPreflight(mission)` | Mission DTO | workspace, source, Agent, layer, and readiness projection | dependency errors |
| `preflight(missionId)` | optional Mission ID; defaults to active Mission | status and preflight payload | `MISSION_NOT_FOUND` (404) |
| `getState()` | none | current normalized product state | state-load errors |
| `workspace()` | active Mission state | relative workspace path, patch flag, and declared files | workspace errors |

An empty Iteration Repository blocks preflight unless a usable Source Registry exists or the explicit reference-fixture simulation runtime is active. Strict-zero-source Missions use the injected source inspection result. Workspace inspection objects are copied before readiness is changed and must never be mutated in place.

`getState()` must receive the read-only Runtime Lifecycle snapshot port. It cannot
repair storage, recover commands or advance the runtime. Preflight and Workspace
queries retain their existing idempotent `ensureMissionWorkspace` provisioning;
that port can create missing directories and inspect Git, so these two endpoints
are not a blanket filesystem no-write guarantee.

The service does not parse URLs, write HTTP responses, persist state, execute Agents,
apply Candidate patches, or define fixed Profile semantics. Persistence reads, workspace access, Agent preflight, source inspection, path presentation, artifacts, runtime mode, and clocks are injected.

```bash
npm run test:runtime-query-service
npm run test:module-boundary
npm run test:smoke
```
