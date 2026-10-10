# Autopilot Candidate Action Service Contract

Coordinates automatic candidate patch application and candidate-round recovery. Patch application delegates to the injected command executor; recovery generates the stable continuation goal and delegates to `startMainRound`. Inputs and outputs remain transport-neutral state objects.

The documented `PatchPolicyCheckError` from `candidate-commands.mjs` becomes a
returned, paused `needs_human` state (`loopStatusReason=patch_policy_rejected`).
`agent.patchPolicyRejection` retains mission/candidate/source-run/diff identity
and all policy checks. Agent result/model observation and original risk remain
intact; no patch effect or test is started. Lifecycle persists that outcome and
the preceding Agent completion together. Other failures still propagate,
including journal/storage failures and lookalike wire codes. Autopilot reports
`needs_human`, not an applied-candidate action. Existing human feedback/stop and
budget rules remain authoritative; this outcome grants no policy override.

Baseline recovery with no verified candidate: after assertResourcesReleased and a guard against pending candidate diffs, the continuation view marks the old client baseline action completed before startMainRound. Its runId remains available to ordinary archival; clocks, baseline, best bytes and matrix remain unchanged. Forward the exact candidateValidation code/detail automatically, including undeclared filenames, so the next Agent can remove temporary probes or declare real dependencies without changing admission. Unreleased owners and pending candidates cannot use this route.
