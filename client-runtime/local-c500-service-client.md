# Local Execution Adapter

## Boundary and compatibility

This adapter owns local C550 / CPU command tasks and their artifacts. It does not
own Mission policy, queue scheduling, execution-package admission or Gate rules.
The stable local-c500 and OPERATOR_LOCAL_C500_* names remain unchanged. CPU keeps
source=cpu-e2e/liveHardware=false; mock results remain simulation. Fixed Profile
mock sequences, matrix content and correctness budgets are unchanged.

`createLocalC500ServiceClient({root,cancelStepMs=500,cancelTimeoutMs=3000})`
returns submit, get, advance, cancel, events and findByRequestId. root must match
the startup-configured task directory. `localC500Config` and the pure
`reconcileLocalTaskSnapshot(stored,incoming)` remain exported.

## Inputs and public operations

- `submit(payload)` freezes requestId/Mission and all JSON content. Missing IDs
  receive a generated local identity; queue callers supply a stable requestId.
  Identity derives the durable task path. Concurrent/restarted submissions return
  the same task; changed content returns OPERATOR_TEST_REQUEST_CONFLICT.
  run.py, optional independent oracle.py and allowed implementation filenames are
  materialized before waiting status. Reserved backend files, Windows aliases and
  traversal paths cannot be supplied as implementation artifacts.
- `get(id)`, `events(id)` and `findByRequestId(id,missionId,expectedPayload?)` are
  read-only. They never start a worker, refresh progress or recover a task.
- `advance(id)` is the explicit execution/recovery operation. It creates at most
  one durable execution claim, starts a supervisor, refreshes progress or recovers
  a matching exit receipt. Existing claims are never spawned again.
- `cancel(id,{reason='user'}={})` persists the request before sending a task-local
  cancellation marker. It waits only to its bounded cancellation deadline.
  Unclaimed tasks cancel without starting a worker. Unknown/unfinished workers
  remain quarantined rather than reporting cancelled.

The default command remains the bundled C550 runner, or the explicitly configured
command. OPERATOR_HARDWARE_DISABLED blocks the default hardware executable but
allows an explicit test command. Existing run/oracle/task/result/progress paths and
environment variables are preserved for the strict CPU runner.

## Durable execution and cancellation

An exclusive execution-claim.json precedes any spawn. It records owner identity,
owner PID, supervisor PID, runner PID and timestamps. A detached, task-owned Node
supervisor executes the configured command, captures bounded output, enforces the
total task deadline and writes execution-exit.json. The supervisor remains able
to finish after the Runtime owner exits. Claim creation and cancellation use the
same short metadata lock; neither can authorize a post-cancellation duplicate.

The current owner signals its process tree with bounded Windows taskkill calls or
POSIX process-group signals, then verifies child closure. Forced cleanup without
confirmation writes a quarantined receipt. A Runtime never sends signals to a
PID loaded from an old claim: cancellation is handled by the original supervisor
through the durable marker. Unknown orphan claims have no automatic restart or
force-release path. A stored result alone never proves process exit.

Successful natural exit, or confirmed cancellation cleanup, permits a matching
receipt to settle exactly one atomic terminal task. Result written before exit
remains nonterminal. Metadata reconciliation preserves the first confirmed terminal
outcome and cancellation intent; live or malformed metadata locks are not stolen
by age. Read-only inspection cannot create/repair these artifacts.

## Output and errors

Snapshots preserve taskId/status/progress/timestamps/logs/result/error and add
requestId, deadlineAt, executionClaim, cancellation reason and resourceRelease:
`{confirmed,status,reason,deadline,nextAction}`. Only confirmed ended work becomes
completed, failed or cancelled; unconfirmed termination stays quarantined.

Exit-1 CPU results retain structured code/category/phase/role/retryable/details
and correctness, including candidate kernel errors rather than generic infra
errors. Invalid/missing result, task deadline, unknown execution owner, receipt
mismatch and unconfirmed cancellation have distinct LOCAL_C500_* codes. Matching
exit receipts are checked before orphan recovery and cannot be replaced by a
success-looking result.json. Signal failures remain in the receipt diagnostics.

## Limitations and verification

This process supervisor is not an OS security sandbox, package verifier or native
Windows Job Object. The backend admission/allowlist must prevent unauthorized
daemonization, escaping process groups and mutation of adapter-owned control
artifacts. It does not guarantee recovery of pre-supervisor legacy executions;
missing receipt/unknown ownership remains a visible, occupied quarantine.

Run local-c500-service-async, local-c500-recovery, operator-test-queue,
queue-stop-race, queue-liveness, local-c500-mock-sequence,
local-c500-no-hardware-guard and local-c500-simulation-artifact tests. The recovery
test uses real bounded Node CPU workers, a descendant tree and actual parent
process exit; it invokes no Python/GPU/Agent. CPU fixture E2E separately exercises
the strict Python runner through the production queue.
