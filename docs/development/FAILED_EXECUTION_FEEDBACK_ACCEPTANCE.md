# Failed execution feedback acceptance (2026-09-13)

Owner: upstream. Frozen implementation and independent-test contract for the
real shared-GPU failure found in the 20-run batch at commit 6cc556a.
This document does not change fixed Profile matrices, tolerances, retry budgets,
adoption/publication policy, or the response-model/N20 contract.

## One implementation route

Preserve typed correctness failures in the existing Python base runner and
shared-GPU normalizer; admit only independently bound failed candidate observations
in the existing shared-GPU experience verifier; project their top-level
correctness into archived round facts. Keep the production path:
queue -> benchmark projection -> round experience collection -> round archive ->
existing next-round prompt/audit. No alternate workflow, parser for stderr,
historical backfill, new dependency or extra agent architecture.

Producer: tools/local-c500-runner.py and tools/local-shared-gpu-runner.py.
Consumer: client-runtime/application/shared-gpu-experience-verifier.mjs and
client-runtime/mission-project-state.mjs. The existing round-experience service
already collects failed terminal states and incorporates the verifier proof.summary
into experience content: use that interface rather than changing the experience DTO.
If a required change exceeds these implementation scopes, return a decision_request
with the concrete conflict and preserve the partial result.

## Result contract and identity

Use the existing shared-GPU result envelope (schemaVersion
operator-studio.shared-gpu-result/v1 for this adapter). A failed execution has
status=failed, benchmark=[], publishable=false, top-level correctness, error,
environment, and the existing executionPackage binding when provided by the task.
Failure exit code remains nonzero. Never serialize a failed correctness as a
successful benchmark row to satisfy an existing reader.

Correctness keeps existing fields and adds explicit status and executedCases:
- status=passed|failed|not_run; passed=true|false|null respectively.
- total is the frozen requested case count, never lowered to executedCases.
- executedCases counts attempted named cases; passedCases counts passed cases.
- caseResults is the actual attempted prefix (retain early-stop behavior);
  failedCase is one-based; failedCaseName/failedCaseCategory identify the real case.
- Keep existing real numeric diagnostics, case names, dtype and error. A metric
  not computed when candidate/oracle throws is null/absent, never a fabricated 0.
- Each failed case includes error and failure; correctness.failure and result.error
  carry the same typed first failure. Preserve preceding successful cases.
- No attempted case means not_run, executedCases=0, passedCases=0, caseResults=[].
  If matrix metadata was parsed, keep its requested total even before execution.
  Truly unavailable metadata remains unknown rather than a guessed fixed count.

Error is {code,message,phase,role,retryable,details}; retryable=false for the
deterministic failures in this contract. Freeze these neutral codes for the shared
base correctness path:
- OPERATOR_CORRECTNESS_MISMATCH, phase=correctness, role=candidate: independent
  oracle comparison fails (including output shape/type/numeric/cosine mismatch).
- OPERATOR_CANDIDATE_EXCEPTION, phase=correctness, role=candidate: candidate.run
  throws, e.g. addcmul tensor2 is float. The case was attempted; do not call it not_run.
- OPERATOR_ORACLE_EXCEPTION, phase=correctness, role=oracle: oracle input generation
  or reference throws. Preserve the attempted case and role, but never learn it as
  an operator failure.
Unexpected backend/probe/module/preflight failures retain accurate phase and role
using existing specific SHARED_GPU_* errors or a typed generic backend error.
They must not be relabeled as OPERATOR_CORRECTNESS_MISMATCH.
A benchmark-stage exception preserves any already observed passed correctness and
does not become a correctness mismatch. This round does not add benchmark-failure
experience eligibility.

Write correctness.json and result.json atomically (temporary file + replace).
Shared normalization must also be atomic and preserve an existing typed failure
rather than replace it with generic not_run. No reading unrelated/stale stderr or
result to reconstruct a successful execution; preflight failure must not reuse a
previous result in the same directory.

environment retains the actual successful driver probe (targetProbe, device,
driverVersion, optional architecture) and executionPackage. Missing probe metadata
does not become current-host/default metadata. Never generate a verified GPU
observation from preflight/probe/oracle/backend failure just because backend=gpu.

The existing experienceEvidence keys/schema stay unchanged. For a genuine
candidate correctness failure after actual target probing, attach outcome=failed,
operation=test and the task's existing exact binding:
missionId=payload.missionId; candidateId=payload.candidate.id;
runId=payload.requestId (not backend taskId); patchDigest=payload.candidate.digest;
packageDigest/environmentDigest/acceptanceDigest from admitted payload;
hardware=nvidia-gpu, executionMode=gpu, liveHardware=true, architecture only from
the probe. Missing identity is not filled from active state. executionPackage
retains admissionId/preparedArtifactDigest/workspaceId/target/build/adapter.
Preflight/probe/oracle/backend failures must not produce eligible operator
experience; absence of experienceEvidence is allowed for those failures.

## Trusted failed-observation consumer

Keep the existing successful observation path and its compatibility behavior.
The new failed path is allowed only when ALL checks hold:
1. benchmark purpose=candidate, status=failed, resourceRelease.confirmed=true;
   result.status=failed, result.publishable=false; observation.outcome=failed and
   operation=test; real shared-GPU environment with an actual targetProbe containing
   nonempty deviceName/driverVersion, no mock/simulation/conflicting live flags.
2. correctness.status=failed, passed=false, integer total>=1 and
   1<=executedCases<=total; caseResults.length=executedCases;
   passedCases=executedCases-1; failedCase=executedCases;
   all preceding cases passed=true and final case passed=false with the exact
   failedCaseName. error/correctness.failure/final case failure agree by full value;
   phase=correctness, role=candidate, code is one of the two candidate codes above.
3. Independently read the queue task (readTask is required for this new failed
   path): task.status=failed and release.confirmed=true; queue taskId matches
   benchmark.testTaskId. task.payload.requestId and benchmark.requestId or runId
   identify evidence.runId; every concrete benchmark requestId/runId must agree.
   Queue payload Mission/candidate/digests must agree with evidence and active
   Mission/Workspace/candidate; use existing digest normalization, not ID trimming.
4. Queue result's whole experienceEvidence, correctness and typed error match the
   projected result/observation, not merely worker booleans. Persisted queue
   executionPackage agrees with the selected package binding.
5. Reuse ALL existing Mission/candidate/applied candidate/package/environment/
   acceptance/workspace/admission/prepared-artifact checks and trusted store/adapter
   verification. Unknown, stale, contradictory or unreleased data fails closed.
   No bypass for failed outcomes, no changes to publishability or Gate acceptance.

Proof.summary for a verified failed candidate deterministically contains typed
code, phase/role, failed case name/category, total/executed/passed counts and the
real error (bounded; cap the failure-detail suffix to 2000 characters).
round-experience-service already appends proof.summary to content. That creates a
useful failed observation without changing evidence identity or allowing the
worker to author arbitrary verified advice. Collection of the identical observation
is idempotent (one id/version/evidenceKey); source remains execution and
verification.publishable=false.

Explicit negatives: pass/failed outcome contradiction; wrong Mission/candidate/
request/queue task/package/environment/acceptance/workspace/prepared artifact;
queue vs result error/correctness mismatch; missing readTask; cancelled/running/
quarantined or release missing/false; role=oracle/backend; phase=preflight/benchmark;
not_run; fabricated counts/case prefix; missing real probe; mock/simulation.
These must never create a failed operator experience.

## Round facts and next prompt

For a failed benchmark state, a provided top-level result.correctness is the
authority; use it even when result.benchmark=[] or stale contradictory success
rows exist. Do not manufacture measurements. Map existing round-facts v1 fields:
status, total, failedCase/name/category/error, actual cases and metrics;
environment uses the result source, profile=null and stage=Correctness.
Not_run yields not_observed with no fabricated failed case. Leave the successful
legacy row-based path and its existing schema/semantics unchanged.

Through existing production archive/reset and next-round rendering, the failed
correctness case/code/error and the exact recorded failed experience id/version/
content must be visible in roundFacts/prompt audit. Retry/rollback must not replace
the failed candidate identity with the next candidate. Do not set roundFacts or
iterationContext manually in an integration test.

## Independent acceptance packages

Python: tests/shared-gpu-failure-result-test.py, hardware-free with explicit
torch/CUDA/probe doubles, must drive actual base/shared main entry and real
temporary candidate/oracle files. Cover success; first and later numeric mismatch;
candidate exception; oracle exception; preflight/probe failure; failure after
correctness succeeds; original requested counts; actual typed artifacts/exit codes;
atomic writes and preservation through shared normalization. Fixture-only results
are never live evidence.

Node: tests/failed-execution-feedback-test.mjs, public production boundaries and
injected trusted ports; cover the failed verifier matrix, actual queue snapshot
projection/collection, repository idempotence, production round archive and final
next-round prompt/audit. Test result.benchmark=[] and stale success rows. Include
wrong-identity and infrastructure/oracle negatives that really reach their target
branch. Existing test suites and Profile contract remain read-only.

Test writers emit registration notes in separate
docs/development/failed-execution-{runner,feedback}-test-registration.json files;
they do not edit package.json, gate arrays or tests/README.md. One later writer
registers both. Implementation workers lock the integrated test file hash, treat
it as read-only, and run only their minimal recipe before submission.

The upstream independently runs the targeted packages plus nearest existing
module tests after integration. This is a cross-module change: the project's
existing verify:local-c500-release gate is required, and
verify:non-hardware-robustness is also planned. Do not have every worker run both.
Then freeze a commit/config and perform a real failed-candidate verification and
fresh real affine two-round/N20 batch; family coverage stays separate. Preserve all
original failures/unknowns without replacement or cross-version pooling.

## Stops

Missing critical interface, mismatch to this contract, repeated same failure or
scope expansion -> decision_request(question/reason/evidence); no alternate
architecture, extra agent, new dependency or weaker tests. Estimates are upstream
estimates, not deadlines that kill normal useful work. No live GPU/model calls by
implementation or hardware-free test workers.

