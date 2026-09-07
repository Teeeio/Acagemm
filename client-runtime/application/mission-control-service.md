# Mission Control Service Contract

Coordinates explicit Agent-run cancellation, human feedback injection, and
stopping the active Mission. Provider/process and queue internals are injected.

| Method | Input | Output | Stable errors |
|---|---|---|---|
| cancelRun(missionId, runId) | decoded IDs | persisted state and runtime result | AGENT_MISSION_MISMATCH |
| addHumanFeedback(body) | note with at least two trimmed characters | persisted state and feedback DTO | HUMAN_FEEDBACK_REQUIRED, MISSION_RESOURCE_RELEASE_PENDING |
| stopMission() | none | persisted stopped state and resourceRelease; 200 when released, 202 while unconfirmed | MISSION_NOT_FOUND |
| releaseResources(state, options) | loaded mutable state; optional reason | resourceRelease summary, state updated in memory | cancellation errors preserved per resource |

stopMission persists the paused/stopped intent before external cancellation,
then calls releaseResources and persists the result. A stopped Mission means no
further advancement is allowed; it does not assert that every worker has exited.

releaseResources covers main Agent, Research, Baseline Materializer and queued/
running/cancel-pending Operator Tests. It does not load/persist state or change
missionPaused/loopStatus, so budget/error shutdown can reuse the same resource
enumeration without creating another workflow. Cancellation calls run concurrently
with a bounded per-port acknowledgement wait (cancellationTimeoutMs, default
5 seconds). Each Agent receives an isolated snapshot; late port completion cannot
change the returned state. Timeout is an unconfirmed barrier, never a false
cancelled outcome.

workflowRecovery.resourceRelease and per-role resourceRelease expose confirmed,
status, reason, deadline, nextAction, resources with kind/id, and stable error
codes. A failure cancelling one role does not prevent attempts for other roles.
Unconfirmed cancellation prevents feedback from silently resuming the Mission;
explicit advancement or another cancellation can later establish release.
A repeated stop/release cannot erase an unresolved resource whose kind/id no
longer matches a current snapshot. Such resources (including legacy summaries
without ownership metadata) remain unconfirmed with
MISSION_RESOURCE_IDENTITY_UNAVAILABLE until their original owner is verified;
no stale PID or replacement run is treated as proof of release.
The application records canonical runtime/audit events through injected ports.
It does not implement process-tree killing, hardware execution or queue locking.

Verification:
`npm run test:mission-control-service`
`node tests/agent-cancellation-liveness-test.mjs`
`npm run test:smoke`
`npm run test:module-boundary`.
