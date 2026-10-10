# Ascend910B execution adapter

This module owns Linux Ascend910B device discovery, prepared Python/TorchNPU
entrypoint loading, NPU event timing and an observed environment manifest. It
does not own the queue, Mission state, fixed Profiles, cancellation, deadlines,
adoption, Gate decisions or publication. Those remain on the existing TUI →
Production API → Client Runtime path. Only this directory is changed by this
work item. `test_runner.py` is the nearest module test.

## Integration contract

Launch `python -I -B tools/ascend910b/runner.py` through the existing local
execution supervisor. Suggested backend/source identifier: `local-ascend910b`.
The integration owner must wire backend selection and immutable package
preparation into the existing `local-c500-service-client` port; this directory
does not itself enable that route or create a scheduler.

The adapter consumes the existing environment variables:

| Input | Contract |
| --- | --- |
| `OPERATOR_LOCAL_C500_TASK_DIR` | Existing task-owned prepared package directory |
| `OPERATOR_LOCAL_C500_RUN_PY` | Prepared candidate entrypoint under that directory |
| `OPERATOR_LOCAL_C500_ORACLE_RUN_PY` | Independent prepared oracle, distinct path and inode |
| `OPERATOR_LOCAL_C500_RESULT_JSON` | Exactly the task directory's `result.json` |
| `OPERATOR_ASCEND_DEVICE_INDEX` | Optional **logical visible** NPU index; absent uses the runtime's current device |
| `OPERATOR_HARDWARE_DISABLED=1` | Reject hardware before importing TorchNPU; never an implicit CPU fallback |

`task.json` carries the unchanged `matrix`, `payload` package/admission/acceptance
digests, candidate binding and optional `runPyDigest`. The adapter reads that
exact file; `OPERATOR_LOCAL_C500_TASK_JSON` is unnecessary. It verifies a supplied
entrypoint digest, compares prepared implementation files with their frozen
payload bytes, and detects candidate/oracle/dependency byte changes during the run.
The package preparer remains responsible for full layer admission and immutable
workspace/package identity. The adapter never manufactures missing digests.

Candidate API: `run(inputs)`. Oracle API: `reference(inputs)`,
`get_test_cases()` and `get_benchmark_inputs()`, with the same named case/profile
contract as the retained runner. The oracle's **reference** is used for baseline
timing, so an optional oracle `run` cannot replace the independent implementation.
Oracle inputs and measured outputs must contain tensors on the selected NPU;
there is no automatic CUDA rewrite, device transfer, shape/dtype reduction or
CPU benchmark. NPU inputs must be supplied by an NPU-aware acceptance package.
Fixed C550 Profiles remain unchanged and are not reinterpreted as 910B Profiles.

Results preserve base `status`, `correctness`, coverage/prefix, typed errors and
benchmark rows, adding `schemaVersion=operator-studio.ascend910b-result/v1`.
`environment.source=local-ascend910b`, `hardware=Ascend910B`, live
`executionMode=npu`, and **`publishable=false`**. CPU injected-runtime results
instead carry `executionMode=simulation`, `simulated=true`, `liveHardware=false`.
There is no simulation CLI or fallback. No `experienceEvidence` is minted here;
integration must explicitly qualify learnable observations using current target
rules. Missing target hardware never produces a live probe.

Atomic outputs under the task root: `result.json`, `correctness.json`,
`environment-manifest.json`, and the base progress record. A failed preflight
still produces a terminal result when a valid task/output root is available.
When the output root itself is absent/unsafe/unwritable, the adapter returns a
nonzero exit and stderr; the existing supervisor must settle that exit receipt.
Resource release is **only** the supervisor's receipt, never this manifest.

## Reused rules and side effects

This is an adapter-level, documented direct load of
`../local-c500-runner.py`: `_run`, `_named_cases`, `_named_benchmark_profiles`,
`_settle_measurements`, `_case_metrics`, `_not_run_correctness`,
`_execution_package`, `_percentile`, and `_write_json_atomic` are reused.
The adapter replaces that isolated module instance's hardware/load/sync/timing/
diagnostic ports only. It neither changes the C500 file nor imports runtime
state. A base contract change requires this suite to be rerun.

Float64 numeric diagnostics and assert-close operate on CPU copies after the
device work, using the **unchanged** base algorithms and tolerances. This avoids
depending on NPU float64 support. Input/output shape, dtype, layout, mutation,
named case count/category and required profile checks remain the base rules.
The observer does not substitute a cheaper matrix or choose another reference.

Timing uses `torch_npu.npu.Event(enable_timing=True)`, records start/end on the
current stream, waits for the end event, and converts elapsed milliseconds to
microseconds. Warmup is followed by device synchronization. Each settlement uses
the declared sample count and the base settling tolerance/cap; nonpositive or
nonfinite event readings fail. Candidates using private streams must join their
work back to the caller stream before returning, as required by event timing.
No wall-clock or CUDA timer fallback exists. Native observation does not prove
which kernel dispatched; hardware kernel-dispatch validation remains necessary.

The process uses the prepared task root as cwd/import root. Temporary, Torch
extension, Ascend operator, XDG and reference caches plus CANN logs/work files are
under `.ascend-cache/`, configured **before** importing or initializing TorchNPU.
Live Linux tasks require CANN-compatible ASCII path components; an incompatible
path fails before import instead of creating a cache elsewhere.
Task-local reference caching adds the observed TorchNPU/CANN/driver probe digest
to its namespace, avoiding reuse under the retained CUDA cache identity. No
installer or shell probe runs. The adapter is for the
existing explicitly authorized shared development boundary, not a Python sandbox:
the supervisor/package policy owns process isolation and allowed writes. It does
not grant candidate access to additional host paths. MetaX tracer/profiler calls
are disabled for this adapter and return `unavailable`, never invented metrics.

## Build and load strategy

Python/TorchNPU eager candidates require no C++ compiler. For a C++ TorchNPU
binding, the prepared bridge may use the task-scoped helper:

```python
from operator_studio_ascend import load_npu_extension
extension = load_npu_extension("my_operator", ["operator.cpp"])

def run(inputs):
    return extension.forward(inputs["x"])
```

This helper derives includes/libraries from the **installed**
`torch_npu.utils.cpp_extension.NpuExtension`, then calls the installed PyTorch
JIT loader with `with_cuda=False` and a task-local build directory. Missing C++
compiler, ninja, native APIs, compile failures or load failures are surfaced;
it does not install or guess matching versions. This supports a C++ binding to
installed TorchNPU/CANN APIs; it is not an automatic Ascend C kernel compiler.

Ascend C device sources require an explicitly admitted, version-matched build
recipe in the prepared bridge (including the actual SoC/toolkit configuration).
There is no invented universal `bisheng` command or automatic CANN installation.
Such a bridge may build into the task root and use `torch.ops.load_library`, or
the normal PyTorch JIT loading APIs. Raw `.asc`/`.cce` are not passed to generic
C++ compilation. Do not advertise all Ascend C toolchains as validated.

When native source is present, actual candidate-side `load`/`load_inline` or
`torch.ops.load_library` success must name an existing task-owned native library.
The manifest records its digest after measurements and the actual load errors;
library hashing never enters scored timing. A stale file by itself,
a swallowed compiler exception, or an oracle-side load cannot satisfy this
requirement. Existing typed failures keep their original error; any more specific
adapter exception is also retained under `adapterError`. Post-measurement build
failure preserves measured readings but fails the overall result. A different
loader API needs an explicit observation port before it can satisfy this rule.

## Preflight and local verification

For the newly allocated shared 910B machine, first follow
[connection/container preflight](CONNECTION_PREFLIGHT.md). Its narrower current
scope permits connection and compatibility preparation, including the latest
explicitly authorized credential-free SSH handshake; no image execution. It records the approved FlagTree image tag
`202606-torch2.9.0-base`, authorization for all target NPUs, pending observed
digest/device paths, the restricted container/dependency specification, and a
single support handoff. Standard SSH through the formal permission path reached
JumpServer; strict host-key verification stopped the local SSH handshake before
account authentication. The parent subsequently logged in through the normal
cloud Web terminal; this local executor does not share that authenticated
session. Its reported root disk use of 97.2% requires read-only DockerRootDir,
backing-mount capacity and existing-image checks before any acquisition.
Routine reconnect and existing web-login refresh are authorized; local SSH
trust/authentication and container execution remain pending. The future runtime
inventory runs inside a reviewed container.
All remote experiment writes are restricted to
`/public-flash/wzp`.
The device-initializing commands below belong to a later separately approved
phase, not the initial inventory.

Local Python 3.11 grammar checks for this adapter, its test and the reused base
runner passed; see [syntax evidence](../../output/ascend910b-verification/python311-syntax.json).
They ran under Python 3.12 on Windows AMD64 and do not establish Python 3.11,
aarch64, CANN 9.0.0 or FlagTree runtime compatibility.

Safe on this Windows development host, no device access:

```powershell
python -I -B tools/ascend910b/runner.py --preflight
./.gpu-venv/Scripts/python.exe -I -B tools/ascend910b/test_runner.py
```

The first command reads distribution metadata and tool paths only. Missing
dependencies/unsupported OS returns a JSON `blocked` result and exit 1; installed
metadata alone returns `metadata_only`, never hardware readiness. The second
uses existing CPU PyTorch tensors, injected event/device/load APIs, task-local
fixtures and CUDA entrypoint rejection guards. The extension module itself is
injected because its real import can query CUDA availability. The final guarded
suite makes zero accelerator/compiler/driver/model calls. Simulated timings
are fixtures, not performance results.

After a Linux Ascend910B machine is separately authorized and its operator has
activated the intended environment, these are the executable prechecks:

```bash
python3 -I -B tools/ascend910b/runner.py --preflight
mkdir -p output/ascend910b-preflight/{cache,work,logs}
export ASCEND_CACHE_PATH="$PWD/output/ascend910b-preflight/cache"
export ACL_OP_COMPILER_CACHE_DIR="$ASCEND_CACHE_PATH"
export ASCEND_WORK_PATH="$PWD/output/ascend910b-preflight/work"
export ASCEND_PROCESS_LOG_PATH="$PWD/output/ascend910b-preflight/logs"
python3 -I -B tools/ascend910b/runner.py --preflight --probe-device
python3 -I -B tools/ascend910b/test_runner.py
```

Run those commands from an ASCII checkout/task path accepted by the installed
CANN version. The standalone probe is a read-only device check, but TorchNPU may
write initialization logs; the exports above keep those files in this project.
The device probe imports the installed TorchNPU, verifies required APIs,
availability and the selected logical device name, and synchronizes that device.
It does not run a candidate or certify compilation/performance. Optional
`get_cann_version` observations may be absent on older releases; they remain
null with notes. Neither version nor architecture is inferred from a model name.

Remaining machine acceptance: exact driver/firmware/CANN/TorchNPU/PyTorch/Python
compatibility; NPU-aware independent oracle; real tensor correctness/dtype support;
event semantics and multi-stream discipline; native binding compile/load/kernel
dispatch; representative fixed matrix and settled performance; normal exit,
timeout/cancellation and process-group release via the Linux supervisor. None of
the CPU or simulation checks certify these or permit publication.

Official API references checked for this implementation (2026-10-10; installed
release still must be probed, current upstream is not a compatibility promise):

- [TorchNPU device/synchronization and version queries](https://github.com/Ascend/pytorch/blob/master/torch_npu/npu/utils.py)
- [TorchNPU Event and millisecond elapsed time](https://github.com/Ascend/pytorch/blob/master/torch_npu/npu/streams.py)
- [NpuExtension metadata/link strategy](https://github.com/Ascend/pytorch/blob/master/torch_npu/utils/cpp_extension.py)
- [PyTorch extension load API](https://docs.pytorch.org/docs/stable/cpp_extension.html)
- [TorchNPU released version compatibility](https://github.com/Ascend/pytorch/blob/master/COMPATIBILITY.en.md)
- [Ascend C overview](https://www.hiascend.com/document/detail/en/canncommercial/850/opdevg/Ascendcopdevg/atlas_ascendc_map_10_0002.html)
- [CANN cache path and path constraints](https://www.hiascend.com/document/detail/en/CANNCommunityEdition/910/maintenref/envvar/envref_07_0006.html)
- [CANN work/log path priorities](https://www.hiascend.com/document/detail/en/CANNCommunityEdition/latest/maintenref/envvar/envref_07_0007.html)
- [TorchNPU operator cache path](https://www.hiascend.com/document/detail/en/Pytorch/2610/apiref/ENV/docs/en/environment_variable_reference/ACL_OP_COMPILER_CACHE_DIR.md)
