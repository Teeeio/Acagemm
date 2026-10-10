# AppContainer execution adapter

`windows-job-object.mjs` remains the shared process port for Claude, Codex and
local runner execution. With `OPERATOR_PROCESS_BOUNDARY=appcontainer`, it uses
the existing pinned `dispatch/storage_boundary.py:spawn_appcontainer_worker`
through `appcontainer-job-helper.py`. This is a process adapter, not a second
Mission workflow or resource registry. No configuration is enabled by this change.

## Operator-owned provisioning contract

`OPERATOR_APPCONTAINER_PLAN_FILE` names an absolute JSON file outside the writable
Mission Workspace. A single plan or `{plans:[...]}` must contain exactly one plan
whose `cwd` matches the requested workspace. A plan has:

```json
{
  "schemaVersion": "operator-studio.appcontainer-plan/v1",
  "approvalRef": "operator-provisioning-receipt-id",
  "cwd": "absolute active workspace",
  "profileName": "acagemm-or-dispatch-prefixed-identity",
  "packageSid": "S-1-15-2-...",
  "capabilitySids": ["S-1-15-3-..."],
  "boundaryModule": "absolute existing storage_boundary.py",
  "boundaryModuleSha256": "64 lowercase hex characters",
  "pythonExecutable": "absolute host Python outside the workspace",
  "resourceReceiptFile": "absolute operator-owned resource receipt outside workspace",
  "resourceReceiptSha256": "64 lowercase hex characters",
  "resourceLeaseId": "current execution lease"
}
```

The profile and directory/resource grants must already exist and belong to the
operator's current execution lease. The adapter checks the profile mapping and
loads only the pinned module bytes. `approvalRef` binds the operator's receipt;
it is not a capability, permission grant or proof that a manifest was approved.
Provisioning, draining, ACE removal and profile deletion remain the external
owner's responsibility. A profile must not be shared across concurrently active
attempts or carry write access to another Mission. This initial adapter does not
automatically provision/revoke identities; production activation requires those
operator-owned receipts and separately verified cleanup.

`appcontainer-resource-preflight.mjs` exposes `evaluateResourceReadiness`,
`preflightAppContainerResources`, `inspectNativeResources` and
`assertResourceReadiness`. Resolution requires a pinned
`operator-studio.appcontainer-resources/v1` receipt containing state `ready`,
lease/approval/workspace/profile/capability/executable identity, absolute expiry,
the provisioning helper's real wait/exit/PID/creation receipt, and a bound actual
child probe with zero-member Job release. Each resource carries resourceId,
absolute path, stable identity, `read`/`read_execute`, ACL fingerprint and probe
outcome. The selected executable must have a registered execution resource.
The complete external read-only inspector import set is source pinned.

Paths are canonicalized through `realpath`, including Windows short/long names.
The read-only native inspector checks current profile mapping, identities,
ordered ACL fingerprints and selected package/capability grants. It reports
WRITE_DAC separately: an already provisioned usable resource does not require
the ordinary application to hold provisioning authority. Missing grants with
no WRITE_DAC return an operator permission requirement. Unregistered, expired,
drifted, missing-profile and cleanup-required receipts return structured
`resourcePreflight` blocking details before provider authentication or target
launch. Failure never invokes UAC or falls back to ordinary execution.

Claude/Codex construction accepts the injected read-only `resourceInspectorImpl`
port; `resolveAppContainerPlan` accepts `inspectResources` for composition/tests.
The default uses the host Python inspector only, without resource mutation.
Preflight is admission observation (`publishable=false`), never a Gate verdict.
The [operator provisioning adapter](appcontainer-provisioning.md) owns separately
approved diagnostic transactions; normal startup does not call it.

The public JS functions are `appContainerRequested`, `requireBoundarySupervisor`,
`normalizeAppContainerPlan`, `resolveAppContainerPlan` and
`assertAppContainerEvidence`, plus `preflightAppContainerExecution` for provider
preflight. The latter uses the same supervisor/plan/resource checks as launch,
returns `ready`, `processBoundary` and current resource observation on success,
or the blocking `code`, actionable `detail`/`nextAction` and `resourcePreflight`
on failure. Claude/Codex accept optional per-request `environment` in preflight;
the managed Runtime preserves boundary failures before descriptor/auth probes.
The existing shared-host path remains explicit and returns `processBoundary=shared-host`.
Provider/runner adapters use these functions without importing
the external resource registry or domain code. No profile, ACL, network grant,
credentials or registry state is changed by plan resolution or the helper.

## Execution and evidence

The existing launcher verifies the real suspended token. The shared helper
assigns that suspended process to a unique kill-on-close Job before resume,
checks the resumed token, and publishes the normal ready/terminal sidecars.
The source-pinned adapter wraps the existing private
`_verify_appcontainer_child` function in its own process to insert Job assignment
after verification and before ResumeThread; it never edits the external module.
`executionBoundary` contains kind, approvalRef, suspendedToken and afterResumeToken.
Node requires the package SID and enabled capability set to match the plan and
binds terminal PID/creation time/evidence to the startup receipt. Completion still
requires `releaseProof.activeProcessCount=0`; observer loss never grants release.
Output forwarding, input files, provider JSONL parsing and original budgets stay
in their existing ports. Provider environment preparation remains unchanged;
necessary private config/network access must be explicitly approved and provisioned.

`spawnJobObjectProcess` accepts optional structured `argv`. AppContainer mode
requires native argv and rejects cmd/PowerShell command strings. The standard
local runner uses direct Python argv in this mode; custom shell templates remain
available only in the existing shared-host mode. Selecting AppContainer never
falls back to an ordinary shell/process when plans, profiles, tokens or the
supervisor are missing. Existing shared-GPU environment/evidence remains
`shared-host-gpu`, `enforced=false`, `publishable=false`; this adapter does not
upgrade environment declarations or historical results.

## Verification boundary

`node --test tests/appcontainer-execution-test.mjs` checks plan admission,
implementation drift, provider fail-before-auth, identity mismatch and supervisor
refusal with temporary software fixtures. Existing supervisor and local adapter
checks cover the unchanged shared-host path. These checks create no AppContainer
profile, directory ACL or GPU/model task. Real AppContainer product activation,
private-write canaries, venv access, provider network compatibility and GPU work
remain separate approval/acceptance steps.
