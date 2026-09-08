# Operator Test Queue

## Boundary

Owns serialized admission, persistent request identity, bounded backend I/O and
atomic task snapshots. It owns neither Mission/Gate policy nor backend processes.
One unresolved execution owns the slot, including submitting, cancel_requested
and quarantined tasks. Fixed Profile matrices and caller retry budgets are not
rewritten. Metadata locks contain no backend await and never expire solely by age;
only a valid, proven-dead owner PID permits automatic stale-lock removal.

## Public API

`createOperatorTestQueue({serviceClient,filePath,maxAttempts=3,ioTimeoutMs=5000,
taskTimeoutMs=120000})` returns:

- `submit(payload)`: validate and freeze JSON content before the first await;
  generate requestId if absent; persist waiting task. Same requestId/Mission and
  different content throws OPERATOR_TEST_REQUEST_CONFLICT.
- `dispatch({allowStart=true}={})`: atomically claim one operation, then start I/O
  outside the lock and return its snapshot without awaiting the backend.
  allowStart=false never claims waiting work and uses read-only backend get,
  not worker-starting advance, for existing remote tasks. Cancel/reconcile remain
  available behind this new-work barrier.
- `process()`: compatibility driver; await that one bounded dispatched operation.
- `get(id)` / `list()`: legacy effectful process-then-read compatibility APIs.
  Do not bind them to HTTP inspection.
- `readTask(id)` / `readTasks()` / `findByRequestId(id,missionId,expectedPayload?)`:
  strictly read-only committed snapshots, without repair, locks or backend calls.
- `cancel(id,{reason='user'}={})`: an optional reason string also remains accepted.
  Persist intent promptly; dispatch cancellation
  outside the lock. Waiting/unsubmitted work cancels immediately. Started or
  ambiguous work remains occupied until an explicit backend release confirmation.
- `dispose()`: stop this process's deadline scheduling and await bounded I/O
  wrappers during teardown. It does not cancel workers or confirm release.
- `path`: resolved JSONL persistence path.

Backend ports are submit(payload,options), get(id,options), optional advance,
cancel and findByRequestId(requestId,missionId,expectedPayload,options). Options
carry AbortSignal, an I/O deadline and cancellation reason. An adapter that ignores
abort cannot hold the queue lock or extend the wrapper deadline.

## Ownership and recovery

Task snapshots expose frozen payload/requestId, total deadlineAt, dispatchClaim /
cancelClaim owner and deadline, attempts/failures, logs, structured errors and
resourceRelease `{confirmed,status,reason,deadline,nextAction}`. The total deadline
uses positive payload.limits.timeoutSeconds, or taskTimeoutMs, and requests
cancellation independently of polling, including tasks still waiting for a slot.
Confirmed deadline termination is an explicit timeout failure. Cancel has a separate operation lane so
a stalled get cannot block termination.

Submitting persists before calling the backend. Lost/late responses reconcile the
same request ID; this queue never automatically repeats an ambiguous submit.
Only an explicit error.submission `{status:'not_started',confirmed:true,requestId}`
matching the frozen request, together with resourceRelease.confirmed=true, permits
a normal bounded submit retry. HTTP status/error wording alone is not proof.
Even authoritative lookup returning null remains unresolved rather than granting
permission to resubmit. Late acceptance retains the remote ID for cancellation.

Only completed/failed/cancelled plus resourceRelease.confirmed=true is terminal.
A missing confirmation, exhausted poll budget, timeout or unknown owner remains
quarantined and occupies the slot. maxAttempts bounds failed-operation retries;
exhaustion is visible as needs_human, not false proof of termination. Terminal
records reject stale progress, cancellation and late-I/O overwrites. Backend CPU
category/phase/role and correctness failure detail are preserved.

The first implementation requires explicit reconciliation for uncertain requests;
it provides no remote exactly-once guarantee or manual force-release API. Request
idempotency and process identity remain backend responsibilities. dispose is a
process teardown API, not a resource recovery operation.

After cancellation quarantine, a stale poll/reconcile response cannot reopen the
task as running; only an explicit cancellation/reconciliation result with
confirmed release can clear that barrier. Other quarantines (for example an
unknown owner during restart) remain pollable for authoritative recovery.

## Verification

Run `node tests/operator-test-queue-test.mjs`, `node tests/queue-stop-race-test.mjs`,
`node tests/queue-liveness-test.mjs`, `node tests/local-c500-recovery-test.mjs` and
the command-recovery/runtime-read-isolation tests. Fault probes cover hung submit /
get, read isolation, late responses, independent cancellation, total deadlines,
new-work barriers and shared claims. No real Agent or GPU is used.
