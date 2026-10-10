# C500 / Ascend910B machine handoff

Current target choices are MetaX MACA C500 and Huawei Ascend910B. Legacy C550
fixed examples retain their original contracts and evidence. Both new targets
are implemented for local contract validation and remain machine-unverified,
development-only and publishable=false.

## Before execution

Use an existing authorized Linux target image, with an ASCII project/runtime/task
path for CANN. The project uses no installer in its metadata preflight:

    node scripts/preflight-accelerator.mjs local-metax-c500
    node scripts/preflight-accelerator.mjs local-ascend910b

These commands inspect installed package metadata/tools using the same resolved
Python as Runtime. They never import torch or touch a device. Missing dependencies
or unsupported OS are reported as blocked. metadata_only is not readiness.

Both new target launchers require already-provisioned Node 20+ and locked native
dependencies for the target architecture. They refuse automatic installation or
archive fallback. The retained historical launcher may still use its existing
x64 archives; it is not the new target entry. Do not copy Windows node_modules to either host.
No software installation, WSL start, service/cgroup setup, ACL, firewall or account
change has been performed by this integration.

The machine operator supplies the existing licensed/compatible driver/firmware,
MACA + MetaX Torch (+ Triton/native toolchain as used), or CANN + TorchNPU +
PyTorch. Read the dedicated worker README for its exact installation/API checks.
Credential/provider spending and system permission changes need their own
authorization. API/CLI keys are not written into task manifests or this report.

## Qualification and deployment

After host execution scope is authorized, activate its intended Python and pin
actual image versions in the environment:

    export OPERATOR_GPU_PYTHON=/absolute/approved/env/bin/python
    export OPERATOR_ALLOW_SHARED_ACCELERATOR=1

For C500 set OPERATOR_METAX_C500_VERSIONS_JSON to an exact JSON object containing
python, torch, maca, driver; add compiler/triton when used and configure
OPERATOR_METAX_C500_COMPILER for the actual compiler. For 910B set
OPERATOR_ASCEND910B_VERSIONS_JSON with python, torch, torch_npu, cann, driver.
No example versions are supplied as if compatible. Missing version observation
is blocked and requires an explicit supported target release adapter.

    node scripts/preflight-accelerator.mjs local-metax-c500 --probe-device
    node scripts/preflight-accelerator.mjs local-ascend910b --probe-device
    npm run verify:linux-compatibility
    npm run tester:metax-c500 -- doctor --json
    npm run tester:ascend910b -- doctor --json

--probe-device actually accesses the selected accelerator and synchronizes it.
Passing qualification is development admission, not correctness/performance or
publication. Then launch the corresponding tester entry and configure a generic
Mission with hardware C500 or Ascend910B, independent target-aware oracle, complete
frozen semantics/testSpec, implemented language and original budgets. Save-only
and generate-only flows remain available without pretending the device is ready.

## Required machine acceptance

- Native Linux CPU lifecycle: persistence before effects, process group cleanup,
  cancellation, owner loss, supervisor loss/quarantine, restart identity/receipt.
- Exact target provenance, framework/compiler/driver/firmware compatibility,
  event units/sample count, selected-device placement and stream synchronization.
- Independent baseline, all frozen correctness cases and benchmark profiles,
  dtype/layout/input-mutation rules, unchanged tolerances and retry limits.
- Native compile/load and actual kernel dispatch when native code is selected.
- Normal exit, typed failures, timeout/cancellation, atomic terminal result plus
  supervisor release receipt through the same production API/queue/Gate.
- Full product iteration and best-candidate binding on the actual target.

Windows CPU/simulation results do not prove any of those hardware results.
This integration leaves static capability verification unverified and publication
disabled. Existing simulation evidence cannot become live evidence.

## Evidence preservation

The old attention recovery preparation remains byte-identical, but its pinned
source is expired after this integration. The expiry record is under
docs/development/evidence/acagemm-assessment-20261009/linux-target-integration-20261010/.
Do not reuse it to authorize a host, provider or GPU start.
No commit/push/reset is performed. Backups preserve exact pre-integration source.

## Ascend authorized deployment boundary

For the currently requested Ascend machine, every experiment file belongs under
`/public-flash/wzp`, inside the user-specified Docker example container. Connection
and authentication are handled by the assigned Ascend task through the supported
SSH/JumpServer entry. No alternative tunnel, host installation or shared host
environment mutation is part of this handoff. A local transfer archive contains
source and locked dependency manifests only; upload waits for confirmed target
connection/container parameters. Credentials and local runtime data are excluded.
