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

## Experience condition study acceptance (hardware-free)

`experience-condition-runtime-test.mjs` and `experience-condition-study-test.mjs` are the
independent 13-item matrix for the study condition contract
(`docs/development/EXPERIENCE_STUDY_CONTRACT.md`). Both suites were written by a separate
author against the frozen interface, use only documented public entry points and ports, and
build their fixtures from the real production path — the experience repository, the HTTP
application service, the KernelWiki importer, the round-experience service, the context
formatter and the candidate-prompt builder. No assertion matches implementation source text
and no provider/model/network/Python/GPU work is contacted: the study runner cases inject only
the documented `invokeSmoke` fixture port, so no smoke child starts for a slot. The slots it
produces are read back by the runner's own default `readInvocation` port from fixtures written
in the frozen producer layout on disk (the real repository store plus the batch report,
attempt/summary/state/prompt-audit/study-audit originals), and the public `verifyStudyReport`
is exercised against those retained bytes rather than a mock reply.
One group of real-child cases is the production-driver guard, which runs the driver CLI
under a broken study environment with `OPERATOR_CLAUDE_BIN` and `OPERATOR_GPU_PYTHON` pointing
at absent paths, in an isolated temporary artifact parent, and accepts only the preflight
refusal (non-zero exit, no run root, no state, no report). The standard N20 refusal is
exercised in process through the batch runner's documented injected-port path.

The other real-child group is the three frozen spawn scenarios of
`EXPERIENCE_STUDY_SPAWN_CONTRACT.md`. They call the real exported `createDefaultInvokeSmoke`
default adapter — never an injected `invokeSmoke` port — and the adapter spawns one temporary
inert local Node child per scenario, each in its own temporary artifact parent, report
directory and snapshot file, with a unique pair of stream markers so no case can be satisfied
by another case's bytes. The child validates the fixed smoke argv (mode smoke, the affine
family, the three explicit paths), the fixed condition and snapshot environment, and its own
exclusive report-directory creation, and it reports its own marker together with its own exit
code instead of relying on an uncaught assertion, so every scenario can prove which check
really stopped it. The parent must find the raw log under `artifactDir/logs` — the layout the
retained slot `logPath` names — carrying exactly the child's two distinct stdout and stderr
markers in one log, and must prove that the parent created no `logs` directory inside the
child-owned report directory and left the artifact parent holding only its own log directory.
The second scenario lets the child print an explicit success declaration on stdout — a JSON
marker carrying `success: true` and `status: "completed"` — and exit 3; the real exit code and
that complete raw stdout line must both survive, with no success-shaped field minted into the
port value and the retained declaration read back from the log itself; the third pre-creates the report directory with a sentinel, and the child's
exclusive mkdir must refuse it with its own non-zero code while the sentinel keeps its exact
bytes and every original entry stays in place. A broken default log path fails the positive
scenario on both counts (no log at the frozen path, and the child's exclusive mkdir fails
because the parent created its report directory first). No provider, model, Python, network,
Acagemm runtime or GPU is contacted; a passing run is startup-plumbing evidence, never live
hardware, selection or publishability evidence.

Runtime matrix (items 1-8): the default retrieval and the retained strict continuation
verifier are unchanged; all three conditions filter before rank/quota, `facts-only` records
zero selected entries while `local-only` keeps the bound execution record and excludes every
kernel-wiki unit; zero-experience mode still collects execution observations and mandatory
round facts; invalid, null, empty and non-string conditions fail with `EXPERIENCE_INVALID`
before any state change and unsupported legacy retrieval fails; a frozen same-round context
cannot switch condition while a new round uses the configured one; unauthorized IDs stay
hidden and scope/hardware checks are never bypassed; and the exact condition plus policy
version enter both the persisted selection sidecar and the pre-send prompt audit.

Study matrix (items 9-13): `facts-only` accepts a really empty injection with complete
matching facts and durably collected source-round experience, and rejects lost facts,
tampered prompt digests and sidecar mismatch; `local-only` rejects Wiki contamination in the
actual prompt, while `local-and-wiki` requires at least one reviewed sm86 unit with exact
full prompt content, refusing unreviewed units, wrong content, a fully dressed but never
imported unit, a duplicated unit and a sidecar-only selection that the prompt never carried,
and a snapshot from another source commit — every prompt tamper arrives with its prompt SHA
recomputed, so the targeted rule is what rejects it; the frozen nine-slot balanced schedule is
asserted literally and the retained `study.json` must already carry it before the first spawn.
A complete valid nine-slot positive is built first — nine explicit `invokeSmoke` calls, nine
completed exit-0 slots each retaining the seven frozen originals with their real sha256 and byte
length, and a `verifyStudyReport` receipt with `ok: true` and all nine slots verified — and
every drift case starts from it: slot one must be a real comparable `full_success`, slot two is
that same invocation with exactly one documented field changed (source, budget, model, snapshot,
condition, selection policy, unknown observation or a non-full-success release), slot one must
still be retained as completed, and the remaining seven slots must stay stopped, so release/
unknown/model/source/config/snapshot/condition mismatches never replace or resample a slot and a
genuinely drifted report must still verify as `stopped`. Every drifted field is reported as its
own independent sub-case with its own name and fixture, so one failing branch can never hide the
later ones while any failure still makes the whole run exit non-zero, and the exit code each
branch expects is stated per scenario rather than assumed: a configuration or observation drift
keeps the green zero, the non-full-success release requires its real non-zero exit together with
that exact `smoke_exit_code` verdict, and the released slot's own retained smoke report is read
back from disk to prove the actual exit code, failed status and non-full-success outcome were
kept instead of being minted into a pass. The receipt keeps the actual outcome
histogram (`slotCounts`, one completed / one failed / seven stopped) apart from its per-slot
verification coverage (`verifiedSlots` covers every retained slot, completed, failed or
stopped, so its length is never read as a count of successes and `ok: true` only means the
report was faithfully verified); invalid CLI arguments, alias
spellings, overlaps and pre-existing directories are rejected without side effects, and the
read-only report reader is proven to start no invocation, to leave every retained byte
untouched and to refuse a hand-written report that no producer ever wrote. Every reader negative
builds and verifies its own complete green fixture on its own bytes first — the retained
`schedule` and `invocations` are read from those two frozen keys and asserted slot-by-slot, never
found by a shape-recursive search — and then mutates exactly one documented field or one raw
original of that same fixture in place: a recorded original sha256 or byte length, the raw
artifact bytes behind an original, the schedule, a slot's condition, order, index, exit code,
status, metrics or run root, the compared design identity, model and source, and a comparison
that claims significance or flips its descriptive-only flag. Nothing is
copied or repointed, so a negative can never be judged on a layout the copy itself broke. The
slot fixtures themselves carry the real producer shapes — the Mission-bound
`attempt.familyOutcomes[0]`/`summary.summaries[0]` identities with the observed-model proof, the
live-hardware candidate rows with their unit/value/correctness receipts, the two distinct
candidates that identify one archived round and the reviewed-unit snapshot metadata — and that
completeness is asserted before any case-specific mutation. The production
driver and the standard N20 mode must both refuse a study environment before any effect, and
the standard fingerprint keeps the current D selection policy — read from the production
export and asserted on the retained artifacts — plus the study condition, snapshot digest and
goal policy, while only the condition may differ inside the shared design identity, so source
and model drift stay visible.

Both suites run in the release gate. Before the parallel runtime/driver candidates are
combined they cannot pass: they exercise the explicit `experienceCondition` port and the new
study modules, and the spawn scenarios additionally link the runner's exported default adapter,
so a green run is evidence for the integrated interface only, never a
selection benefit, stability or any N20 claim (`strictN20Passed` stays false).

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

## Experience study stop and nested-exit acceptance (hardware-free, NOT YET COMBINED)

`shared-gpu-observer-stop-test.mjs` and the `matrix 14` cases of
`experience-condition-study-test.mjs` are the independent positive/negative pair for the
frozen addendum `docs/development/EXPERIENCE_STUDY_STOP_CONTRACT.md` (S1 durable experience may
already exist, S2 three process layers have separate exit meanings). They were written by the
single independent test writer that owns both files and this README; they edit no production
file and no acceptance input.

**These additions are not combined yet, and nothing here is claimed as combined evidence.**
The S1 production helper `hasDurableCollectedExperience` is a newly frozen interface that the
implementation candidates had not landed at author time, and the S2 reader rule that accepts the
nested `driver exit0 under a failed smoke batch` truth was not landed either. In this isolated
author tree both files therefore run against a tree without that production change: the author
phase ran `node --check` on both files plus one bounded targeted consistency check of the real
pure verifier receipt shape (no reader, no driver and no simulated implementation). The measured
boundary, never a pass:

- **S1**: the first independent full run of `shared-gpu-observer-stop-test.mjs` against a
  combined candidate reported 26/27. The single failure was the Mission-identity case asserting
  `continuation.facts.target.missionId` — a `target` subtree the production verifier receipt never
  returns, because its `facts` projection is flat (`previousRunId`, `previousRoundId`,
  `previousCandidateId`, `previousQueueRequestId`, `gateResult`, `rollbackPerformed`,
  `currentBestCandidateId`). The case now asserts the identity where the producer really keeps it;
  the receipt shape it relies on was re-checked against the real pure verifier (6/6). A combined
  S1 re-run is still owed.
- **S2**: the full `experience-condition-study-test.mjs` suite reports **20 passed / 3 failed** in
  this tree, before and after the fixture correction. All twenty pre-existing cases stay green.
  The three new `matrix 14` cases previously stopped inside fixture construction
  (`nested fixture declares provider model never observed actual deepseek-v4-flash expected
  unknown`); with the derived unknown provider identity they now reach the target branch and fail
  only on the still-unlanded production reader rule
  (`scripts/run-experience-condition-study.mjs`: *slot 2 retained batch invocation exit code is 0
  although the smoke child exited with 1*), which the frozen S2 contract requires to be relaxed
  for exactly this truthful nested failure.
- **Final combination has not passed.** The S1 helper/live-driver wiring and the S2 reader change
  must be landed by the implementation candidates, after which both files must be re-run in
  combination. Until then a red result is the expected pending-combination state, exactly like a
  missing export or an unchanged recorded-only driver, and it is never a pass.

S1 — `shared-gpu-observer-stop-test.mjs` has two independent layers, reported case by case.
The first reads `hasDurableCollectedExperience` off the **real** module namespace of
`scripts/shared-gpu-acceptance.mjs` at runtime, so a missing export is an explicit
expected-red contract failure instead of an import crash and the case can never be satisfied by
a predicate copied into the test. Its positive cases are the frozen evidence shapes the
production round-experience service really writes (`status: 'recorded'` for a new record, for an
idempotent existing-only collect and for a mixed counter pair) and every documented negative is
its own case: absent/non-object collection, zero or missing counters, `failed`/`pending`/
`skipped`/`mixed`/unknown/blank/case-variant status, and negative, string, `NaN`, infinite,
fractional, null and boolean counters.

The second layer executes the **real live driver** as a child process against an explicitly
inert harness. There is no source-root override of any kind: a shadow root is built from this
repository, holding a byte-identical copy of the driver and of every local module it imports
(each copy's SHA-256 is asserted against the repository file in its own case), and the one file
the driver spawns — `client-runtime/local-server.mjs` — is replaced by an inert loopback port
double. Inside that shadow root no client Runtime, provider CLI, model call, Python, GPU runner
or outbound socket is contacted: the provider-CLI probe is answered from a declared label, the
GPU baseline/queue/test projections are scripted state, and the only child process is the
double, whose only socket is its own reserved loopback port. The double serves the real R4
evidence shape — two completed real Candidate tasks, a continued second Agent round and
`experienceCollection = {status:'recorded', recorded:0, existing:1}` — together with a **real**
prepared-before-send audit and the real bound execution experience of the source round, both
owned by the original Mission id. The frozen consumer must leave the loop on the existing-only
evidence, request the production stop promptly and **before** the later experience/audit reads,
keep the pre-stop observation state, retain the confirmed stop receipt, and still verify the
post-stop continuation audit **under the original Mission identity**: a driver that drops the
Mission id after the stop can no longer select that artifact, and the "no retained pre-send
audit" failure it produces is refused by the named identity case instead of being accepted as a
missing artifact. That case asserts the identity where the producer really keeps it — the
retained artifact's own frozen round facts, the driver's retained family identity, and the real
artifact/target-round/continuation-run binding — because the verifier receipt projects the
audited facts into flat fields and returns no `target` subtree; the receipt's flat fields are
then required to agree field by field with the artifact on disk. An unchanged recorded-only
consumer never leaves the loop at all and is reported against its own deadline. Every started
run is still collected after the stop, with the
cancelled/unobserved run retained as required and unknown and never promoted to a borrowed model
label. A green result is contract/integration evidence for the frozen interface only: no real
machine, stability, N=20 or publishability claim is made or implied.

S2 — `matrix 14a` drives the real study runner with slot one complete and slot two the frozen
nested-exit failure, then reads the retained bytes back through the public `verifyStudyReport`.
The retained evidence keeps the three process layers apart: the outer
`study.invocations[N].exitCode` is the smoke batch child (1, failed), while the nested
`slot-NN/batch.json.invocations[0]` is the individual live driver (0, completed,
`full_success`, `comparable: false`, with the `provider.model` comparability issue), and the raw
driver `attempt.json` independently retains the successful workflow together with its unknown
model proof. The nested slot is the one deliberate exception to the complete observed-model
proof, so its configuration carries the terminal provider identity the real driver derives from
that proof — model `unknown`, source `unknown`, and the summary's own status and schema version —
instead of a declared observed model the run never read. The configuration, its comparable
fingerprint, the retained attempt/summary provider copies and the acceptance ledger's
`provider.model` non-comparability verdict are therefore consistent by construction, and the
ledger's own verdict is asserted rather than hand-written. The reader must verify this truthful
failure as a **stopped** study with the outcome histogram one completed / one failed / seven
unstarted and `strictN20Passed: false`, and
must never require the two child exit codes to be equal. `matrix 14b` refuses a smoke report that
claims `passed` while the outer slot retained a nonzero exit (the contradiction the contract
names), and `matrix 14c` refuses a nested failure whose one-invocation non-comparable proof was
dropped — its issues stripped and comparability asserted — while the raw driver artifacts still
retain the unknown model proof, so the invented success can never stand. Both negatives build and
verify their own complete stopped fixture on its own bytes first, then mutate exactly one field of
that same fixture, and both prove the refusing reader rewrites no report or raw artifact byte.
The twenty existing study cases (runtime items 1-8, study matrix items 9-13 including the eight
drift sub-cases and the reader negatives, and the three spawn scenarios) are unchanged and keep
their original invariants and fixtures.

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

## Bounded run diagnostics acceptance (hardware-free)

`agent-run-diagnostics-test.mjs` is the independent acceptance matrix for the frozen
`docs/development/RUN_DIAGNOSTICS_ACCEPTANCE.md` (D1/D2/D3, T1–T9). It drives the real
`createClaudeClient` entry point with an injected fake child process — no live Claude CLI,
model, network, Python or GPU process is started — and the real
`createAgentRuntime({ mode: 'claude-code' })` entry point with an injected provider port
double that records the exact `cancel(runId, context)` call it receives. It is the only
test allowed to assert diagnostic internals.

T1–T4 cover the exact bounded run record: fixed key sets, defaults, separate simultaneous
run identities and counts, per-stream stdout/stderr chunk and byte counters with ordered
first/last times, blank/invalid/primitive/unknown line classes, the unterminated final line
counted once at close, telemetry counted before filtering, `firstModelObservedAt` set once
through the existing observation authority (thinking-only assistant, later conflict never
erases it; init/usage alone never set it), the real close receipt
(`exitCode`/conventional `signal`/null otherwise) and a durable JSON reload. Persistence
ordering follows the frozen contract instead of an assumed flush: because D2 guarantees
before-close observability only for stderr and cancellation while D1 only requires the
final record to be durable at close, T1 asserts `close === null` before a controlled close
and then reads every final counter per run, and T4 proves stderr visibility on its own
fresh run that writes one stderr chunk with no stdout queued ahead of it. T4 also counts a
valid JSON `null` on a main line and as the unterminated tail line as `other` (never
invalid), and shows the `other` bucket is counted over raw JSONL before the existing
filter: the provider-neutral `readEvents` log never fabricates an entry for those lines.

T5 holds the termination promise pending and proves the first cancellation is durable while
`close` is null, that repeat, foreign and context-less calls cannot replace a valid first
one, and that after-close cancels never fabricate a request. Its invalid-context coverage is
table-driven: foreign run identity, foreign Mission identity, role, trigger, timestamp and
each numeric field are rejected one at a time, each on its own fresh run with every other
field legal, so a later validation branch cannot hide behind a fully corrupted first
context; a direct legacy `cancel(runId)` on a live child is separately proven to record
`requestedAt` with `context: null`.

T6/T7 drive the real Runtime branches: main budget-only, stall-only and both, research and
materializer expiry, and explicit `cancelRun` for each role, asserting the detached context
scalars and that no premature release or candidate admission happens. T8 holds the provider
cancel across the caller deadline, proves single-flight reuse, finite retry exhaustion
staying blocked/quarantined, that a late completion cannot mutate an earlier snapshot and
that a later confirmed release converges without a new request; it drives that release
through a real empty temporary Git workspace, because the convergence projection reaches
the workspace-Diff authority, and it asserts the existing timeout-recovery terminal state
(`completed` with `timedOut`, not a bare `cancelled`) rather than inventing a new outcome.

T9 (the existing tests keep their old invariants, and no test was weakened to accept this
change) is owned by the platform acceptance_inputs and the Root combination gate, which
runs the unchanged existing model-observation, cancellation-liveness, timeout-recovery,
runtime and claude-client tests. This file deliberately neither pins source/test digests
nor re-spawns those suites: doing so would lock unrelated later edits and duplicate the
release gate instead of proving the diagnostics contract.

Every wait is a bounded condition wait, each scenario uses an isolated temporary root
removed in `finally`, and negatives are arranged so the targeted branch is actually
reached. This test was written before the producers landed and stays red until the
combined candidate provides them; the author phase only runs `node --check`. It registers
as `test:agent-run-diagnostics` in `package.json` and in the release gate
(`verify:local-c500-release`), so the gate keeps covering it after integration. A green
result is contract/integration evidence only, never a live-CLI, stability or
publishability claim.

## Kernel Wiki import and deterministic selection acceptance (hardware-free)

These three files are the independent acceptance matrix for
`docs/development/PHASE3_WIKI_CONTRACT.md` sections A–D. They were written against
the frozen interface before the parallel producers were combined; until the
combination provides `client-runtime/experience-selection.mjs`,
`client-runtime/kernel-wiki-import.mjs`, `scripts/import-kernel-wiki.mjs` and the
import/prepare integration they can only be syntax-checked, and the author phase
runs `node --check` only. They register as `test:experience-selection`,
`test:kernel-wiki-import` and `test:kernel-wiki-runtime` in `package.json` and in
the release gate (`verify:local-c500-release`), so the gate keeps covering them
after integration. A green result is contract/integration evidence only: it is
software correctness, never a claim about selection benefit, the historical
strict N20, provider quality, GPU behaviour, stability or publishability.

All three files run every independent case behind a shared per-case harness: a
failing case prints its own name and stack, the remaining cases still run so one
combination collects every failure instead of only the first, and any failure
sets a non-zero process exit code instead of ending on a summary line. Every
rejected input is asserted against an explicit domain error code (an exact frozen
code where one exists, otherwise the presence of a coded domain error) and, for
the pinned CLI, against a non-zero process exit, so a case can never pass because
of an unrelated `TypeError` or a fixture that broke earlier than its target
branch. A case that compares a whole frozen artifact also asserts the documented
result shape (for the apply path, the `created`/`updated`/`unchanged` counts, the
per-unit `records` identities within the 160-character bound, the pinned source
commit and a 64-hex snapshot digest).

`experience-selection-test.mjs` drives the pure selector plus the real experience
repository, the real contract retrieval and the real HTTP application API (the
only writer of selection metadata). It covers the frozen policy version and the
exact metadata key set with an unsafe/invalid matrix (unknown keys, uppercase or
short commit, path escapes, unsafe ids, bad digests, oversized arrays, unknown or
contradictory applicability modes), generic HTTP create/update rejection of
`selectionMetadata` plus the same rejection on the generic service create/update
ports (the rejection belongs to the domain write path, not to an HTTP field
filter, and the explicit import API stays the only entry) with byte-compatible
schema-1 records, legacy ordering/policy version with zero migration, local-first
ranking with the D quotas (local ≤4, Wiki ≤6 =
symptom ≤2 / technique ≤3 / guidance ≤1, never padded, so a default selection
never exceeds the 10-unit D cap), metadata recall beyond the legacy top-20
window, `sm100`+`nvidia-gpu` rejected for an `sm86`+`nvidia-gpu` target (and a
missing target dimension failing applicability instead of being assumed: an empty
architecture dimension left empty on both the canonical query scope and the
selection target stays a legal query that selects zero items, while a selection
target that disagrees with the canonical query scope on architecture or on
hardware is rejected with a coded domain error instead of being answered), the
exact same-project head of an updated record being selected while a foreign
project's record is neither selected nor named, a version pin below the head
selecting nothing while the pinned-out head is audited with the frozen
`version-pinned` reason and the historical version stays readable by an explicit
version read, a real `type: pattern` page ranked in the **symptom** bucket
(TEAM_HANDOFF 8.3: `wiki/patterns/` pages are symptom-indexed and are themselves
a one-hop source; a pattern unit is never promoted to technique or guidance),
one-hop `candidateTechniques` expansion without recursion and without duplicates
(one hop selects exactly the matching symptom unit and its technique-unit
candidate, and a pattern unit without a matching symptom is neither a hop target
nor a guidance fallback), exact-repeat-only demotion for local and Wiki units
alike that never bans a technique category, status/expiry revalidation with no
inaccessible ID or content in the audit, raw Wiki units and their reviewed
transfers staying separate records that never overwrite each other with the audit
naming each selected unit's own record/version/unitDigest/source commit (two
selected units never collapse into one audited source identity), the 24 KiB soft
budget measured on rendered
UTF-8 bytes (an oversized optional
record is skipped and a later smaller one still selected) under the 64 KiB/20-item
hard bounds, Wiki provenance never being diagnostic evidence (a schema-valid but
non-real diagnostic envelope is ineligible next to a positive control that proves
the fixture itself qualifies, each non-real provenance reporting its own frozen
reason; a wrong-format envelope fails the schema branch with exactly
`diagnostic.schema.invalid`, and a schema-valid envelope without the expected
candidate/run binding is available but never eligible for
`diagnostic.binding.expected_missing`), and bounded, deterministic options
(preferred IDs still recalled with no topical feature, and the preferred/repeat
negatives failing on their own bound rather than on a missing `features` field).

`kernel-wiki-import-test.mjs` covers real source-like frontmatter (quoted colons,
inline and block lists, an ignored nested `performance_claims` block), explicit
failures for malformed pages, topology and pin mismatches (duplicate page
identities, a review for an unknown page, a malformed commit), the exact title
fallback both ways — a page whose only heading is absent keeps its page id as the
display title, and a page carrying a heading derives the title from the first
markdown heading, with the imported page id unchanged in both cases (title is
display text, never import identity) — a frozen page and every stored record
keeping the exact source commit citation in their content, snapshot determinism
and change sensitivity (with
the canonical envelope digest recomputed independently), the atomic apply path
against the real repository (pinned per-project record IDs,
unverified/non-publishable provenance, and raw Wiki topics never copied into
scope: at the raw snapshot envelope stage the scope is the pre-domain shape and
carries no `tags` key at all — an absent or empty `tags` is the correct state and
must never equal the page's source `topics` — while the stored domain record
normalizes `scope.tags` to `[]`), a full review
lifecycle on one stable page unit (an architecture-specific review qualifies the
original unit in place, revoking the review advances the same ID again, a
`reviewed-transfer` review with explicit content adds a separate
`pageId-transfer-reviewId` unit while the raw unit keeps its bytes, and a second
review id derives a second stable unit), illegal unit combinations (unitId
disagreeing with pageId, a selection pageId disagreeing with its unitId, an
underived transfer unitId, a source path outside `wiki/`, two units sharing one
unitId, a metadata unitDigest that does not cover the content) each rejected on
their own rule after the envelope digest is recomputed so the whole transaction
stays byte-identical, identical re-import as a revision-preserving no-op, changed
source advancing the same ID append-only, cross-project ID isolation, an
unrelated existing record on a pinned ID conflicting rather than being
overwritten, rejected malformed or digest-stale snapshots writing nothing
(including a recomputed envelope digest whose edited unit must still roll the
whole transaction back), and the pinned CLI
end to end in a throwaway Git repository: only the blob at the exact commit is
read (a dirty working tree and a later commit are ignored), only `wiki/` and the
MIT `LICENSE` are read, the envelope carries a structured MIT license provenance
(`spdx`/`path`/`copyright` validated separately from the committed `LICENSE` blob
text, which must be carried verbatim rather than summarized or substituted), the
source repository and its Git config are left
untouched, an existing output file is never overwritten, a missing, foreign or
malformed pin fails without output, no live Runtime storage or side file is
created, the optional reviews file is honoured, and the resulting envelope
applies through the production import path.

`kernel-wiki-runtime-test.mjs` registers its isolated Project through the
production `createProject` API on a legal seed state (the seed state owns no
Project registry) and runs a real isolated Runtime child (temporary
`OPERATOR_DATA_DIR`/`OPERATOR_RUNTIME_DIR`, hardware disabled, local C500 mocked,
auto-tick off) to drive the production HTTP import route: create once, identical
re-import as a no-op that reports the unchanged unit without rewriting the store
file or advancing the repository revision, a changed page advancing the same
stable ID append-only, the payload carrying the apply result (`created`/
`updated`/`unchanged`) with no `changed` wrapper, list/get showing
non-publishable imported records, no write on GET, no side-index file, unknown
Project, forged body key, tampered envelope digest, an oversized body refused by
the retained request bound, and Runtime state never mutated. It then composes the
production prepare path (round-experience service + real repository + D selection
+ the real Agent command `runs.prepare`) with the production formatter and prompt
builder: the D policy version is recorded in the audit with explicit, well-formed
features, no invented numeric bottleneck, measured (not estimated) rendered bytes
inside the soft budget, same-round freeze across a retry (no reselection and no
restamping of the legacy policy version) and reselection in a fresh logical round,
complete mandatory round facts in the FINAL assembled prompt even when the
selection is empty (the formatter's always-present untrusted block then renders
zero items, and the mandatory facts stay outside it), a mandatory fact never
moving inside that block, an infrastructure failure never becoming an operator
symptom, backend-as-hardware rejected with `ROUND_EXPERIENCE_TARGET_INVALID`, a
retrieve-only legacy port still preparing without additional arguments, and a
selection error blocking the dependent Agent start instead of silently injecting
no knowledge. Two further prepare scenarios pin the committed-fact rules: the
newest committed same-Mission run history wins over a stale `iterationStats`
snapshot, freshness there only orders features of the same kind — the freshest
one must come first inside its kind and each kind stays capped, while an older
committed same-Mission fact may legally remain — and foreign-Mission,
foreign-Project and identity-less facts (even newer ones) never become selection
features. The committed `iterationStats` snapshot itself is produced by a run
that really exists in the newest-first archive, so the mandatory `run-previous`
round fact still names a committed run.

The repeat scenario is built from real transactions instead of a hand-written
attempt: both observations are written through the real repository, the previous
logical round's frozen context is produced by the real retrieval (and is asserted
to contain both records before any demotion is claimed), the current round id
differs so `prepare` runs a fresh selection, the already-finished `run-old`/
`candidate-old` attempt sits in the newest-first run history and the live
benchmark carries the current `run-new`/`candidate-new` attempt. An exact
completed attempt then demotes only the one experience record bound to its own
modification+parameters+conditions — identical four digests and execution
conditions with a different candidate/run still counts as the same attempt and is
audited with the `repeated-attempt` reason on that record alone — while a changed
digest, a changed execution condition, a missing candidate/run id or a
running/idle attempt claims no repeat and changes nothing; the control record and
an identical-digest record bound to another Mission are never demoted, and an
ordering assertion is only made where the records really share a tier. No model,
provider, network, Python or GPU process is started.

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
