# Claude Windows process supervision

Windows native Claude runs persist run-scoped named Job identity before effects and actual target PID/creation time before returning start. The existing Windows Job helper creates the target suspended, assigns it to kill-on-close Job, then resumes it. The original owner handle is pinned before target start with creation-time validation. A detached native Node supervisor hosts attached hidden PowerShell: observed PowerShell detached launches on this host silently exited without executing. All target streams and the final independent receipt live under the run-specific .job directory.

Public port: createClaudeProcessIdentity, startClaudeSupervisedProcess, inspectClaudeProcess, recoverClaudeProcessRecord. The new Windows intermediary has no workflow/provider rules. Receipt identity requires same named Job/PID/real creation time, actual completedAt, confirmed whole-Job active-process count zero and valid artifact paths. Startup identities, reused/missing PID and empty process lists cannot confirm release. Actual process exit and logical model result remain distinct. The adapter waits for terminal receipt and record persistence when normally cancelling; recovered receipt appends auditable process_recovered evidence. Owner exit terminates only the owned Job. Legacy runs without identity remain unknown and quarantined unless the separate local-host recovery contract proves environment termination.

Native owned CPU-child fixtures cover normal stop, live reopen, PID reuse refusal and original driver exit followed by durable receipt recovery. Injected legacy spawn mocks retain existing interfaces. Run npm run test:claude-process-supervisor and npm run test:windows-job-object; no paid model or GPU task is required.

Detachment only separates console/process-group lifetime. An enclosing tool Job
can terminate the owner, detached supervisor and target together, preventing the
terminal receipt from being written. Strict Windows supervision is prospective:
`OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR=1` creates the suspended supervisor with
the existing breakaway permission and requires it to be outside all Jobs before
resume. `process.supervision` pins that observation and the actual supervisor
PID/creation time. If an ancestor Job still contains it, startup refuses before
the provider target executes; ordinary transport remains compatible. No host
Job limits or ACLs are changed. Original records without a terminal receipt
stay unknown; neither this new preflight nor a current process census repairs
their historical release evidence.

`node --test tests/windows-supervisor-lifetime-test.mjs` reproduces enclosing-Job
loss with an owned CPU fixture in the existing compatibility transport, verifies
strict admission, and checks denied breakaway starts no target. The fixture
never touches the real interrupted Mission or its lease. A host whose ancestor
Jobs prevent independence exercises the fail-closed branch, not a successful
out-of-Job launch.

Result classification keeps an already successful provider result completed when terminal_unreleased cleanup subsequently requests cancellation. Permission denial still fails. Re-reading the same verified receipt may correct an earlier cancelled projection using the original raw result, without changing receipt timestamps or inventing process release; original cleanup diagnostics remain available for audit.

`terminateClaudeProcessWithReceipt` pins the run/Mission/process identity before
termination. If termination fails after natural exit closed the named Job, it
re-inspects the original bound artifacts and requires the same strict terminal
receipt and zero-member proof. Missing, conflicting or nonzero receipts retain
the original error. Both live-owned and reopened cancellation use this port;
`processTerminationRecovery` records the original error and matched receipt
digest. A kernel error or missing handle alone never confirms release.
