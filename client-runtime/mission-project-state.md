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

The module also exports the pure `ROUND_FACTS_SCHEMA_VERSION` constant and
`selectRoundFactsForPrompt(state, mission)`; see "Round facts snapshot" below.

## State semantics and effects

Selection projects the current Mission first, restores explicit fields through
structured clones (Baseline uses its shape factory), then audits. Goal/frozen
semantics remain Mission metadata. `normalizeMissionState` fills domain/legacy
defaults only; schema and finite version/sequence checks remain in `state-store`.

`resumeMissionState` treats `stopped`, `needs_human` and `blocked` as resumable
loop statuses, so a `blocked` external-verification wait can be resumed. Resume
does not refresh the round budget or bypass the resource-release barrier. For an
`external_verification` wait it clears `missionPaused` so the existing `test.plan`
retry of the same candidate is admissible, records
`iterationStats.externalVerificationAcknowledged` for that candidate/run and
deliberately keeps `loopStatus = 'blocked'` / reason `external_verification` so no
automatic round starts before the retest is actually queued. Neither path changes
fixed budgets, evidence facts, candidate workspace or release rules.

Creation/start mutate memory, not workspaces or real Agents. Start defaults to a
fixture reset. Clock/UUID metadata is generated; Mission timestamp IDs may collide.
There is no I/O or execution.

When `resetMissionRunState` archives a run, `runHistory` also records
`candidateSourceRunId` when the archived candidate has a known
`candidate.sourceRunId`. This keeps recovery attempts and their candidate
evidence attributable to the producing run rather than the first attempt in a
Round.

### Round facts snapshot

`resetMissionRunState` additionally writes a versioned required-facts snapshot to
`state.iterationStats.roundFacts` (`ROUND_FACTS_SCHEMA_VERSION =
'operator-studio.round-facts/v1'`). It is derived only from observations already
present in the archived state and is independent of the experience budget: a full
or empty experience store never drops or truncates it. Missing observations stay
`null` / `not_observed` / `unknown`; current-round budget or Mission declarations
are never used to fill a gap.

The snapshot separates `target` (the Mission/Round the facts are delivered to,
from `iterationStats.roundBudget`) from `previous` (the archived run). `previous.roundId`
is taken only from the explicit `agent.roundId` saved when that run started;
legacy runs without it record `roundIdSource: 'unknown'` instead of inheriting the
already-advanced `roundBudget`. `runHistory[].roundId` keeps the old
`agent.roundId || roundBudget.roundId || null` compatibility fallback and also
records `sourceRoundId`/`roundIdSource`.
This raw fallback is compatibility metadata for late settlement, never evidence
of the source Round. New managed and reference runs save `agent.roundId` at start.

Payload sections: `candidate` (id/digest/title/direction/files/generation path/
degraded markers/source run), `correctness` (per-environment and per-case results,
status `passed`/`failed`/`not_observed`), `failure` (classified through
`isInfrastructureTestFailure` as `infrastructure` or `operator`, or `null` when no
failure was observed), `gate`, `decision`, `rollback` and `currentBest` (including
candidate/asset status). When the archived Gate carries a unified decision object,
`gate.evidenceDecision` is a deep clone of the same decision the production path
projected; legacy records without a decision are left unchanged. The next prompt
consumes it through the existing round-facts channel only — no second process and
no persistent I/O. Rollback never claims a clean workspace: it is
`performed` only for an observed `round_rollback` recovery with matching candidate
binding, confirmed cleanliness and restore timestamp (reading `stableDigest`
from `lastRecovery` or the checkpoint with its exact `checkpointId`), otherwise
`unknown` for a rejected round or `not_performed` when no rollback was required.

The first snapshot is also saved as an independent `runHistory[].roundFacts`
copy. Repeated reset retains `agent.runId`, so it reuses that frozen source
snapshot and its original `recordedAt`, even after runtime fields were cleared;
only the delivery `target` in iterationStats follows the admitted Round. Raw
runHistory fields still refresh in place for legacy late-settlement consumers.
A reset with no `agent.runId` leaves previous facts untouched. The archive also
retains the run's `promptAudit` reference when available.
`selectRoundFactsForPrompt(state, mission)` returns a deep clone of
the snapshot only when its schema version matches, `target.missionId` equals the
supplied Mission, `target.roundId` equals the current `iterationStats.roundBudget.roundId`,
and both source and target Mission/Project bindings agree; otherwise it returns `null`. This binding
prevents a Mission switch or a new Round from receiving another Mission's or an
older Round's facts.

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
