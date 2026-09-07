# Strict Local CPU Runner

## Purpose and boundary

The Python adapter executes real CPU correctness and latency measurements for
non-fixed operators. It implements no Mission workflow, queue, package builder,
dependency installer, Gate or publication policy. Evidence is always
source=cpu-e2e and liveHardware=false; it cannot establish C550 correctness or
performance. Fixed tensor/dtype/cosine contracts require another adapter.

The caller owns the language-neutral layered package, locked environment,
dependency closure, reference/system-interface allowlists, validation receipt
and preflight-before-submit admission. This runner is not an isolation sandbox
and does not independently implement those package policies.

## Invocation and input contract

Run python tools/local-cpu-runner.py with:

- OPERATOR_LOCAL_C500_TASK_DIR: existing directory containing task.json.
- OPERATOR_LOCAL_C500_RUN_PY: candidate Python file.
- OPERATOR_LOCAL_C500_ORACLE_RUN_PY: independent oracle Python file, mandatory
  for baseline and candidate tasks. Same paths, symlinks resolving to the same
  file and hard links are rejected. Baseline may use a separate frozen copy of
  its trusted source; candidate-owned reference functions never become authority.
- OPERATOR_LOCAL_C500_RESULT_JSON: result destination in the execution directory.

No OPERATOR_CPU_PACKAGE_ROOT/OPERATOR_CPU_ENVIRONMENT_ROOTS protocol is introduced
here. The calling package/environment adapter controls module visibility.

Candidate requires only callable run(inputs). Extra reference/get_inputs/case
providers remain compatible but are never used. Oracle requires callable
reference(inputs), get_test_cases() and get_benchmark_inputs(); get_inputs() is
not a fallback. Oracle records are validated before candidate module loading.

task.json retains matrix, hardware, metric, candidate.digest and runPySource.
matrix.environments and optional hardware must select exactly ["CPU"].
matrix.testSpec must use operator-studio.test-spec/v1 and explicitly contain:

- correctness.requestedCases: positive integer; requiredCategories: unique,
  non-empty string list; atol/rtol: finite non-negative numbers, including zero.
  requireNamedCases cannot disable naming.
- benchmark.requiredProfiles: unique, non-empty string list; primaryProfile:
  one of those names; warmup: integer >= 0; repeats: integer >= 1.
- Supplied matrix.correctnessCases/warmup/repeats must equal those frozen values.
  The runner rejects conflicts rather than normalizing them.

Correctness providers return exactly requestedCases concrete list/tuple records.
Every record needs a unique trimmed name, a category, and exactly one of inputs
or callable make_inputs. Every required category must occur. Benchmark providers
return the exact required profile set, with primary first and no duplicates,
omissions or extras. Factories are materialized once; records are never repeated
or synthesized to satisfy counts.

## Value and measurement semantics

Inputs/results support built-in None, bool, int, finite float, str, list, tuple
and dict recursively. Cycles, custom objects, ndarray/tensor values and
non-finite numbers are rejected; no optional library is imported or installed.
Types must match exactly, including list/tuple, bool/int and int/float.
Integer/discrete values compare exactly; floats use math.isclose with the
declared tolerances. Tensor dtypeTolerance/requireCosDiffBelow are explicitly
unsupported, never silently discarded.

Oracle and candidate receive separate deep copies. Typed snapshots detect input
mutation; outputs must be finite and structurally correct. All declared
correctness cases settle, including cases after an earlier candidate exception.
Benchmark validates every warmup/sample against the oracle and checks mutation.
Only run(inputs) time is measured; cloning/checking is outside the timer.
All benchmark profiles must succeed before timing rows are emitted.

## Results, errors and effects

The runner atomically replaces each of runner-status.json, correctness.json and
the configured result file. These writes are not a cross-file transaction;
the calling queue retains terminal-state atomicity and serialization.

Result schema operator-studio.cpu-result/v2 retains benchmark[], environment,
tracer and profiler, and adds status, correctness, error and provenance flags.
Success exits 0. Failure exits 1 and writes error fields code, message, category,
phase, role, retryable and details. Preflight rejection records correctness as
status=not_run, passed=null, executedCases=0. Executed correctness preserves
passed/total/passedCases/failedCase/failedCaseName/error/caseResults and adds
executedCases, failedCases and structured failure. passedCases counts actual
passing cases, not the index of the first failure.

Contract failures use CPU_TEST_SPEC_INVALID/CONFLICT/UNSUPPORTED,
CPU_ORACLE_REQUIRED/INVALID, CPU_MODULE_INVALID and
CPU_CASE_CONTRACT_INVALID/CPU_BENCHMARK_CONTRACT_INVALID. They are preflight
validation failures. CPU_CANDIDATE_EXCEPTION, CPU_CORRECTNESS_MISMATCH,
CPU_RESULT_TYPE_MISMATCH/SHAPE_MISMATCH, CPU_INPUT_MUTATED and
CPU_VALUE_NON_FINITE/INVALID/TYPE_UNSUPPORTED identify phase and responsible
role. Candidate kernel exceptions stay validation failures; oracle failures
identify role=oracle. Missing imports are dependency errors. Unexpected runner
or clock errors are internal. All currently emit retryable=false; outer timeout
and cancellation classification belongs to the caller.

Environment retains candidateDigest and adds actual candidateRunPyDigest,
oracleRunPyDigest and taskContentDigest (SHA-256 of executed files/task bytes).
These observations do not replace the caller's package validation receipt.
Profiler/tracer remain unavailable and simulated=true with empty metrics/events;
benchmark latency is not fabricated into profiler evidence.

The adapter disables Python bytecode cache writes. It loads the supplied Python
code and therefore relies on caller admission/isolation. CPU execution limits
and process-tree cancellation are enforced by the caller; forced termination
may leave progress/correctness artifacts without a final result.

## Verification and compatibility

Run node tests/local-cpu-runner-test.mjs; OPERATOR_CPU_PYTHON optionally selects
the test interpreter. Tests use real bounded CPU subprocesses, isolated temporary
directories and finally cleanup. No Agent, GPU, profiler or tracer executes.
The legacy CPU E2E fixtures must provide complete matching specs and explicit
oracle transport. Real-Agent E2E remains an opt-in manual test.
