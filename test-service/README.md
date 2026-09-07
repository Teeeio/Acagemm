# Test Service Compatibility Module

mock-server.mjs is a loopback-only deterministic simulation of the old HTTP
operator-test contract. It creates no execution worker; completed/cancelled
snapshots therefore explicitly report resourceRelease.confirmed=true. Its
measurements and diagnostics are not live evidence.

The process-only `TEST_SERVICE_MOCK_DURATION_MS` setting controls simulated work
duration (integer 1–60000 ms, default 3000 ms). A task's `limits.timeoutSeconds`
remains a deadline for the owning queue; it never sets mock workload duration.
Deterministic integration fixtures explicitly use 100 ms of simulated work while
preserving their task deadlines. This setting is not a production execution knob.

remote-adapter-server.mjs remains a legacy integration, not the new admitted
package/cloud backend. Missing remote ownership/release confirmation must not be
upgraded to a terminal execution proof by a client. This Goal does not authorize
connecting real cloud queues or using old demo credentials.

The new asynchronous tool/package contracts live in client-runtime, share one
queue, and require a locked environment and verified admission. Do not duplicate
Mission, Gate, workspace, or iteration rules in this directory.

Verification: node test-service/contract-test.mjs (simulation only).
