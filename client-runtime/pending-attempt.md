# Explicit Attempt Contract

`preparePendingAttempt(state,bundle,task,{missionState,missionId,nowMs})` plans
a fresh paused Mission from a verified frozen candidate after the original round
or Mission budget expires. It is pure: no queue, filesystem or Agent effects.
It requires unchanged semantic/test/source constraints, a valid original round,
no unresolved command, and released original execution resources. If a test was
submitted, its exact queue receipt must be terminal with confirmed release.

The child uses new Mission, experiment and semantic snapshot identities. Its
initial source is the frozen candidate; the independent baseline bytes and source
declaration are inherited as an artifact, with no test evidence. Test matrix,
Profile, source policy, language and configured Mission budget stay unchanged.
Agent history, current best, prior test verdicts and retry counters are not copied.
`attemptOrigin` links the parent Mission/experiment/round/candidate/generation,
manifest/patch digests, original task and terminal status, reason and creation time.
The baseline provenance note records inheritance, never a new research run.

`applyPendingAttempt` records the original expiration and parent/child events,
preserves the parent's clock and frozen candidate, inserts/selects the child and
leaves it paused. The existing `/runs {startDraft:true}` starts it explicitly.
This is a new development task, not a retest or renewal of the old task. It does
not claim cold-start experience isolation; experiment controls belong to H10–H16.

## Workspace adapter

`createPendingAttemptWorkspace({readPendingCandidate,workspaceForMission,git})`
exposes `prepare(intent)` and read-only `inspect(intent)`. The injected Git port
is Workspace Manager's isolated `snapshotGit`. It copies verified declared bytes
into a fresh sibling staging directory, creates a raw-byte initial Git commit and
publishes the entire Mission directory by rename. It rejects overlap with the old
workspace, links, existing foreign destinations, source drift and dirty/new files.
Inspection checks the origin marker, exact files/digests, HEAD and clean status.
No user edits are repaired or overwritten. Interrupted staging is retained for
diagnosis. This is optimistic filesystem validation, not an OS lock against
concurrent hostile mutation. Existing bundle limits apply.

The [journal handler](application/pending-attempt-command.md) owns publication
ordering and recovery. Verify `test:pending-attempt`, `test:pending-tui-restart`
and `test:state-domain-boundary`; these grant no GPU optimization evidence.
