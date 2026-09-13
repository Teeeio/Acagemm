# Local shared GPU runner

`local-shared-gpu-runner.py` is the MVP NVIDIA adapter. It reuses the existing
Correctness/Benchmark contract and process supervisor while replacing the C550
probe with `nvidia-smi` and CUDA event timing. It requires a CUDA-enabled Python
runtime (the repository setup uses `.gpu-venv`) and executes the candidate and
independent oracle from the task-owned directory. `nvcc` is only required when
the selected language adapter needs CUDA compilation; Python/Torch execution
can use a driver-visible GPU without a compiler installation.

The adapter is selected by `OPERATOR_TEST_BACKEND=local-shared-gpu` and can be
used through the existing `local-c500-service-client` queue port. It does not
create a second scheduler. `OPERATOR_GPU_PYTHON` can point to another CUDA
Python installation on the same drive. Without that override, the runtime picks
`.gpu-venv/bin/python` on Linux/POSIX or `.gpu-venv/Scripts/python.exe` on
Windows, then falls back to `python3` or `python` from `PATH` respectively.
On WSL, set `OPERATOR_GPU_NVIDIA_SMI=/usr/lib/wsl/lib/nvidia-smi` when that
directory is not already on `PATH`. The production Python adapter passes
`requireCudaToolkit=false`; compile-time adapters should opt into the stricter
probe with `OPERATOR_GPU_REQUIRE_NVCC=1`.

This is a shared, non-isolated development backend. Package admission must
declare `isolation.kind=shared-host-gpu`, `policy.allowSharedHostGpu=true`, and
`policy.packageBoundary=adapter-enforced`. Results carry
`source=local-shared-gpu`, `executionMode=gpu`, and `publishable=false`; they do
not satisfy a formal C550/C550 publication Gate. Cancellation and terminal
resource release still use the existing durable supervisor.

The adapter derives the execution target from the driver instead of hardcoding
it. `_probe_nvidia` queries `name,driver_version,memory.total` and separately
runs the optional `--query-gpu=compute_cap` probe implemented by
`_resolve_architecture`, which reports `sm86` for `compute_cap=8.6`. The
architecture is **never inferred from the device name**: when the driver does
not expose `compute_cap`, or returns an empty, non-numeric or non-`major.minor`
value, the architecture stays undeclared and `architectureNote` records why.
Normalization keeps the authoritative probe under `environment.targetProbe` and
derives two independent scope dimensions from it: `hardware` remains the vendor
category `nvidia-gpu` while `architecture`, `device` and `driverVersion` are
copied when resolved. `experienceEvidence` receives `architecture` only when the
driver confirmed one. `publishable` stays `false`.

Optional diagnostics reuse the base runner's collection path and follow
`tools/local-c500-runner.md`. `OPERATOR_DIAGNOSTICS_MODE` defaults to
`unavailable`: a real mcTracer/mcProfiler command or binary is still invoked
when present, a missing tool is reported as `unavailable`, and explicit `mock`
mode only ever emits `status=mocked` / `source=mock` / `simulated=true` without
executing anything. The projected binding carries the queue run identity from
`task.payload.requestId` (never the backend `taskId`) and leaves unknown
observations `null`; a record without a source is conservatively `unknown` and
mock/simulated provenance always wins over a contradictory `completed` status.
Diagnostics are never derived from benchmark timings.

The runner requires a distinct prepared oracle file and writes a structured
`status=failed` result (including phase, role, and error code) even when
preflight or module loading fails before normal artifacts exist. This keeps
queue polling finite and diagnosable. Candidate code may import modules from
the prepared package root; it cannot resolve host paths.

## Failed result normalization

Normalization never downgrades a real typed failure. It adds
`schemaVersion=operator-studio.shared-gpu-result/v1`, forces
`publishable=false`, and rewrites `result.json` atomically (temporary file +
`os.replace`). A base correctness failure whose typed `failure` has
`phase=correctness` and `role=candidate` is preserved verbatim, including its
attempted `caseResults` prefix, counts and real error strings; it is never
replaced by a generic `not_run` record. That preservation covers every base
correctness stage: a throwing oracle input generation (`role=oracle`), a
candidate output shape/type error or candidate `run` throw (`role=candidate`),
and a reference-cache failure (`role=backend`) each keep the real earlier passed
cases instead of collapsing to `not_run`. Metrics that were never computed stay
`null`. Any stale `result.json` already in the task directory is dropped before
the run, so a preflight, probe or backend failure can never be masked by a
previous successful result.

`environment.targetProbe` keeps the authoritative driver probe. `hardware`
stays the vendor category `nvidia-gpu`, while `architecture`, `device` and
`driverVersion` are copied only when the driver confirmed them. Without a real
probe (preflight/probe failure) `liveHardware=false`, `targetProbe=null` and no
GPU identity is claimed.

`experienceEvidence` compatibility for successful executions is unchanged. A
failed `experienceEvidence` is attached only for a genuine candidate
correctness failure — `status=failed`, `benchmark=[]`, a real probe, and a typed
`OPERATOR_CORRECTNESS_MISMATCH` / `OPERATOR_CANDIDATE_EXCEPTION` at
`phase=correctness`, `role=candidate` with a consistent attempted prefix — and
is bound from `payload.requestId`, `payload.missionId`, `payload.candidate`
and the admitted package digests, never from a backend task id or active state.
Oracle, probe, preflight and benchmark failures carry no eligible failed
operator observation.

Run the real smoke and production queue checks with:

```powershell
npm run e2e:shared-gpu
npm run e2e:shared-gpu-service
```

The checks are opt-in and are not part of hardware-free release verification.
