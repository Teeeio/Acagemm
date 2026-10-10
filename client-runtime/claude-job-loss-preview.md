# Read-only durable Job loss preparation

`createClaudeJobLossPreview({runsDir,command,readQueueTasks,readOtherResources,...})`
exposes `readIdentity(runId)` and `preview({runId,expectedIdentity})` only. It has no
retire, commit, state-persistence, process-termination or lease-removal port.
The exact reviewed identity includes the complete original-record SHA-256,
Mission/run/session/workspace, Job name, target PID/creation time and recorded
owner/supervisor PIDs. Changed, extra, missing or foreign fields fail closed.

The adapter accepts only an unclosed local native Windows Claude iteration with
the Read/Write/Edit tool surface and withheld Bash. It consumes public
`inspectClaudeProcess` and `readLocalClaudeTransportCensus` ports. The census
additionally checks original target/owner/supervisor PIDs and Job/directory
tokens. Two distinct ordered trusted observations must show a missing Job,
absent original PID and no matching transport/helper. Active, reused, invalid,
stale or incomplete observations block. Binary changes, unknown GPU/queue or
other resources, and record drift during observation also block.

`readQueueTasks` reads every persisted queue task through its trusted queue port;
`readOtherResources` reads all other resource snapshots through application
ports. Terminal status and explicit confirmed release are required for each.
Missing reads are blocking, not empty evidence. Optional census/kernel/stat/
timing ports are CPU-test injections, not caller-supplied production proof.

A successful result is a dry-run proposal. It preserves
`releaseConfirmed=false`, `originalTreeExitConfirmed=false`, null historical
exit time/code and unknown remote outcome/cost. `logicalLeaseRetired=false`
and `commitImplemented=false` remain explicit. Its proposed permanent fence
would reject old identities and quarantine late results, but is not installed.
An observation is neither authorization nor a future retirement receipt.
Existing legacy retirement remains unchanged and rejects durable-Job records.

Run `node --test tests/claude-job-loss-preview-test.mjs` and the nearest
`tests/claude-execution-retirement-test.mjs`. Fixtures operate on their own
files; the real interrupted Mission, Runtime and harness lease are untouched.
