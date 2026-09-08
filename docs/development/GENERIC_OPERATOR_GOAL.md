# Generic Operator Iteration Goal

## Consensus (2026-09-07, resumed after explicit user confirmation)

- Deliver a real Codex + local test iteration path for non-preset operators;
  the MVP prefers the available local shared GPU when its language/runtime
  adapter is installed, and keeps CPU as a deterministic fallback.
- The application calls one asynchronous test tool; local and future remote
  queues implement its backend contract. Do not introduce another scheduler.
- A submission is an immutable layered execution package: candidate source and
  resources, direct/transitive offline dependencies, a precisely identified
  runtime/toolchain layer, and a separate frozen acceptance package.
- Allowed references are package contents, locked environment layers, and
  explicitly admitted platform interfaces. No implicit developer-host files or
  runtime network dependency installation.
- Package validation and target-environment preparation precede formal test
  submission. Admission records bind all content, environment, build settings,
  target, and validator policy; recheck before execution.
- Top-level contracts are language-neutral. Python/CPU is the first adapter;
  run.py is not a universal language requirement.
- Real Correctness and Benchmark are required. Profiler/Tracer are explicitly
  unavailable or mock and cannot fabricate diagnostic conclusions.
- Human guidance and execution observations are versioned, scoped, auditable,
  and reusable across admitted Missions. They do not authorize GPU publication.
- Shared-host GPU execution is an explicit development policy, not an isolation
  boundary. It requires a trusted environment declaration and adapter-enforced
  package boundaries; its observations remain non-publishable until a formal
  hardware Gate accepts them.

## Preserved invariants

- Fixed Profile authority, matrices, shape/dtype, cases and retry budgets.
- Candidate/Workspace/package/acceptance/environment evidence binding.
- Independent oracle; no Candidate self-validation or duplicated case padding.
- Serialized tests and atomically persisted terminal outcomes.
- One production API/application/workflow path; GET/SSE are read-only.
- Agent writes only in the active isolated Mission Workspace.
- CPU-E2E/simulation evidence never becomes publishable live GPU evidence.
- Existing uncommitted changes and unrelated temporary JSON files are preserved.
- No Git commit, global Agent configuration change, secrets in reports, actual
  cloud service connection, or real profiler/tracer collection. A shared local
  GPU may be used for MVP development, but its evidence is explicitly marked
  non-publishable.

## Work packages and verification

| ID | Requirement / implementation boundary | Machine verification |
|---|---|---|
| T1 | Language-neutral package, environment, admission, request/result and test-tool contracts | alternate backend/adapter, invalid capabilities and content conflicts |
| T2 | Immutable package assembly and bounded target preparation | missing/transitive dependencies, path escapes, hashes, stale admission and isolated imports |
| T3 | Local queue + strict CPU adapter | actual Python subprocess, independent oracle, exact cases/profiles/tolerances, unavailable diagnostics |
| T4 | Non-preset Mission API/TUI and automatic iteration | at least three operator families; no per-operator workflow branches; source/operator/hardware preserved |
| T5 | Bounded I/O, preparation, queue/round budgets, cancellation and recovery | stalled backend still permits query/stop; duplicate submission, restart, uncertain cancellation and corrupt results |
| T6 | Experience repository, services and round integration | versions, project scope, human guidance, evidence idempotency, cross-Mission retrieval and provenance |
| T7 | Real Codex E2E, regressions and contracts | actual patches/CPU results; adoption, rollback, continued rounds and budget terminal outcomes; full gates |

## Execution roles and file ownership

- Main: test tool/package/admission, local adapter integration, generic Mission
  entry, application wiring, harness integration, shared docs and release gates.
- CPU verifier/executor: tools/local-cpu-runner.py and its dedicated tests/contract.
- Experience executor: new experience contract/repository/service and tests.
- Independent critic: read-only liveness and generic-path evidence, then bounded
  assigned fixes only after explicit ownership is agreed.

## Decisions and rejected paths

- No client-provided validated=true admission; validation has a trusted issuer
  and content/environment identity.
- No long synchronous execute() hidden behind a state lock; query is read-only.
- No Promise.race-only timeout that silently abandons running side effects.
- No copying arbitrary host virtualenvs or online installation during tests.
- No weakening tests to make an optimization succeed; lack of speedup is a valid
  iteration outcome, not proof the workflow is broken.
- Cached dependencies/builds are not evidence of a new benchmark measurement.
- Full environment-build platforms, registries, multi-tenant scheduling and
  major GUI work are deferred. The first native local-GPU adapter is in scope;
  cloud and other accelerator adapters continue to use the same tool contract.

## Trace and current state

- Before pause: only read-only investigation and interface proposals; workers
  confirmed no implementation files or live subprocesses were left running.
- User refined the dependency/validation/multi-language contract and explicitly
  requested resumption. This record supplements the original Goal objective.
- Current stage: foundation implementation and full regressions have passed;
  the package store now accepts an explicitly trusted shared-host-GPU policy;
  production package acceptance still awaits the native adapter, package/tool
  wiring and generic-entry integration.
- Addressed in focused tests: slow request bodies outside the state lock; bounded
  transport/queue calls; durable execution claims and cancellation; strict CPU
  oracle/cases/profiles; generic Mission operator/hardware retention; complete
  round budget and resource barriers before new dispatch/adoption.
- Remaining risk/boundary: the new test tool/admission store is not yet the
  production execution path. Generic TUI import and real isolated-package/Codex
  acceptance still require implementation and verification.
- Local Codex CLI was detected and reported logged in during planning. Live
  sessions must be isolated and
  bounded; initial E2E batch is three CPU Missions with at most two candidate
  rounds each, finite per-run/Mission limits and an outer harness deadline.
- Every new probe records stage, inputs, expected/actual outcome and artifact path.
- Final gates: npm run verify:local-c500-release and
  npm run verify:non-hardware-robustness, plus the separately authorized real
  Codex CPU harness. Completion is not inferred from partial module passes.
- Reopen consensus only for an actual invariant/authority conflict, not ordinary
  implementation difficulty. Preserve prior work when a local fix is revised.

## Implementation checkpoint (2026-09-07, UTC+8)

This checkpoint records the shared-GPU package path; it is NOT completion of the generic-operator Goal.

| Requirement | Implemented / verified foundation | Still required for product acceptance |
|---|---|---|
| T1-T2 | Language-neutral layered manifests; actual blob/hash/path checks; private CAS; trusted, expiring admission; bounded preparation and restart quarantine; interchangeable tool backend contracts; explicit shared-host-GPU policy | Strong OS isolation and additional language adapters |
| T3 | Strict CPU runner with independent oracle, exact cases/profiles/tolerances; local serialized queue with durable supervisor ownership and atomic terminal outcomes; shared-GPU package adapter validates Python sources and executes only prepared package files | Execute closed packages through an isolated adapter when available, including native/offline transitive dependencies |
| T4 | Generic Mission operator/hardware retained; fixed Profile identity takes precedence; CPU provenance cannot become live GPU evidence | Formal generic TUI/API package import and at least three non-preset operator families through the complete workflow |
| T5 | Bounded HTTP bodies/transport; lock-free committed GET/SSE; nonblocking queue dispatch; safe idempotency/restart/cancellation; whole-pipeline guards; 15-minute round clock shared by retries and pause/resume | Integrated fault injection against the real package execution backend; unknown provider start effects still require explicit inspection rather than blind replay |
| T6 | Versioned human guidance API, immutable history, scoped per-round context, validated prompt injection, terminal collection hook and observable failures; shared-GPU admission/artifact receipt verifier wired in production composition | Legacy evidence is deliberately skipped, not synthesized |
| T7 | Focused module and fake-provider/real-CPU/shared-GPU probes; final release 120 checks and non-hardware 28 checks PASS | The separately authorized real Codex + isolated CPU batch and complete product acceptance |

Production human experience API:

- GET/POST /api/projects/:projectId/experiences
- GET/PATCH /api/projects/:projectId/experiences/:id; GET accepts version, PATCH requires expectedVersion.
- Only existing local Projects; no caller-granted cross-project whitelist or public observation write endpoint.
- Store: configured runtimeDir/experiences, outside Agent Mission Workspaces.
- Human guidance remains unverified advice; all observations remain non-publishable.
- Both initial journaled run and automatic rounds freeze context and round identity.
  Replay/same-round repairs preserve the original versions and wall-clock deadline.
- Terminal collection reports skipped when package bindings or trusted receipts are absent.
  The current composition root explicitly returns EXECUTION_PACKAGE_EVIDENCE_UNAVAILABLE
  for uninstalled package verification, never verified=true from a worker assertion.

Runtime contract is now version 9; existing older processes must be restarted by
the normal launcher compatibility path. This development run did not restart any
user-owned production process or change the persistent state schema.

### Failure-first findings repaired

- Baseline completion could erase the identity of an Agent still being cancelled;
  the owner is now preserved until the matching provider confirms release.
- A legacy terminal label without resource proof could strand or falsely clear an
  outstanding test resource; unconfirmed owners remain observable and quarantined.
- Pipeline maintenance/adoption and queue starts could run before the final budget
  check; the shared canStartNewWork guard now covers the entire pipeline.
- A partial HTTP body could retain the state lock; parsing occurs before the lock,
  and GET/SSE observe atomic committed state without waiting for mutations.
- Generic diagnostic retries incremented old counters and could renew the round
  clock; the active budget identity now survives those retries without changing
  existing fixed matrices or retry/counter semantics.
- An outer experience collection deadline did not reach a slow inner verifier;
  combined cancellation now prevents any new repository write after that deadline.
- A submit HTTP error alone was previously treated as proof of no execution;
  retry now requires matching not_started AND confirmed resource release.

- The HTTP mock used the task deadline as its simulated runtime, guaranteeing a
  timeout once the queue began enforcing deadlines. Mock duration now has an
  independent bounded process setting; the original 1-second journal/smoke task
  limits remain unchanged. The mock contract and journal regression pass.

- A published/reverted Mission could have a completed clock before the legacy
  evidence counter advanced, rejecting a valid manual new run. Explicit manual
  admission now allocates a monotonic identity without changing evidence, retry
  or Mission-budget counters. A subsequent unmet-Gate automatic round uses the
  exact completed-round identity only after resolved, correctness-passed evidence
  has been counted. Normal/research-injected continuation passes for both generic
  and fixed-Profile Missions. Same-round retries, wrong identities, expired active
  intents and replay do not renew the deadline. The real API smoke now verifies
  active new budget and matching experience context after publication/reversion.

- Independent review found fixed-Profile manual runs use a separate arming
  branch, not the ordinary journaled runs plan. Run Service now checks canonical
  guards before acknowledging armed, rejects exhausted performance/generation/
  correctness limits with HTTP 409 and an explicit nextAction, and freezes an
  allowed new budget through its injected clock. Repeated arming, repair and a
  preflight crossing the deadline cannot refresh it. Route/RunService/Fixed
  Autopilot/AgentRound integration uses real application modules with effect-port
  doubles; it does not claim real network, model or GPU execution. No Autopilot
  restart permission or fixed-limit reset was added.

### Environment dependency / authority boundary

Read-only command discovery on 2026-09-07 found Python 3.12.2 at
F:/Python312/python.exe but no docker, podman or nerdctl command and no registered
WSL distribution in the current-user registry. No usable OS-isolated execution
environment has been supplied. An attempted WSL listing was not executed because
approval review timed out; no installer, OS feature, VM or cloud service was started.
The user has since authorized the local shared-GPU MVP policy, so OS isolation is
no longer a prerequisite for development; the native adapter must still enforce
package-only paths and record the weaker boundary explicitly.

Static import checks and an ordinary Python subprocess cannot enforce a strong
package-only execution boundary. The package store therefore admits only the
explicit `shared-host-gpu` policy for the MVP, with
`policy.packageBoundary=adapter-enforced`; ordinary non-GPU host execution remains
rejected. Real native GPU acceptance has now been launched. The retained affine
run completed one Codex-generated candidate through the production path: real
workspace Diff, shared-GPU package admission, 4/4 correctness, primary/small
benchmark profiles, and one trusted non-publishable experience record. A later
multi-family run was quarantined when Codex process-tree release could not be
confirmed; no evidence was published.

A native local-GPU adapter, package-only preparation, trusted receipt verifier,
and production queue wiring are now implemented. The adapter uses the
explicitly approved shared-host GPU policy (no OS isolation claim), keeps all
artifacts under the prepared package, and marks observations non-publishable.
Generic Mission import validation is also available for Python/Triton/CUDA/
MXMACA aliases and rejects unregistered projects, missing entrypoints, unsafe
paths, and incomplete baselines. The real CUDA runner and production service
E2E pass; the generic Mission acceptance driver is retained at
`scripts/e2e-shared-gpu-agent-iteration.mjs`.

The shared-GPU real-Agent harness now explicitly passes `--model` through the
Codex adapter and defaults to `gpt-5.6-sol`; `OPERATOR_CODEX_MODEL=gpt-5.5`
is supported for the same cost-conscious path. The affine family completed one
real candidate with 4/4 correctness, both fixed benchmark profiles, package /
admission / candidate binding, confirmed release, and one trusted
non-publishable experience record. The reduction family reached an in-progress
Codex file edit, then its bounded Agent budget requested cancellation. Windows
process-tree release could not be verified, so the run remains quarantined and
no candidate/evidence was accepted. This is a safe failure, not an iteration
completion.

The remaining acceptance dependency is the reduction/normalization portion of
the real local Codex session plus fault injection. The run is deliberately
bounded: network reconnects and unconfirmed process-tree release become an
explicit `needs_human`/quarantine state rather than a fake completion. Do not
substitute contract doubles, the CPU fixture, or a fabricated candidate for
this gate.

## Final regression evidence (2026-09-07, UTC+8)

The final command returned exit code 0 after the fixed manual-admission repair.
The observed verification window is recorded in the machine-readable report.

| Verification | Result |
|---|---|
| npm run verify:local-c500-release | PASS, 120 checks; executed inside the umbrella gate |
| npm run verify:non-hardware-robustness | PASS, 28 checks without physical hardware |
| node tests/local-cpu-runner-test.mjs | PASS, 63 tests, 0 failures; actual Python |
| node test-service/contract-test.mjs | PASS, independent mock duration/deadline and invalid configuration checks |
| git diff --check | PASS; existing unrelated changes preserved |

Retained artifacts:

- [Machine-readable verification summary](GENERIC_OPERATOR_VERIFICATION.json):
  exit code, every check name, source limitations, CPU result and console SHA-256.
- [Complete verification console transcript](GENERIC_OPERATOR_VERIFICATION.log.txt):
  normalized line endings, including build output, CPU results and terminal PASS markers.

CPU fixture Mission: MIS_MTQB6E5D; Candidate: candidate-02.
The tested Candidate digest matched its Mission Workspace. Its one exact
small-vector case passed with atol=0 and rtol=0; Gate returned adopt. This was
Reference Fixture generation plus real Python, source=cpu-e2e and
liveHardware=false. Shared-GPU service E2E also completed package assembly,
admission verification, prepared-artifact checks, real CUDA correctness and
benchmark; its evidence is explicitly non-publishable. The retained real Codex
affine run additionally completed one candidate and recorded trusted
non-publishable experience. It is not yet a complete three-family real Codex
acceptance run and does not verify OS isolation. The harness
cleaned its temporary Runtime/Workspace in finally; the console and summary,
not those temporary workspaces, are retained here.

Loop status: continue, NOT Goal completion.
The next implementation sequence is: reduction/normalization real Codex
acceptance -> integrated fault injection. Shared-GPU
trusted experience receipts, generic import, package validation, queue terminal
states and cancellation barriers are wired; do not substitute contract doubles
or the legacy CPU fixture for the remaining acceptance conditions.
