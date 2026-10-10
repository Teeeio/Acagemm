# Linux Agent lifecycle port

Production Claude uses this port on native Linux when no injected spawn port is
present. Windows continues using the existing strict Job/AppContainer path.
This is a process lifecycle adapter, with no Mission scheduler or Gate rules.

Public exports: POSIX_AGENT_PROCESS_SCHEMA, createPosixProcessIdentity,
startPosixSupervisedProcess, inspectPosixProcess, requestPosixCancellation and
recoverPosixProcessRecord. The Linux identity helpers export a boot ID/start-tick
process identity and a conservative process-group census.

A private per-run request, stdin, stdout/stderr, startup acknowledgement and
terminal receipt live under <runId>.posix/. Files use mode 0600 and the directory
0700. Projected process environment stays in memory, not in the request file.
The broker creates a detached Node group leader. It pins owner, supervisor and
group leader by boot ID, PID and /proc start ticks. The leader waits while the
client atomically persists the bound run/Mission identity, then executes the
provider in the same group. Startup has a finite 10-second deadline. Existing
Mission/round/stall budgets remain authoritative and call the existing cancel
port; this adapter never resets or extends them.

The original broker observes owner disappearance/reuse, cancellation and child
close. It sends SIGTERM, then SIGKILL within the existing bounded cleanup window,
including descendants remaining after the leader closes. Only that broker
signals its owned group. A restarted client writes a token-bound cancel request;
it never signals stored PIDs. A matched original receipt, actual leader close
and group absence or a complete zombie-only census authorize release.
Permission errors, conflicting/oversized/missing sidecars, PID reuse or a dead
broker without a terminal receipt stay unknown and preserve Runtime barriers.

A logical successful result remains separate from resource release. Receipt
recovery preserves the successful result, a permission failure or cancellation;
it does not infer provider success from exit code alone. Cancellation itself has
a finite receipt wait. No missing receipt automatically retries a provider.

This port assumes children remain in the created process group. It is not a
filesystem/network sandbox or proof against daemonization into a new session.
A production host boundary must constrain such escape. An independent cgroup
supervisor is not silently claimed. Broker SIGKILL can prevent its receipt;
that execution remains quarantined. Systemd service/cgroup provisioning requires
a separate host decision and is not performed here.

Verification: npm run test:posix-process-supervisor includes portable protocol,
identity-conflict and release-negative tests. Native Linux additionally runs real
CPU-only persistence-before-provider and SIGTERM-resistant descendant fixtures.
Windows skips those two explicitly; its passing protocol tests are not Linux
kernel evidence. npm run verify:linux-compatibility is the target Linux CPU gate.
