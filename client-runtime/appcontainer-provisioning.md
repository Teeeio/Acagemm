# Operator provisioning and read-only diagnostic contract

This adapter is separate from Mission/Provider orchestration. Normal startup
never provisions resources or invokes UAC. External implementations are consumed
read-only and source pinned; no sibling source file is edited.

## Public Python ports

`appcontainer-provisioning.py` is inert on import. `NarrowAclTransaction(plan,
port, save, journal=None)` accepts `operator-studio.acl-transaction/v1`, an exact
package SID, transaction/approval identity, and distinct ordinary-file targets
with stable object identity and original DACL fingerprint. It exposes `grant()`,
`claim_consumer()` and `cleanup(release)`. The ACL port owns `snapshot`,
`has_write_dac`, `grant_read` and `revoke_read`; the journal port atomically saves
intent and every outcome. `NativeAclPort` reuses the existing public ACL APIs.

All target checks precede the first write. The only delta is one Allow Read ACE
(`0x120089`, flags zero) for the exact package SID. Original ordered ACE bytes,
owner, identity and inheritance remain unchanged. A partial grant rolls back
already touched files. The caller must durably `claim_consumer` before starting
any child. After that claim, cleanup requires a bound Job/PID/creation-time
receipt confirming zero active members. Drift, failed revocation, journal
failure or unknown release remains blocked; journals are preserved for explicit
recovery and grants cannot be replayed. No full-DACL replacement, owner change,
privilege enable, account switch or recursive authorization is provided.

`observed_uac_call` reuses the external `run_elevated_python` transport with
temporarily monitored wait/close functions in the caller process. Calls must be
serialized. `NativeProcessObserver` records actual PID, creation FILETIME,
`WaitForSingleObject` result and `GetExitCodeProcess`. Only a signaled handle
and a final exit code prove termination. Timeout, failed wait, STILL_ACTIVE or
missing identity retains the process handle and an unknown/active receipt;
a result file cannot prove termination. UAC cancellation/unavailable desktop
is structured `UAC_CANCELLED`, without inferring which of those occurred.
`inspect_retained()` observes the same handles without PID-only inference.

The complete external import set is pinned before load: `dispatch/__init__.py`,
`storage_acl.py`, `storage_boundary.py`, `storage_toolchain.py`. The frozen
diagnostic also pins its existing Job implementation. Imports do not start
providers, access credentials or modify resources.

## Batch entry

`appcontainer-probe-batch.py --packet FILE --packet-sha256 DIGEST` only displays
the frozen packet. Actual execution additionally requires `--execute` and an
explicit human `--approval-ref`; the calling operator is responsible for the
approval, and that string is not an OS capability or evidence of permission.

`run_batch(packet, backend, save, clock)` is the injected orchestration port used
by CPU tests and the native backend. One attempt creates a fresh named profile,
uses one narrow UAC transaction, launches one frozen native read-only probe in a
verified AppContainer/kill-on-close Job, uses a second narrow UAC revocation,
then deletes only its owned profile. No Mission/Gate/Provider workflow is copied.
No venv launcher or Torch/DLL/GPU load is implied by file Read. If Read is
insufficient, it stops without extending authorization.

Unknown grant-helper termination prohibits a competing revoke or profile
deletion. Cancellation, partial failure and revocation failure retain exact
observations. Original fingerprints must match before profile deletion. A
cleanup-required outcome requires explicit operator recovery; no automatic
retry or replacement profile is created. UAC helpers must retain the original
host user SID; using another account is rejected before mutation.

The packet freezes total scheduling deadline, helper wait, probe and release
budgets. Cleanup is reserved and late grant mutation is refused. A Windows UAC
dialog or native call may outlive a scheduling deadline: this is unknown,
not proof of process termination. Journals/profile are retained in that case.

## Verification

`python -I -B tests/appcontainer-provisioning-test.py` uses fake native/ACL ports
and real temporary journals. It covers live timeout with an apparent result,
UAC cancellation, failed wait/exit, all-target preflight, partial rollback,
revocation recovery, drift and complete batch ordering/cleanup barriers.
No test invokes UAC, modifies real ACL/profile or starts a model/GPU.
