# C500 and Ascend910B package composition

The pure accelerator-backends module declares local-metax-c500 and
local-ascend910b, their exact targets, runner paths, adapter identities and package
ports. No import probes a device. Static capability entries remain unverified,
available=false and publishable=false; implementedLanguages describes software
only and does not replace verified languages.

The production composition root reuses execution-package-store, benchmark
preparation, local-c500-service-client, its original supervisor and the serialized
Operator Test Queue. The C550 compatibility backend remains separate. No
existing fixed Profile matrix or historical hardware evidence is renamed.

probeAcceleratorRuntime({backendId,rootDir,python?,probeDevice?,environment?,
run?,timeoutMs?}) defaults to isolated distribution metadata inspection. It never
imports torch in that mode, and returns ready=false. Windows/missing packages
return blocked; Linux metadata_only remains inspection, not admission.

Actual qualification is explicit and requires:
- Hardware not disabled and OPERATOR_ALLOW_SHARED_ACCELERATOR=1 in trusted host
  configuration. This opts into development execution on a shared accelerator;
  it does not grant OS access or claim an isolation boundary.
- C500: OPERATOR_METAX_C500_VERSIONS_JSON pins python, torch, maca, driver.
  Native compiler/Triton use adds actual compiler/triton pins, not guessed names.
  OPERATOR_METAX_C500_COMPILER identifies the installed compiler when pinned.
- 910B: OPERATOR_ASCEND910B_VERSIONS_JSON pins python, torch, torch_npu, cann,
  driver. Missing actual CANN/driver observations fail closed; a release lacking
  the worker's supported observation API needs an explicit observation adapter.
- The dedicated worker's actual exact-device/API probe, exact version comparison,
  Python executable and both runner/base-engine byte digests.

createAcceleratorEnvironmentResolver refreshes bounded qualification, caches at
most 30 seconds and clears stale state after failure. It never substitutes
NVIDIA/C550/MUSA/CPU for another target. Selection alone does not run a probe.

createAcceleratorPackageAdapter delegates C500 to the public metax-c500 module
(`python-metax-c500@1`, environment `metax-c500`); its backend selector is
`local-metax-c500`. C500 preparation requires the injected supervised build/load
port and its bound release receipt. Native candidate .cu/.cpp files remain in the
candidate layer. Unknown release retains a persistent barrier and prevents queue
dispatch; it never supplies a verdict.

Ascend910B uses immutable staging, Python AST/local-import validation, per-file
digests and preparation-release checks with `python-local-ascend910b@1`. This
preparation proves syntax/materialization; native compilation/load and device
correctness happen in the supervised runner. Both paths reuse the existing
supervisor and queue rather than creating a second build scheduler.

The store admits the explicit shared-host-accelerator development policy only
for these exact environment/target pairs, enforced=false, adapter-enforced package
boundary and publishable=false. Plain host CPU/unregistered/mismatched/publishable
policies remain rejected. Both workers preserve independent oracle binding and
typed terminal failures. Only the supervisor proves execution resource release.
No new target experienceEvidence is minted or fed to the NVIDIA verifier.

Public verification: npm run test:accelerator-integration tests metadata/disabled
paths, version/device mismatches, failed refresh, exact Mission intake, Doctor
refusal, immutable package preparation and test-tool submission through injected
CPU ports. Those tests provide no real performance/device evidence.
