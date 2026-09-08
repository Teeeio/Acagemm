# Test Module Contract

模块归属：跨模块 Verification。测试由对应生产模块主责共同维护，详细映射见
[`docs/development/MODULE_OWNERSHIP.md`](../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

Tests protect production contracts. A test must identify whether it is unit, contract, integration, robustness, or end-to-end coverage.

## Rules

- Do not preserve tests for removed production paths.
- Do not use simulation evidence as proof of C550 correctness or performance.
- Tests that spawn a Runtime must use an isolated tester home and disable ambient auto tick unless the test targets auto tick.
- Temporary state must be cleaned in `finally` blocks.
- Contract tests should assert stable behavior and error codes, not incidental implementation text.
- `module-boundary-test.mjs` requires every Application service to appear in the central module
  ownership index, so new services must update their local contract and the shared catalog together.
- Hardware-free release checks must not invoke Python runner, `mx-smi`, `mctracer`, or `mcProfiler` unless explicitly mocked.

## Command recovery coverage

`command-recovery-test.mjs` injects failures before effects, after task submission,
before prepared-result persistence, during state commit and during acknowledgement.
It uses an actual isolated queue with the production Benchmark command, verifies
frozen evidence inputs and confirms that recovery lookup does not execute hardware.
`workflow-commands-test.mjs` covers admission, tracked effects and state-only
application. Both run in the release gate.

## Generic iteration foundations

`candidate-generation-test.mjs` covers the extracted 03 Candidate Generation contract:
prompt boundary rendering, Workspace Diff authority, declared-file matching, language
contract admission, repeated-digest rejection, and stable candidate ordinal assignment.

Package contract/store tests cover language-neutral immutable layers, dependency
content, path escapes, trusted admission, late preparation and resource quarantine.
They use adapter doubles and do not certify an OS sandbox. Local recovery tests
use short real Node workers for parent restart and descendant-tree cleanup; the
non-hardware gate additionally runs real Python CPU tests with an independent
oracle and exact frozen cases/profiles. Neither is live GPU evidence.

Experience API tests and runtime-read-isolation exercise production human guidance
CRUD without Runtime/queue mutation. Round-experience and agent-start-context
verify frozen versions, journal replay and scoped prompt input. Round-budget tests
cover the complete 15-minute clock across retries, pause and pending cancellation.

## Query/advancement coverage

`runtime-read-isolation-test.mjs` boots an isolated Runtime with hardware disabled.
It verifies byte-identical state and queue files after GET/SSE/task queries, no
journal recovery during reads, same-version recovery-overlay SSE notifications,
corrupt snapshot inspection without file repair,
explicit POST advancement, and background progression without client polling.
`runtime-lifecycle-service-test.mjs` covers serialized read/advance interleavings,
blocked recovery, owner loss and no-op ticks. Maintenance and pipeline tests protect
policy ordering. All three new tests run in the release gate.

The non-hardware gate also runs the legacy test-service contract. Its mock
workload uses an explicit 100 ms process setting, independent of task deadlines;
journal/smoke fixtures retain their original 1-second task ceilings.

Deterministic workflow harnesses disable auto tick and call
`POST /api/runtime/advance` only at their intended progress points. Do not restore
implicit advancement inside a GET helper.

## State domain / adapter separation coverage

`state-domain-boundary-test.mjs` parses static ESM imports and re-exports with
Node VM Modules without linking/evaluating the inspected graph. It recursively
rejects concrete effects, tests transitive-bypass/cycle guard cases, and checks
canonical/facade export compatibility. Dynamic/alternate module loaders are not
permitted in these domain roots. Its npm command enables the Node VM Modules flag;
no parser package is added.

`state-storage-adapters-test.mjs` injects write/rename failures and verifies
previous committed bytes, exact permission-error retry budgets, read-only raw
snapshot behavior, bootstrap ports, and isolated Git checkpoint restoration
(including index cleanup and rejected foreign paths/Missions). All real files and
Git operations are confined to a temporary test root; no hardware/Agent is used.
Both tests run in the release gate.

The dependency graph now also covers Mission/Project, Knowledge, initial state,
reference records/projections and every Application service. It checks factory
path ports, separation of schema/version policy, legacy export aliases and
constructor failure when domain transition ports are missing.

`mission-project-state-test.mjs` exercises the compatibility API entirely in
memory: Mission/Project lifecycle, 26 projected-field isolation checks, selection
priority, error statuses, budget and fixed Profile/semantic preservation.
`knowledge-state-test.mjs` covers adoption guards, live/simulation/CPU provenance,
draft eligibility, maximize continuation, repeat governance and event limits.
These two tests also run in the release gate; neither initializes storage nor
executes an Agent or hardware.

## Naming

- `*-test.mjs`: Node unit/contract/integration test.
- `*-test.py`: Python runner contract test.
- `e2e-*`: full production-path scenario.
- `*-extreme-test.mjs`: generated or adversarial state-space coverage.

## Verification Entry Points

```bash
npm run verify:local-c500-release
npm run verify:non-hardware-robustness
```

`npm run e2e:cpu-iteration` is the deterministic full-workflow E2E. It uses the
Reference Fixture for Candidate generation and executes lightweight Correctness
and Benchmark work in the standard-library CPU runner. The result is always
`source=cpu-e2e` and `liveHardware=false` and cannot prove C550 correctness or
performance. The non-hardware verification entry point includes this E2E.

`npm run e2e:cpu-agent-iteration` is the opt-in acceptance test that uses a real
local Agent plus actual CPU correctness and benchmark execution. It verifies
that an unmet Accept Gate closes the current round and starts the next Agent
round without harness intervention. It is excluded from routine verification
because it consumes a live Agent session.

## Generic execution foundations

execution-package-contract-test and execution-package-store-test cover portable
multi-language envelopes, offline blobs, content/admission conflicts, directory
junctions, environment/artifact changes, preparation deadlines and recovery races.
Their adapters are contract doubles, not evidence of an actual OS sandbox.
experience-service-test checks immutable versions, project scope and non-publishable
observations. codex-cancellation-test uses short-lived Node process trees, not a
model. agent-cancellation-liveness-test and generic-runtime-safety-test enforce
resource barriers and budget-before-dispatch behavior. HTTP request/client tests
use memory streams and loopback servers only.

`generic-iteration-fault-injection-test` integrates these boundaries through the
production queue/tool contracts. It injects package-inspection timeout, lost
submit response, structured runner failure, cancellation without release proof,
and command-journal acknowledgement loss; every case must converge without
duplicate execution or false terminal evidence.

local-cpu-runner-test executes bounded Python CPU subprocesses. It runs explicitly
in non-hardware verification, not as GPU or strong-isolation evidence. CPU fixtures
must provide a separate oracle and a complete exact testSpec; malformed matrices
cannot be normalized into success. Real Codex acceptance remains opt-in and is not
satisfied by these fixtures.

`shared-gpu-runtime-test` is a read-only capability/policy contract test.
`e2e:shared-gpu` and `e2e:shared-gpu-service` are opt-in checks for the local
NVIDIA adapter and its production queue supervisor. They require the F-drive
CUDA environment, execute real GPU correctness/benchmark work, and mark every
observation non-publishable. They are intentionally excluded from hardware-free
release gates.
