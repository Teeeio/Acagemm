# Asynchronous operator test tool

createOperatorTestTool accepts one queue backend and a trusted package admission
port. It exposes capabilities, prepare, submit, read-only get, cancel and
read-only findByRequestId. It does not add a scheduler or await a whole test.

Backends must declare targets, language adapters, idempotent submission and
read-only query semantics. Submit verifies admission before enqueueing.
Capabilities and requests are bounded and receive AbortSignal. An uncertain
submit/cancel timeout is not a failed operator result or permission to retry;
the queue backend must retain ownership and reconcile stable identities.

Local and future cloud queue adapters share this contract. Preparing/building a
package is distinct from testing it; a ready package is not correctness evidence.
The backend must recheck admission and content immediately before execution.

Verification: node tests/execution-package-store-test.mjs
