# State Workspace Adapter Contract

## Responsibility and public API

Own the existing Mission layout, fixture files and checkpoint implementation
formerly embedded in state-store. Git snapshot/copy/diff/inspection primitives
remain in `workspace-manager.mjs`.

- Path queries: `workspaceDir`, `projectLayoutFor`, `workspaceDirForMission`,
  `missionRootFor`, `missionSourceDirFor`, `baselineDirForMission`,
  `artifactDirForMission`, `researchDirForMission`, `researchNotesDirForMission`,
  `researchClonesDirForMission`. Inputs are existing Mission ID,
  repository/project/source-root strings; output paths retain legacy and strict
  three-layer layouts.
- `ensureProjectLayout(input)` / `ensureMissionWorkspace(id, repository, options)`:
  provision layout/descriptor or isolated Git snapshot; may read stored metadata
  to fill omitted roots. Return layout metadata or the absolute Workspace path.
- `workspaceFiles`: existing reference-fixture display records.
- `createStateWorkspace({ initializeStorage })`: requires an initialization
  function; returns `applyCandidatePatch(id, candidateId = 'candidate-02')` and
  `createWorkspaceCheckpoint(id, stage = 'candidate', candidateId = null)`.
  Both await initialization before accessing the Workspace. Patch materialization
  is the reference fixture, not production Candidate admission/application.
- `resetMissionWorkspace(id)`, `rebuildMissionWorkspaceFromRepository(mission)`,
  `restoreWorkspaceCheckpoint(checkpoint, missionId = checkpoint?.missionId)`:
  replace managed contents and return the existing reset/rebuild/restore DTO.
- `resetFixtureWorkspaces()`: removes only configured fixture/runtime Workspace
  and checkpoint roots. Caller must enforce reference-fixture reset authority.

## Invariants, side effects and errors

This is a filesystem/Git adapter, not a pure policy import. Production composition
injects its operations into application services. It must not import state-store;
snapshot metadata access uses the raw storage path and initialization is a port.
It never performs Gate decisions, hardware tests or Knowledge publication.

Agent changes stay in the active Mission snapshot, not the Iteration Repository
or research/source roots. Existing staged replacement/backup recovery preserves
Git metadata. Checkpoints record the stable diff digest; restore resets Git's
index as well as managed files so rejected intent-to-add entries cannot survive.
Checkpoint root trust, existence and Mission ownership checks remain mandatory.

Missing/invalid/mismatched checkpoints retain
`WORKSPACE_CHECKPOINT_MISSING`, `WORKSPACE_CHECKPOINT_INVALID` and
`WORKSPACE_CHECKPOINT_MISSION_MISMATCH` (409). Provisioning retains workspace
inspection errors (503). Initialization/filesystem/Git errors propagate.
No new cross-file transactional or cross-process locking guarantee is introduced.

## Compatibility and verification

State-store retains the previous public functions through re-exports or a
factory instance bound to ensureStorage. New effect consumers use this module;
domain/iteration modules must not import it, even for path helpers.

Run `npm run test:state-storage-adapters`, `npm run test:workspace`,
`npm run test:three-layer`, `npm run test:smoke` and the release gate.
Update this contract with path, effect, trust-check or DTO changes.
