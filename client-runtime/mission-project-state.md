# Mission and Project State Contract

Newly archived round facts include `benchmark` with the recorded candidate task/run
and per-profile numbers, settling, samples and warmup. Baseline numbers come only
from the matching `comparisonBaseline.runId` evidence with identical environment,
profile, unit and metric. Missing or invalid measurements remain null; failed or
incomplete runs do not borrow stale rows. Runner self-comparison `speedup` is not
substituted for the independent baseline. Existing frozen facts are not backfilled.

Optional `targetProfile` is normalized before create-Mission changes state.
Invalid version/provenance/hardware binding fails with `MISSION_TARGET_PROFILE_INVALID`.
Absent configuration stays absent. Switching and snapshot normalization preserve
the profile without populating `iterationStats.resolvedTarget`.

New Missions receive a creation-only `experiment` identity; optional supplied
batch/task/replicate/condition/manifest metadata is validated before state changes.
Legacy Missions remain unattributed. Archived rounds preserve the Agent's frozen
generation origin and observed stage timings, never recomputed parent identities.
See [generation-origin.md](generation-origin.md).

Mission input `executionMode` is `iterate` (default when omitted) or
`generate-only`. `createMission` validates it before projecting/inserting state;
all other supplied values return `INVALID_EXECUTION_MODE` (400). The mode is a
Mission property retained across projection/selection; missing legacy mode means
iterate to consumers. `iterationStats.pendingValidation` uses the existing
per-Mission projection to retain the immutable pending-candidate DTO across
selection and restart. Its presence projects Mission status as `blocked`, or
`needs_human` on budget exhaustion, never as completed merely because generation
finished. `resumeMissionState` checks resource release first and rejects
generate-only/pending resumes with `GENERATION_ONLY_RESUME_UNAVAILABLE` (409).
Starting a fresh paused generate-only draft uses `/runs {startDraft:true}` instead.

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
| `createMissionDomainState(missionId, stage='diagnosis')` | assigned legacy defaults; null/empty identity returns a neutral unassigned projection |
| `normalizeMissionState(state)` | normalized state |
| `projectActiveMission(state)` | state with active Mission projected |
| `createMissionRuntimeView(state, missionId)` | detached Mission runtime view, without selecting it or adding selection events |
| `mergeMissionRuntimeView(state, view)` | owning Mission record plus journal/version/trace outbox; visible Mission slots stay unchanged |
| `selectMission(state, missionId)` | selected state |
| `resumeMissionState(state, {source='client'}={})` | `{state,resumed,previousLoopStatus}` |
| `selectProject(state, projectId)` | `{project,selectedMission}` |
| `createMission(state, input, {missionId}={})` | state; requires string `goal`; optional boolean `missionPaused`; injected identity is for journal replay |
| `createProject(state, input)` | Project; requires `repository` |
| `updateProject(state, projectId, input)` | Project; edits name/branch/status |
| `deleteProject(state, projectId)` | removed Project |
| `resetMissionRunState(state, goal, {referenceFixture=false}={})` | state; history capped at 20 |
| `startAgentRun(state, goal, {reset=true}={})` | running Agent state |

The module also exports the pure `ROUND_FACTS_SCHEMA_VERSION` constant and
`selectRoundFactsForPrompt(state, mission)`; see "Round facts snapshot" below.

After freezing an archived round's facts, reset enqueues a deep-cloned `round`
trace using its source Mission and generation run identity. This outbox is outside
the 20-entry display history, so multiple resets between commits cannot silently
drop old rounds. Persistence belongs to the traced snapshot adapter; see
[iteration-trace.md](iteration-trace.md).

## State semantics and effects

An explicitly empty Mission list remains empty through normalization/restart.
Unassigned domain defaults contain no target, candidate, experience or measured
result. Normalization fills missing unassigned slots while retaining persisted
diagnostics, including global corruption/journal barriers. Legacy snapshots with
no list may recover only their explicitly recorded Agent Mission identity and
available metadata; missing measurements remain unknown. Goal text never creates
or selects an example. Existing user Missions (including C550) remain present.
New idle Agents have no claimed knowledge/context artifacts before actual work.

Projection/selection preserve `appliedCandidateId`. Background test contexts use
an explicit list of runtime slots; absent values cannot borrow another Mission's
Agent, baseline or candidate. These pure views are used only within the existing
serialized writer; they do not perform filesystem or provider work.

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
fixture reset. Clock/UUID metadata is generated. Mission IDs use the existing
timestamp default or an injected `MIS_[A-Za-z0-9_-]+` identity; conflicts are
rejected before projecting state. Creation preserves supplied `sourceFiles` and
`upstream` metadata, including frozen attempt source declarations.
There is no I/O or execution.

`createMission` stores `input.missionPaused === true` on the new Mission before
selecting it. Selection therefore returns both the Mission record and active
projection paused in the same creation transition. Omitted/false values retain
the legacy unpaused behavior; a previously selected Mission's pause is not
inherited. The HTTP creation service rejects supplied non-boolean values with
`INVALID_MISSION_PAUSED` before the domain transition or workspace initialization.
The flag survives projection, normalization and later selection. A fresh paused
draft retains `ready`/`diagnosis`, idle Agent/benchmark, missing Baseline and no
started Mission/round budget; it does not manufacture evidence or an execution.
Existing runtime and autopilot pause guards prevent fresh automatic work.

`start` is not a domain execution switch. Saving a draft needs no `/runs` call;
`resumeMissionState` only unpauses and does not explicitly start a generic Agent.
An eventual explicit draft start must validate its frozen Baseline and test
contract before releasing the pause; that start admission remains the caller's
separate lifecycle work. Pause does not cancel a benchmark already committed
before pausing; existing release and queue-drain contracts remain unchanged.

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
candidate/asset status). For a `failed` benchmark with a provided top-level
`result.correctness`, that top-level correctness is the authority for the
archived correctness — including when `result.benchmark=[]` or stale successful
rows are present: `status`, `total`, `failedCase`/name/category, the attempted
cases and their real metrics are projected with `environment` from the result
source, `profile=null` and `stage='Correctness'`. A failed benchmark whose
top-level correctness already `passed` (for example a benchmark-stage exception
after correctness succeeded) maps to `passed` and keeps its observed cases rather
than being dropped to `not_observed`; `failed` still wins over a contradictory
`passed=true`. `not_run` yields `not_observed` with no fabricated failed case and
no invented measurement, while the successful legacy row-based path and its
schema/semantics are unchanged.
When the archived Gate carries a unified decision object,
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

### Response-model observation archive

`resetMissionRunState` keeps the run's response-model observation as a detached
`runHistory[].modelObservation` copy (see
[model-observation](model-observation.md)), but only when it binds exactly — byte
for byte, with no session trimming — to the archived run's
provider/run/Mission/session (the live stream session, not a resume hint). The
live `state.agent.modelObservation` is always cleared, so a new run never inherits
an old observation (`startAgentRun` explicitly starts with `null`). A repeated
reset for the same `runId` reuses the first valid archived copy instead of deleting
it, and an old archive is never used to backfill a currently foreign or
inconsistent identity. Round facts, prompt audit and Gate decisions remain
independent of the observation.
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

## Failed generation round facts (2026-10-08)

When no benchmark error explains the round, failed source admission is archived from agent.candidateValidation with its exact code, detail, classification, undeclaredFiles and missingFiles. Generation timeout primaryFailure is retained as generation_timeout when no source-admission failure applies. Snapshot serialization and selectRoundFactsForPrompt preserve this evidence for the next normal generation; no performance evidence or successful round is synthesized. tests/round-feedback-integration-test.mjs covers admission-failure archival and JSON restore.
