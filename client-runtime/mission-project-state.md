# Mission and Project State Contract

## Purpose and ports

`createMissionProjectState({ rootDir, workspaceDir, workspaceDirForMission,
missionSourceDirFor })` returns a frozen API. `rootDir`/`workspaceDir` allow empty
strings; query ports use
`(missionId, repository, projectRoot)` without I/O. Recovery paths are relative to
`rootDir`; unassigned uses `workspaceDir`. Wrong/missing types throw `TypeError`.
Imports shared/domain contracts, `node:path` and UUID creation, never adapters/facade.

## Public API

Returned methods:

| Method | Output |
|---|---|
| `createWorkflowRecoveryState(missionId='', repository='', projectRoot='')` | recovery record |
| `createMissionDomainState(missionId, stage='diagnosis')` | defaults, including fixtures |
| `normalizeMissionState(state)` | normalized state |
| `projectActiveMission(state)` | state with active Mission projected |
| `selectMission(state, missionId)` | selected state |
| `resumeMissionState(state, {source='client'}={})` | `{state,resumed,previousLoopStatus}` |
| `selectProject(state, projectId)` | `{project,selectedMission}` |
| `createMission(state, input)` | state; requires string `goal` |
| `createProject(state, input)` | Project; requires `repository` |
| `updateProject(state, projectId, input)` | Project; edits name/branch/status |
| `deleteProject(state, projectId)` | removed Project |
| `resetMissionRunState(state, goal, {referenceFixture=false}={})` | state; history capped at 20 |
| `startAgentRun(state, goal, {reset=true}={})` | running Agent state |

## State semantics and effects

Selection projects the current Mission first, restores explicit fields through
structured clones (Baseline uses its shape factory), then audits. Goal/frozen
semantics remain Mission metadata. `normalizeMissionState` fills domain/legacy
defaults only; schema and finite version/sequence checks remain in `state-store`.

Creation/start mutate memory, not workspaces or real Agents. Start defaults to a
fixture reset. Clock/UUID metadata is generated; Mission timestamp IDs may collide.
There is no I/O or execution.

Fixed Profile operator identity takes precedence over an optional generic operator
label. Without a Profile, the explicit operator is preserved for generic tests and
experience scope; it is not replaced with a demo operator.

## Compatibility and limitations

Empty path overrides keep existing fallbacks. Absolute Project repositories
default sources to `.operator-studio/sources`; ordinary Mission sources use
Project, input, then null. `strictZeroSource=true` or
`mode='agent-research-only'` uses `missionSourceDirFor`.
Project selection prefers running, unfinished, then completed; empty Projects
retain the active Mission. Own errors retain `.status`: 400 invalid
Project input, 404 missing IDs, 409 duplicate/linked/running conflicts; no new codes.
Mutations are not transactional; nested Baseline inputs need not be cloned.
Statuses stay `failed/awaiting_approval/running/completed/ready`.
Fixed Profile/test rules and live-evidence authority are unchanged.

## Verification

Run `npm run test:mission-project-state`, `npm run test:state-domain-boundary`,
`npm run test:missions-service`, `npm run test:projects-service` and
`npm run test:state-store-projection`. Update callers/tests/contracts together.

Generic creation retains input.operator (or the fixed Profile operator). When the
matrix omits environments it inherits Mission hardware, including CPU; explicit
fixed matrices are unchanged. Creating/switching Missions or Projects, resuming,
resetting or starting rounds rejects MISSION_RESOURCE_RELEASE_PENDING while old
execution resources remain unconfirmed. Selecting the same Mission remains possible.
