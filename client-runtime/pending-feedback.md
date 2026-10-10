# Frozen Candidate Feedback Contract

`assertPendingFeedbackContract` also compares optional `targetProfile` against
the frozen manifest. Changing architecture or its provenance cannot reuse a prior
candidate's feedback contract. Absent fields on legacy Missions remain compatible.

`pending-feedback.mjs` is pure domain logic. Application code supplies verified
immutable bundles, queue snapshots and workspace bindings.

- `assertPendingFeedbackContract(state,bundle)` binds frozen semantics, matrix,
  objective, Profile, hardware, metric, language and source policy.
- `pendingExperienceBinding(state,mission)` admits only explicitly received,
  settled generation-only feedback with matching source/test identities and
  confirmed resource release. Unknown status or conflicting identity rejects
  with `ROUND_EXPERIENCE_PENDING_CONFLICT`. It grants verification admission only;
  the application service still verifies evidence before any observation write.
- `settlePendingFeedback(state,snapshot,workspaceBinding,{nowMs})` requires released
  resources and matching Mission/round/generation/candidate/test identities. It
  reuses ordinary receipt projection, Accept Gate, current-best policy and round
  accounting. It records `iterationStats.pendingFeedback` once while preserving
  the original pending DTO and paused state. No repository write, publication or
  generation occurs. Infrastructure failures and cancellations do not count as
  candidate failures or authorize regeneration.
- `preparePendingContinuation(state,identity,{nowMs})` returns an admitted clone.
  Stopped Missions, recovery blocks, unreleased resources, fixed limits and expired
  clocks prevent continuation. A correctness repair retains its 15-minute clock;
  completed evidence can admit a new round within the unchanged Mission budget.
  Preflight does not clear the original pending state.

Generation-only mode remains unchanged: the next candidate freezes again and
requires explicit test submission. Optional memory is independent of mandatory
prior-round facts. Feedback `ready` does not promise budget remains at a later click.
Cancelled, infrastructure and external-verification results require separate
explicit retry/recovery; these APIs do not silently regenerate them.
