# Pending Feedback Commands Contract

A committed pre-effect read failure retains every pending slot and old test
round; it never appends a continued-run link. Explicit retry reuses the failed
preparation's admitted deadline through `runs.plan`. See
[generation-preparation](../generation-preparation.md).

`createPendingFeedbackCommands` supplies `settle-pending-candidate` and
`continue-pending-candidate`, each accepting only `manifestDigest` through the
Candidate Validation service. Results are committed feedback or a new generation
run. Injected ports: existing `runs` command, read-only queue lookup, immutable
store read/verification, trusted workspace resolution, read-only diff, clock and
the existing round-experience service's three Pending collection methods.

Settlement reads a committed queue result, verifies current sources and contract,
then prepares the shared domain settlement on a clone. It freezes the verified
experience plan and feedback payload in journal intent before writing an
observation through the existing experience service. Recovery only queries the
same evidence key; confirmed absence allows an identical retry, while a recorded
observation replays state without rewriting. Unknown/store errors block recovery.
`validateApply` rechecks files on replay; a previous read cannot authorize later
edits. No Agent/test starts or workspace file changes occur. File conflicts
preserve current edits, the original receipt and any already verified observation.
The apply function itself remains a deterministic state mutation without I/O.
It retains collection identity/counts under feedback and emits a durable event;
continuation preserves that receipt after the generic generate-only collection
skip. Legacy committed feedback without a collection remains unknown.

Continuation calls the existing Agent command's plan/prepare/apply. It checks
sources again before checkpoint/provider effects, freezes the admitted round and
prior facts in the original intent, and archives through `resetMissionRunState`.
Commit clears old pending slots, stores `lastPendingContinuation`, and appends the
durable previous-test/next-run link. Prepared recovery replays state only; unknown
provider effects retain the journal's fail-closed behavior.

`admittedContinuation` is internal context, never a body field. Ordinary Run and
Resume cannot restart frozen or previously started generation-only Missions.
Repeated HTTP continuation returns the original committed run receipt.
