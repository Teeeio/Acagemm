# Review Action Service Contract

Owns the low-risk `/api/actions` commands for Mission resume and human decision-review request, cancel, and resolution. It delegates command idempotency, state transitions, workspace recovery, and persistence to the command registry/journal and keeps runtime/workflow guards injected.

## Public API

| Method | Input | Output |
|---|---|---|
| `resume(body)` | Resume command body | command result |
| `requestReview(body)` | requested outcome and approval note | command result |
| `cancelReview()` | none | command result |
| `resolveReview(body)` | optional `outcome` plus resolution note | `{ result, outcome }` |

`outcome` is one of `adopt`, `supplement`, or `redirect`; when omitted it comes from the pending request. `adopt` requires completed evidence. Resolution requires an active pending request.

The service never applies adoption, resets validation, restores checkpoints, or updates knowledge assets itself. Those effects remain command-registry rules. `STATE_VERSION_CONFLICT` is mapped by the route; pending-state, outcome, and workflow failures retain stable error codes.

resume enforces the shared resource-release barrier before executing the durable
command. A paused Mission with unconfirmed old workers cannot restart or restore
its workspace merely by requesting resume.
