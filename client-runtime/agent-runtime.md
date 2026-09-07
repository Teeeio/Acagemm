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
`node tests/baseline-materializer-agent-test.mjs`.
