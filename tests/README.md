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

## Experience architecture / driver target coverage

`experience-architecture-test.mjs` drives only the public append/read/retrieve/validate
contract in memory. It proves that `hardware` and `architecture` are independent
cross-dimension AND constraints (an `nvidia-gpu`+`sm100` record must not satisfy an
`nvidia-gpu`+`sm86` query), that within-dimension OR is preserved, that execution
`scope.architecture` is stamped only from the declared `evidence.architecture` and is
explicitly rejected with `EXPERIENCE_INVALID` when the evidence never declared it, and
that historical canonical records without architecture validate by reference with zero
migration and never gain the attribute. It runs in both verification gates.

`shared-gpu-target-probe-test.mjs` runs a real Python child that imports the shared-GPU
runner while replacing `subprocess`/`shutil` with explicit doubles, so no GPU, driver,
torch install or `nvidia-smi` process is touched. It covers `_resolve_architecture` and
`_probe_nvidia` success, unsupported, error, empty and malformed driver output — always
leaving the architecture undeclared with a note and never inferring it from the device
name — and drives the real `main` normalization with an injected base-runner result:
the probe's device, driver and architecture survive into `environment`/`experienceEvidence`
while `publishable` stays false. Temporary scripts live under the ignored
`.operator-studio-local/` and only that directory is removed in `finally`. It runs in both
verification gates.

## Round feedback / pre-send prompt audit coverage

`round-feedback-integration-test.mjs` is the independent two-round production-path
acceptance for §14.5. It never fills `iterationContext`, `roundFacts` or
`resolvedTarget` by hand: it seeds a real prior round through the production
`ensureRoundBudgetStarted`/`applyOperatorTestSnapshot` boundary, then lets the real
`agent-round-service` plus `main-round-orchestration-service` start the next round
over a real filesystem Experience repository (wrapped only in a read-counting port
proxy) and a real temporary workspace. The Agent provider is an injected client
double, because the acceptance must not consume a live Agent session. The observed
connectivity facts come from the queue projection, the real shared-GPU experience
verifier, the production archive (`resetMissionRunState`) and the prompt actually
authored by `createAgentRuntime`; the round-facts JSON block is parsed back out of
that prompt. Negative cases cover wrong-task no-op, backend-as-hardware rejection,
architecture-scope separation, evidence-identity conflict, baseline transitions,
zero-experience rounds, the 20-item/64 KiB retention caps with their exclusion
reasons, the operator test-failure channel, infrastructure classification with no
operator experience recorded, archive determinism (duplicate reset, legacy rounds
without a roundId, JSON restore) and journal capture/replay.

`prompt-audit-test.mjs` proves the provider-neutral pre-send audit contract for both
`claude-code` and `codex-cli`. The provider double reads the audit file inside its
own `start()` call and asserts the audited string equals `start.goal`, so
write-before-send ordering is observed rather than inferred; the tests recompute the
SHA-256 digest and UTF-8 byte length from the captured string independently and check
Chinese content survives serialization. A failing audit write must reject with
`PROMPT_AUDIT_WRITE_FAILED` and must not call the provider. Version freeze,
auditable selection exclusions (an `sm100` record excluded with reason `scope`) and a
tampered `contextId` failing closed without committing round state are also covered.
Both tests use their own `mkdtemp` root, point `OPERATOR_RUNTIME_DIR`/`OPERATOR_DATA_DIR`
at it before importing production modules, and remove only that root in `finally`.
They run in both verification gates and never touch hardware, a live Agent or the
network.

The audit is a `prepared-before-send` artifact: these tests prove what the production
boundary prepared and handed to the provider port. They do not claim what a live
provider process received, and the `e2e:shared-gpu-agent-iteration` driver likewise
only reads that artifact for the continuation round.

## Failed execution result producer (hardware-free)

`shared-gpu-failure-result-test.py` is the independent hardware-free acceptance for
the frozen producer half of `docs/development/FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md`.
It drives the real `main()` of `tools/local-c500-runner.py` and of
`tools/local-shared-gpu-runner.py` with real temporary candidate/oracle module files,
while only the hardware boundaries are doubles: an explicit in-process torch/CUDA
tensor double, module-level `subprocess`/`shutil` probe doubles (the same technique as
`shared-gpu-target-probe-test.mjs`) and a Triton-free base benchmark timer. The probe
values are annotated hardware doubles that feed the runners' real parsers; they are
not a GPU sample or a driver observation.

Its atomic-failure coverage is the point of the test: every base failure branch (first
and later numeric mismatch, candidate exception, oracle exception, benchmark failure
after correctness passed) must persist a structured `result.json` with the retained
correctness, `benchmark=[]` and a typed first error carrying the real error text, and
the terminal `correctness.json`/`result.json` must reach their real final paths only
through a temporary file plus `os.replace` in the same directory. Any direct
`write_text`/`open('w')` of a final path fails the case, so an atomic replace followed
by a plain overwrite cannot pass; a planted stale successful result is likewise
overwritten by the failed record rather than reused, and shared normalization must
preserve the typed failure instead of replacing it with generic `not_run`. A green
result is producer contract evidence only, never a hardware sample or stability claim.
This file was the original red baseline on the pre-integration snapshot; after the
frozen producer contract landed the independent Root hardware-free run passed 13/13 and
it runs in both verification gates. The task ids, the locked file hash and the
platform artifact digest are recorded in
[`docs/development/evidence/failure-feedback-20260913/README.md`](../docs/development/evidence/failure-feedback-20260913/README.md).

## Failed execution feedback / next-round fact injection (hardware-free)

`failed-execution-feedback-test.mjs` is the independent acceptance for the Node
consumer half of the same frozen document. What is real: the production failed-round
pipeline — `createBenchmarkProjectionService` → `applyOperatorTestSnapshot` →
`roundExperience.collect` → a real filesystem Experience repository →
`resetMissionRunState` archive → `agent-round-service` plus `agentRuntime` next-round
prompt and pre-send audit. What is a port double: the queue snapshot source, package
admission, `readTask`, the prepared-artifact adapter and the Agent provider client, so
no Claude/Codex process, GPU, network call or N=20 batch is started.

The consumer-side next-prompt coverage is the point of the test: the failed
correctness case/code/error and the exact recorded experience id/version/content must
reach the next-round provider prompt and the pre-send audit (`roundFacts` deep-equal,
selection lists the execution-sourced record), a replayed identical observation must
be idempotent, a rejected observation must not grow the real Experience repository,
and `roundCorrectnessFacts` must take the top-level `result.correctness` as authority
so stale successful benchmark rows cannot turn the round into passed and `not_run`
stays `not_observed`. Fixtures, projections and queue receipts are contract/port
doubles and `roundFacts`/`iterationContext`/experiences are read back from production
code rather than hand-authored, so a green result is fixture-only, non-live
contract/integration evidence — never a hardware sample, stability or publishability
claim. This file was the original red baseline on the pre-integration snapshot; after
the production consumer path landed the independent Root hardware-free full-chain run
passed all six sections and it runs in both verification gates. Task id, file hash and
the platform artifact digest are recorded in
[`docs/development/evidence/failure-feedback-20260913/README.md`](../docs/development/evidence/failure-feedback-20260913/README.md).

## Failed execution boundary regression (hardware-free)

`failed-execution-boundary-test.mjs` freezes the failed-execution acceptance
boundaries Root reproduced on the pre-integration snapshot: a control fully bound
failed-candidate observation plus each targeted boundary as one mutation whose
projected/queue/observation copies stay in sync. It drives the real
`createSharedGpuExperienceVerifier` and the real
`createMissionProjectState`/`resetMissionRunState` archive entry, never imports the
frozen `failed-execution-feedback-test.mjs`, starts no GPU/model/provider/network
call and removes its own temporary root in `finally`. Every case runs in one pass;
a red control positive reports each dependent boundary as `blocked` (never green)
so an unrelated pre-integration rejection is not counted as a targeted rejection.
It is contract/integration evidence only and must not be weakened to match a
pre-integration tree. It runs in both verification gates.

## Queue prepared-artifact binding (hardware-free)

`queue-prepared-binding-test.mjs` is the independent acceptance for
`docs/development/QUEUE_PREPARED_BINDING_ACCEPTANCE.md`. What is real: the exported
production preparer `createBenchmarkPackagePreparer`, the production
`createBenchmarkCommands` `start-benchmark` prepare/apply path, the file-backed
`createOperatorTestQueue` persistence and the unchanged strict
`createSharedGpuExperienceVerifier` failed-candidate path. What is a declared port
double: package storage/admission `assemble`/`prepare`/`verifyAdmission`, the
prepared-artifact adapter and the queue backend `serviceClient`, so no GPU, driver,
model, provider, network call or Python runner is started.

The final queue payload is produced by preparer → command → `queue.submit` and is
read back from the durable JSONL, never hand-authored. Coverage: the trusted
admission digest appears identically in the returned request, the recorded command
intent, the persisted queue payload and the applied benchmark execution-package
binding; a conflicting caller digest is overwritten while unrelated fields and
dependent implementation files survive; the frozen `PACKAGE_TEST_SPEC_REQUIRED` /
`PACKAGE_ORACLE_INVALID` failures submit nothing; a complete typed failed-candidate
projection against the production-created request verifies on the unchanged strict
verifier; and deleting or changing the persisted `preparedArtifactDigest` is rejected
with `EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH` while rewriting neither the request nor
the result. A focused read-only composition-root wiring assertion is supplementary to
the behavioral chain, never a substitute: it reads the actual
`createBenchmarkPackagePreparer` construction arguments and requires the frozen
`SHARED_GPU_PACKAGE_ADAPTER` identity constant (never the adapter implementation
instance) to be bound as `packageAdapter`. The trusted admission fixture carries a
fixed non-empty `admissionId`, because the store port result is the only source of
that identity and a JSON-persisted queue receipt drops an undefined field. Projected environment fields are labelled
port doubles, so a green result is contract/integration evidence only — never a
hardware sample, stability or publishability claim. It runs in the release gate.

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
`knowledge-state-test.mjs` covers adoption guards, decision-driven draft/asset
classification, provenance isolation, maximize continuation, repeat governance
and event limits. Its decisions come from the production `evaluateAcceptGate`
single-point computation; legacy drafts without a decision stay `unknown`.
These two tests also run in the release gate; neither initializes storage nor
executes an Agent or hardware.

`evidence-governance-integration-test.mjs` is the end-to-end Phase 2 integration
acceptance. It drives the production projection
`applyOperatorTestSnapshot` to produce a real versioned DTO, then runs
`runAutomaticAdoption` and `runKnowledgeMaintenance` and asserts that the
benchmark, candidate Gate, review Gate, `currentBest`, knowledge draft and
published asset all carry the *same* decision value. A shared-GPU development
run (real execution, restricted environment) must classify as `development`
(never `simulation`), keep `autoPublished` at 0 and yield a `development_only`
change; an explicit simulation yields a `simulation` asset; only a controlled
real double with eligible bound diagnostics may reach `published`. Maintenance
must be a deep-equal no-op on repeat and after a JSON restore, must re-process a
changed draft version/binding exactly once, must not re-run from derived
timestamps, and a legacy or misbound Level 3 draft must stay `unknown` and
nonpublishable. When required real diagnostics are unavailable the projection
must enter a recoverable external-verification wait: the candidate, budget and
resource-release barrier are retained, no new Agent is started, and iteration
ports stay at 0. Positive sources are controlled contract doubles, not real
hardware.

## Phase 2 diagnostic / decision coverage

`evidence-decision-test.mjs` is the independent acceptance for the frozen matrix
in `docs/development/P2_EVIDENCE_ACCEPTANCE.md` (upstream-owned; this test must
not edit it). It drives the public
`evaluateDiagnosticEvidence(kind, evidence, expectedBinding)` for `tracer` and
`profiler` across the four provenance groups (unavailable / mocked / qualified
real / format-valid but wrong binding), covering missing status or source, a
raw status of `ok` that is not a completed collection, unknown-source provenance
despite a present tool artifact, empty or arbitrary content,
string/boolean/array/NaN/Infinity/negative metric values, benchmark-only
metrics, raw artifact paths, exact candidate/run/source/semantic binding and
inputs that must stay unmutated. A qualified kernel trace requires an explicit
`category: 'kernel'` event with finite nonnegative `startUs` and positive
`durationUs`; a missing category, `runtime`/`tool`/unknown categories, a
tool-only trace and a kernel mixture containing one invalid event all fail.
The `schemaValid` (format), `available` (real completion) and `evidenceEligible`
(qualification) predicates are asserted separately — an envelope with unknown
keys instead of an `events` collection is not schema-valid. Numeric equality
with a benchmark latency never proves forgery: a real tool collection whose
`kernelDurationUs`/kernel duration coincides with the benchmark stays eligible,
while a metric explicitly sourced from benchmark is rejected. Invalid
`achievedOccupancy`/`dramBandwidthGbps` aliases fail like their documented
counterparts.

It then drives `evaluateAcceptGate` over every `completeEvidence` branch (local
benchmark-core development, non-local full real, explicit simulation/CPU), final
publication authorization, malformed benchmark values (including
boolean/array/object/null), a mock environment source with `liveHardware=true`,
simulated artifacts under a completed status, legacy results without a decision,
and frozen semantic binding. Missing real diagnostic capability fails
`evidence.complete` and leaves adoption `waiting_external_verification` (never a
candidate hard error); wrong-binding/malformed evidence blocks adoption and
publication explicitly; local development adoption may proceed with publication
pending. It asserts the versioned `decision` DTO and that flat `publishable` is
its projection, not a re-derivation from `liveHardware`. Qualified real fixtures
are contract test doubles, never proof of a live publication run.

`diagnostic-runner-test.mjs` spawns one isolated Python child (`-I -B`,
bytecode disabled) that imports the real `tools/local-c500-runner.py` and
replaces `subprocess`, `shutil` and every torch port with doubles, so no GPU,
driver, torch install, mx-smi, mctracer or mcProfiler process is touched. It
drives the runner's `_analysis_tool` through real command completion, nonzero
exit, exploding invocation, default `unavailable` fallback (which must not
spawn), an explicitly configured command missing from `PATH`, and explicit
`OPERATOR_DIAGNOSTICS_MODE=mock` (status `mocked`, source `mock`, simulated
true, no spawn). It then drives `_diagnostic_result(kind, collection, binding)`
with a raw collection: there is no tool-output parser in this phase, so a tool
process that exits 0 while its stdout self-declares `parsed` kernel events or
profiler metrics still yields empty content and the original artifact is
retained. Benchmark latency is never promoted to profiler metrics or trace
events, a raw `ok` status is never upgraded to `completed`, an unavailable
status wins over contradictory content, tool-only events never become kernel
measurements, a missing/unknown source is never promoted, and bindings are
retained exactly and never fabricated. `_diagnostics_binding(requestId)` is
driven for the frozen five fields
(`candidateDigest/runId/taskId/sourceRunId/semanticDigest`): unknown values stay
explicit null, no extra `missionId`/`candidateId` is required or invented, and
`runId` is the queue `requestId`, never the backend taskId. Temporary files live
under the ignored `.operator-studio-local/` and only the test's own directory is
removed in `finally`.

Legacy migration: `accept-gate-test.mjs` no longer treats a `liveHardware`
boolean as publication authority or a format-only trace/profile shape as real
diagnostic qualification. Those cases now assert explicit failure and
nonpublishability; the published-path coverage uses a dedicated qualified real
positive with explicit `category: 'kernel'` content plus real
status/source/binding. The performance, correctness, baseline and fixed-matrix
assertions are unchanged. `workflow-summary-test.mjs` and
`local-c500-tui-logic-test.mjs` were migrated the same way: their reports render
the six decision items (decision / execution / correctness / benchmark /
adoption / publication) and the blocking reasons from a decision produced by
`evaluateAcceptGate`, so a legacy flat `publishable: true` is never read as
publication authority, and a real-but-nonpublishable result is no longer
flattened into "simulation only".

`evidence-decision-test.mjs`, `evidence-governance-integration-test.mjs` and the
migrated summary/TUI tests register in `package.json` and in BOTH verification
gates. Qualified real fixtures are controlled contract doubles, never proof of a
live publication run; they must not be weakened to match a pre-integration tree.

## Shared-GPU observer and run-ledger acceptance (hardware-free)

`shared-gpu-acceptance-test.mjs` is the isolated acceptance for the pure
observation/statistics contracts in `scripts/shared-gpu-acceptance.mjs` and the
read-only ledger in `scripts/summarize-gpu-agent-runs.mjs`. It imports the public
`verifyContinuationAudit`, `budgetTerminalEvidence`, `evaluateFamilyOutcome`,
`combineAttemptOutcome`, `isRealGpuCompletedCandidate`, `buildConfigFingerprint`,
`summarizeAcceptanceRuns`, `classifyAcceptanceRecord` and `readRunRecord` and
never starts a Runtime, Agent, provider, GPU test or N=20 batch.

It retains every P1 continuation-audit assertion with synthetic objects: the
audit must be the pre-send artifact for the round frozen in
`sourceRound.roundFacts.target.roundId` (a third round or a same-round recovery
run fails), the prompt SHA-256 and UTF-8 byte length are recomputed, the
candidate/queue/`candidateSourceRunId` binding is exact, the bound execution
experience is unique and present in the prompt with its complete content, and
prompt facts are deep-equal to the frozen archive. It also replays the tracked
archived P1 originals read-only, with tampered digest/content negatives; the
check is skipped when those files are absent, so no gate depends on them.

Budget coverage proves a missing/unconfirmed/pending/quarantined/blocked or
foreign-bound release is never safe, a current non-budget reason or bare
`needs_human` is a failure even with a historical budget event, and only a
current Mission/Agent release with a bounded-budget reason can reach
`budget_terminal` (never `full_success`). Family coverage requires two distinct
real shared-GPU completed candidates with purpose/requestId/source/mode/live/
digest binding, a verified audit and a clean automatic rollback, with no reason
hidden. Ledger coverage proves contradictory/missing/running/invalid records
fail, duplicates cannot accumulate toward an N, every missing summary/timeout/
failure stays in the denominator, provider/CLI/model/matrix/budget/code
differences never merge, per-run identifiers never split a group, nested or
declared-provenance fields keep a group non-comparable, a later fingerprint
mismatch cannot ride on a known first record, and 20 controlled same-config
records establish statistical eligibility only — never stability or a hardware
sample. The ledger CLI is exercised read-only against a temporary local run
directory removed in `finally`.

This test continues the cancelled `task_8825a5839e92468184c69d5d7166ac47`
(which produced no artifacts); it verifies the already-integrated production
contracts and makes no new production change and no N=20 or publishability
claim. It runs in both verification gates.

## Model observation acceptance (hardware-free)

`model-observation-test.mjs` and `model-observation-acceptance-test.mjs` are the
independent acceptance matrices for the frozen response-model observation contract
in `docs/development/MODEL_OBSERVATION_ACCEPTANCE.md`. They are hardware-free and
read-only: no Claude CLI, Python runner, network, GPU or N=20 batch is started.
`model-observation-test.mjs` dynamically imports the pure
`client-runtime/model-observation.mjs` so a missing module is reported as
`MODEL_OBSERVATION_API_MISSING`, then drives the real Claude adapter through an
injected fake child stream, the real `agent-runtime` projection and the real
`resetMissionRunState` archive path. `model-observation-acceptance-test.mjs`
drives the pure observer/binding/summary API and the fingerprint/ledger rules.
Observation comes only from `assistant.message.model`; init/config/env/usage
labels and bare probe provenance are never promoted to a response observation.
This is provider-reported metadata, not independent attestation of the remote
service, and a non-observed model never proves or disproves a live run. The
positive/negative matrix covers matching responses versus init/usage mismatch,
env/init-only, missing/blank/synthetic labels, mixed-model conflict, foreign or
absent sessions, thinking-only metadata without thinking leakage, the unterminated
final JSON line, cancellation retention, JSON round trip, malformed DTOs and all
four identity swaps, plus detached projection/archive and stale clearing. The
summary/ledger matrix covers complete multi-run same-model acceptance versus
missing failed/recovery runs, foreign provider/mission/session, conflicting or
contradictory duplicates, empty required lists, dishonest config labels,
attempt/summary disagreement, and fingerprint stability across run/session IDs
with changes for model/code/matrix/budget. A green result is classification
evidence only — never a hardware sample, stability or publishability claim — and
the tests must not be weakened to match a pre-integration tree. Both register in
`package.json` and in BOTH verification gates; the upstream runs the final gates
after the production module lands. `tests/shared-gpu-acceptance-test.mjs` retains
its existing assertions and is registered once, not duplicated here.

## Shared-GPU model collector acceptance (hardware-free)

`shared-gpu-model-collector-test.mjs` is the independent acceptance for the frozen
consumer helpers `collectModelObservationEvidence` and `evaluateMissionStopReceipt`
in `scripts/shared-gpu-acceptance.mjs`, plus the ledger model-proof boundaries in
`scripts/summarize-gpu-agent-runs.mjs`. It is hardware-free: every run record and
stop receipt is an in-memory fixture, and no Runtime, provider, Agent, GPU,
filesystem collection or N=20 batch is started, so a green result is contract and
ledger evidence only and never a real-machine, stability or publishability claim.

The collector is bound to the current attempt's `final` records as authority: a
later `unknown` or conflicting final record invalidates an earlier observed
snapshot, the record's own provider/run/Mission/session identity — never the DTO —
supplies the expected binding, session and thread must agree, and a foreign
provider or Mission file cannot relabel a known start. A started run whose final
record is missing, unreadable or malformed stays in the denominator as unbound
evidence with a nonblank reason, so an absent record is never dropped from the
required count. The stop receipt is confirmed only by a proving current-Mission
release: HTTP 202 alone is not success, a pending/unconfirmed/blocked/quarantined
or foreign-bound release and a current Agent without release proof are rejected,
and the helper stays pure. The test registers in `package.json` and in BOTH
verification gates; the upstream runs the final gates after the production
helpers land, and it must not be weakened to match a pre-integration tree.

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

On Windows the harness run root defaults to `os.tmpdir()`, which can be an 8.3 short name
containing `~` (non-ASCII user names). The Claude Code path-permission guard refuses
writes under such a path, so the Agent silently falls back to the result-patch path while
the acceptance still reports green. Set `E2E_RUN_ROOT` to a `~`-free directory in that case.
The printed `summary` carries `candidateGenerationPath`, `editToolStatus`,
`degradedGeneration` and `degradationReason`, so the report states which generation path
actually ran. Production workspaces live under `<project>/.operator-studio/workspaces/`
and are not affected.

## Generic execution foundations

execution-package-contract-test and execution-package-store-test cover portable
multi-language envelopes, offline blobs, content/admission conflicts, directory
junctions, environment/artifact changes, preparation deadlines and recovery races.
execution-package-contract-test additionally pins the pure `contentDigest` helper
with literal SHA-256 vectors for empty and `abc` input, asserts the canonical
contract export and the legacy store re-export are the identical function, checks
UTF-8 string/Buffer and binary Uint8Array/Buffer equivalence, requires binary
bytes not to be stringified, verifies inputs are not mutated, and retains native
invalid-input rejection. The unchanged state-domain-boundary test remains the
authoritative transitive dependency check for the store-free preparer import.
execution-package-import-test and execution-package-import-service-test cover
directory/tar archive ingestion, complete dependency closure, explicit entrypoint
presence, unsafe source rejection and the application import→prepare boundary.
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

`windows-job-object-test.mjs` covers the Windows process-ownership adapter used by
the local C500 supervisor. It starts both a direct worker and a worker with a real
descendant, asserts that `TerminateJobObject` releases the complete tree, and
checks invalid executable/helper results fail closed. The adapter also rejects
named-Job collisions rather than attaching a new task to an existing owner. The
test is skipped on non-Windows hosts and does not constitute OS sandbox or GPU
evidence. `local-c500-recovery-test.mjs` exercises the same Job Object path in the
production adapter for parent restart, deadline, cancellation races and durable
single-launch recovery. On POSIX it additionally verifies detached
process-group/session identity and reaps a descendant after the group leader
exits; a fast POSIX supervisor may reap that descendant before the read-only
observation, in which case the terminal release receipt remains the assertion.
This case is skipped on Windows where Job Objects provide the equivalent
ownership guarantee.

`shared-gpu-runtime-test` is a read-only capability/policy contract test.
`e2e:shared-gpu` and `e2e:shared-gpu-service` are opt-in checks for the local
NVIDIA adapter and its production queue supervisor. They require the F-drive
CUDA environment, execute real GPU correctness/benchmark work, and mark every
observation non-publishable. They are intentionally excluded from hardware-free
release gates.
