# Local shared GPU runner

`local-shared-gpu-runner.py` is the MVP NVIDIA adapter. It reuses the existing
Correctness/Benchmark contract and process supervisor while replacing the C550
probe with `nvidia-smi` and CUDA event timing. It requires a CUDA-enabled Python
runtime (the repository setup uses `.gpu-venv`) and executes the candidate and
independent oracle from the task-owned directory.

The adapter is selected by `OPERATOR_TEST_BACKEND=local-shared-gpu` and can be
used through the existing `local-c500-service-client` queue port. It does not
create a second scheduler. `OPERATOR_GPU_PYTHON` can point to another CUDA
Python installation on the same drive.

This is a shared, non-isolated development backend. Package admission must
declare `isolation.kind=shared-host-gpu`, `policy.allowSharedHostGpu=true`, and
`policy.packageBoundary=adapter-enforced`. Results carry
`source=local-shared-gpu`, `executionMode=gpu`, and `publishable=false`; they do
not satisfy a formal C550/C550 publication Gate. Cancellation and terminal
resource release still use the existing durable supervisor.

Run the real smoke and production queue checks with:

```powershell
npm run e2e:shared-gpu
npm run e2e:shared-gpu-service
```

The checks are opt-in and are not part of hardware-free release verification.
