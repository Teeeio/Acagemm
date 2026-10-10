# Pending Attempt Command

`createPendingAttemptCommands({missionState,readPendingCandidate,readTask,
workspace,now})` returns `new-pending-attempt`. Its sole request field is
`manifestDigest`. Planning uses the pure attempt contract and derives a stable
Mission ID from the journal effect ID; callers cannot supply code or new budgets.

The original active Mission owns the command. Preparation publishes the new
workspace through `runEffect`; inspection is read-only. A published matching
workspace recovers the same prepared payload, while proven absence permits
preparation. A changed or foreign workspace blocks recovery. `validateApply`
rechecks files/HEAD before the pure state transition. Journal version and owner
checks still apply. No backend task or provider is launched.

The idempotency key is parent Mission plus manifest digest. A committed state
cursor with matching child provenance acknowledges either a prepared or applied
entry, including the crash gap before the final journal acknowledgement. Repeats
return the original child, even after active selection has moved to it.

Candidate Validation exposes `newPendingAttempt(missionId,{manifestDigest})`;
the thin HTTP route is `POST /api/missions/:id/pending-candidate/new-attempt`.
It returns 201 with committed `state`, `missionId`, `origin`, `started:false` and
an idempotency flag. Domain errors remain explicit 409s; invalid bodies are 400s.
