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

The runner requires a distinct prepared oracle file and writes a structured
`status=failed` result (including phase, role, and error code) even when
preflight or module loading fails before normal artifacts exist. This keeps
queue polling finite and diagnosable. Candidate code may import modules from
the prepared package root; it cannot resolve host paths.

Run the real smoke and production queue checks with:

```powershell
npm run e2e:shared-gpu
npm run e2e:shared-gpu-service
```

The checks are opt-in and are not part of hardware-free release verification.
