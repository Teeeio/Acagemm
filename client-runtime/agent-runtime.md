# Agent Runtime Lifecycle Contract

Provider-neutral main Agent, Research and Baseline Materializer lifecycle.
Consumes runtime registry/provider ports and isolated Workspace adapters; exposes
describe, preflight, startRun, startResearch, startBaselineMaterialization,
cancelRun and projectState. It does not persist the Mission or decide Gate outcomes.

## Frozen experience input

startRun optionally receives experienceContext from the admitted round service.
It validates project/Mission/round identity, content digest, provenance and limits
through the pure Experience contract. Managed CLI/OpenCode prompts render it as
untrusted JSON advice; the CLI bridge carries the same frozen DTO and instruction.
Experience cannot replace Profile/Gate/oracle/retry or Workspace boundaries. The
provider does not query the experience repository or create observations itself.

## Archived round facts input

`startRun` may receive an explicit `roundId`; the effective round identity is
`roundId || state.iterationStats.roundBudget.roundId` and is persisted as
`state.agent.roundId` at start. Managed CLI branches (Claude Code, Codex) bind
archived round facts through the existing `iterationContext` input:
`selectRoundFactsForPrompt(state, mission)` (see
[mission-project-state](mission-project-state.md#round-facts-snapshot)) is deep-copied
into a local `{ ...mission, iterationContext: roundFacts }` projection, so the stored
Mission object is never mutated, and `buildCandidateGenerationPrompt` renders it as
`MISSION ITERATION CONTEXT`. The snapshot itself is produced by the production
archive (`resetMissionRunState`), never by Mission declarations or the current,
already-advanced round budget.

Delivery is fail-closed by binding. `selectRoundFactsForPrompt` returns `null` — no
facts are delivered — unless the schema matches
`operator-studio.round-facts/v1`, `target.missionId` and `previous.missionId` equal
the supplied Mission, the current `roundBudget.roundId` exists and equals
`target.roundId`, and target/previous Project bindings agree with the Mission when
present. A Mission switch, an advanced Round, or an old snapshot therefore cannot
leak another Mission's or Round's facts into the prompt. The OpenCode and cli-file
branches do not render round facts; their audits record `roundFacts: null`.

## Pre-send prompt audit

Every `startRun` branch that dispatches to a provider writes `writePromptAudit`
**before** invoking the provider port (the `reference-fixture` branch returns without
a provider call and writes none). The artifact is the provider-neutral authority for
what the boundary prepared;
it is not rebuilt from state afterwards. Schema is
`operator-studio.prompt-audit/v1` with `deliveryStage: 'prepared-before-send'`, at
`<bridgeDir>/prompt-audits/<runId>.json`. `runId` must be a safe file name (rejected
with `PROMPT_AUDIT_RUN_ID_INVALID` otherwise). Fields: `prompt`, `promptDigest`
(`sha256:<hex>` over the UTF-8 bytes), `promptBytes`
(`Buffer.byteLength(prompt, 'utf8')`, never a character count), Mission/Project/Round/
Run bindings, `runtimeMode`, `createdAt`, `roundFacts` and `selection` (each `null`
when absent). The file is written to a temporary sibling and atomically renamed, with
bounded retries for the Windows `EPERM`/`EBUSY`/`EACCES` rename races; any other write
failure throws `PROMPT_AUDIT_WRITE_FAILED` and the provider `start` is never called.
Claude Code and Codex share the helper and audit exactly the string later passed as
`start.goal`; OpenCode audits the text handed to its prompt port and cli-file audits
the delivered `request.goal`. `state.agent.promptAudit` keeps only the
`{ schemaVersion, path, digest, bytes }` reference, and `resetMissionRunState` retains
it as `runHistory[].promptAudit`.

## Selection snapshot compatibility

The audit's `selection` is a clone of `state.iterationStats.roundExperienceSelection`
and is included only when it belongs to this exact delivery: same
`missionId`/`projectId`/`roundId`, the same `contextId` as the injected
`experienceContext`, and an index-wise match of every selected `id`/`version`/`source`
against `experienceContext.items`. Otherwise `selection` is `null`, so another Round's
or Mission's audit metadata never leaks into this prompt. The sidecar is audit-only:
it does not change the frozen context, its selection, its ordering, or the 20-item /
64 KiB limits (see [round-experience-service](application/round-experience-service.md)).
A retrieve-only experience port still yields a compatible context-derived selection
marked `auditSource: 'context-derived'`, `exclusionReasonsRecorded: false` and reason
`frozen-context`, without fabricating exclusion reasons.

## Evidence boundary

These audit assertions prove what the production boundary prepared and handed to the
provider port; they do **not** prove what a live provider process received or
followed. The only observation of the exact string passed to provider `start` is
`tests/prompt-audit-test.mjs`, where an injected provider double reads the audit file
inside its own `start()` call (proving write-before-send ordering). The optional
`scripts/e2e-shared-gpu-agent-iteration.mjs` continuation assertion reads the same
audit artifact and does not claim `audit.prompt === provider start.goal` against a
live provider. This contract makes no real-GPU, real-Agent, long-run or N=20
stability claim.

## Response-model observation projection

For the managed Claude Code branch, `projectState` reads the current run record
and projects only an exact current provider/run/mission/session-bound DTO via the
shared `bindModelObservation` authority (see
[model-observation](model-observation.md)) to `state.agent.modelObservation`. The
expected identity comes from the current agent + active Mission, never from the
run record: a record that claims another run, Mission or provider is foreign and
is rejected rather than re-labelled. The expected Mission must agree with both
`state.activeMissionId` and `state.agent.missionId` when both are present. The
expected session is an independent run-record identity compared byte-exactly
(never trimmed): the record's actual `sessionId`, or its compatible `threadId`
when no session was recorded, and the two must agree when both are present. The
DTO's own `sessionId` is never an authority — there is no cancellation
self-binding fallback, so a DTO whose session disagrees with the record is
refused even when the run is cancelled. A missing,
foreign, malformed or stale observation clears the value instead of keeping an old
one, and a failed run read clears it too; the projected value is a deep-detached
copy, and a metadata-only change (for example new `usageModels`) sets
`changed=true` without touching status or event count. Cancellation settlement —
including the early `settleCancellation` return — preserves the pre-settlement
exact binding when the release receipt carries no DTO, and never widens status or
resource release. The observation is diagnostic metadata: it never gates
candidates, Gate decisions, workflow advancement or resource release.

## Cancellation and projection

All three start methods enforce the shared cancellation resource barrier.
cancelRun routes by the active role's runId and records release truth separately
from logical workflow status. Provider cancellation is single-flight per run and
bounded (cancellationTimeoutMs, default 5 seconds). A late provider result cannot
mutate a Mission snapshot; an unanswered cancellation remains unconfirmed.

Deadline/stall, owner loss, or inability to read a live run must never become a
successful terminal projection. While release is unconfirmed the role remains
cancel_requested, has no next Candidate action, and exposes reason/deadline/
nextAction. Main Diff capture, research-note extraction, materializer artifact
admission, rollback and the next round are not permitted under this barrier.

A Materializer may request cancellation after its logical completion event, but
must wait for confirmed process exit before consuming workspace artifacts.
After confirmed exit, existing candidate/materializer salvage and timeout recovery
remain available. Source-backed correctness and fixed Profile rules are unchanged.

Legacy Provider/fixture terminal statuses without resourceRelease retain their
old terminal contract; new Codex records always carry explicit release evidence.
Queries at the Production API still use committed state; projectState is an
explicit advancement effect, not a snapshot GET.

Tests:
`node tests/agent-cancellation-liveness-test.mjs`
`node tests/agent-runtime-timeout-recovery-test.mjs`
`node tests/codex-runtime-test.mjs`
`node tests/research-test.mjs`
`node tests/baseline-materializer-agent-test.mjs`
`node tests/prompt-audit-test.mjs`
`node tests/round-feedback-integration-test.mjs`.
