# MetaX C500 runner contract

`runner.py` is the C500-only execution adapter. It reuses `tools/local-c500-runner.py`
by importing its correctness, shape/dtype, prefix, reference-cache, settlement,
diagnostic projection and atomic-result engine. The legacy source is unchanged;
these helper calls are an explicitly documented adapter dependency. It does not
implement a separate Mission, queue, Gate or iteration workflow.

Modes: `--stage probe` returns observed Linux/SMI/MetaX Torch/MACA/driver versions and
checks Event/record/synchronize/elapsed_time. `--stage prepare-package` loads the
frozen independent Oracle and candidate and invokes one Oracle-owned benchmark input
to force lazy build/load. It issues no correctness verdict and no release receipt.
Normal `run` uses the existing owned-task environment variables and base full runner.

Required normal-task inputs:
- `OPERATOR_LOCAL_C500_TASK_DIR`: owned task root with immutable `task.json`.
- candidate `--run-py` or `OPERATOR_LOCAL_C500_RUN_PY`; independent
  `OPERATOR_LOCAL_C500_ORACLE_RUN_PY`; result via `--result-json` or existing result
  environment variable, strictly inside the task root.
- optional `OPERATOR_PREPARED_PACKAGE_ROOT` for nested immutable package entrypoints.
- `--versions-json` or `OPERATOR_METAX_C500_VERSIONS_JSON`: exact actual-image pins.
- `--mx-smi` (otherwise PATH lookup); compiler via `--compiler` or
  `OPERATOR_METAX_C500_COMPILER`, configured explicitly when native source is used.
- task `hardware` and `matrix.environments` both exactly `['C500']`.
  Existing payload/matrix testSpec, candidate/package/acceptance bindings are retained.
  Staged run.py/oracle.py bytes must match the frozen payload when it supplies them.
- `payload.candidateNativeSources` is derived by the trusted host from candidate-layer
  manifest paths. Legacy tasks without roles conservatively scan native source.
  Entrypoints and native source paths must stay inside the owned package root.

No missing Oracle fallback, device-name default, CPU clock, NVIDIA/MUSA substitution,
invented SDK version or old result replay is allowed. A successful probe precedes
candidate imports. Results use `operator-studio.metax-c500-result/v1`, source
`metax-c500`, hardware `C500`, independent oracleDigest and `publishable=false`.
Failed preflight/candidate/Oracle/build/benchmark produces typed failure, real
correctness coverage when attempted, and an empty graded benchmark list. Existing
terminal result bytes are preserved on replay. The process owner decides release.

Benchmark warmup/repeats are invocation counts. One synchronized device Event pair
measures each call; elapsed milliseconds are converted to microseconds. Samples
records the actual number in the final full settlement; total invocation counts
and settlement count are retained separately. The original 2% / bounded settlement
policy is reused without weaker probes. Inputs must contain device tensors;
CPU/foreign output tensors are rejected. Candidate kernels on other streams must
join the measured current stream. The target fork's stream/timer behavior requires
real-machine acceptance; interface preflight alone cannot prove timing accuracy.
Triton is not required for a Python/Event runner, but a Triton candidate must have
its actual fork in the pinned environment.

Native compilation remains candidate-owned. The adapter observes successful
MetaX-compatible `torch.utils.cpp_extension.load/load_inline` calls made by the
candidate, hashes loaded extension files inside its owned package, and rejects pure
PyTorch fallback. Oracle loads do not count. An unrecognized native loader (including
a CMake-only flow without a trusted load witness) is explicitly unsupported.
Optional C500 tracer/profiler compatibility is unverified and reported unavailable;
legacy C550 diagnostic commands are not silently launched for this target.

API semantics checked against [Triton do_bench](https://triton-lang.org/main/python-api/generated/triton.testing.do_bench.html)
(rep/warmup are milliseconds) and [PyTorch Event](https://docs.pytorch.org/docs/2.14/generated/torch.cuda.Event.html)
(Event duration is milliseconds). These upstream documents do not establish MetaX
fork compatibility. The MetaX official home/developer endpoints timed out during
the 2026-10-10 check; C500 supported-version declarations remain empty pending actual
vendor documentation/image and real-machine verification. No C550 version or
measurement is copied into C500.

Local CPU command: `python -B tests/metax-c500/runner-test.py`.
Production ports and integration guide: `client-runtime/metax-c500/README.md`.
