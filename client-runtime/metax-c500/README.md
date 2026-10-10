# MetaX C500 execution adapter contract

This module owns C500 runtime inspection and immutable execution-package preparation.
It owns no Mission, Gate, queue, publication or target-registry policy. Imports from
application code must use `index.mjs`. Current status: software implementation and
CPU contract verification only; no C500 supported-version or performance claim.

## Public interface

- `METAX_C500_PACKAGE_ADAPTER`: `python-metax-c500@1`, package languages `['python']`.
- `METAX_C500_PACKAGE_PORT`: environment `metax-c500`, candidate `run.py`,
  independent acceptance `oracle.py`, correctness and benchmark checks.
- `METAX_C500_TARGET`: `{ platform: 'metax-maca', device: 'gpu' }`.
- `METAX_C500_RUNNER`: absolute path to `tools/metax-c500/runner.py`.
- `probeMetaxC500Runtime({ python, versionPolicy, timeoutMs?, signal?, mxSmi?, compiler?, run? })`
  returns `{ environment, capabilities }`. Default probe runs the Python probe only
  when called; importing the module has no hardware effect. `run` is an injected
  read-only execFile-shaped port used by CPU tests.
- `createMetaxC500EnvironmentResolver({ probe?, probeOptions?, cacheTtlMs? })`
  exposes `resolve(id, {refresh?,signal?,deadline?})` and `clear()`. No vendor fallback.
- `createMetaxC500PackageAdapter({rootDir, execFileImpl?, prepareLoad})`
  implements package-store `prepare`, `verifyPreparedArtifact`, `inspectPreparation`.
- `readMetaxC500PreparedArtifact({rootDir,preparedArtifactDigest})` reads the bound
  build/load receipt. The root belongs exclusively to this adapter.

Version policy requires exact `python`, `torch`, `maca`, `driver` strings from the
actual vendor image. `triton` and `compiler` pins are optional for plain Python;
native source requires the configured compiler executable and exact `--version`
output pin. There is no default version or C550 compatibility whitelist. MACA is
observed from SMI or `torch.version.maca`, never guessed from the Torch suffix.
Failed metadata parsing, foreign hardware, missing interfaces and version drift fail
closed. Moore Threads MUSA is another vendor, not an alias for MACA.

The locked environment binds device index/name, framework/runtime/driver/compiler,
Python executable, runner and reused engine digests, and validated timer interface.
Changing SMI utilization is retained as diagnostic text and does not change identity.
No architecture, UUID, firmware or compatible fork version is invented when absent.
The environment is explicitly shared-host GPU, not OS isolation, and all output is
`publishable=false`. A target probe is not target-platform qualification.

## Supervised preparation port

Reuse the existing supervised execution owner at the composition root; do not spawn
an unsupervised build worker. Missing `prepareLoad` fails before source execution with
`METAX_C500_PREPARATION_PORT_REQUIRED`.

`prepareLoad(input)` receives preparationId, packageDigest, environmentDigest,
target, root, manifest, environment, original AbortSignal/deadline and
`command: {executable, argv}`. The fixed command runs `runner.py --stage prepare-package`.
The owner executes it within the original deadline, reads its JSON `buildLoad`, and
pairs that output with its original process-tree exit/absence evidence:

```js
{
  preparationId, packageDigest, environmentDigest,
  buildLoad: { status: 'passed', candidateLoaded: true, oracleLoaded: true,
    independentOracle: true, targetProbe, nativeBuild,
    candidateRunPyDigest, oracleDigest },
  resourceRelease: { confirmed: true, evidenceRef: 'owned original receipt reference' }
}
```

The Python child cannot attest its own resource release. A Promise, exit callback,
kill request or timeout alone is insufficient. Foreign/missing receipts or thrown
ports leave the durable preparation unknown and unreleased. The adapter persists
its claim before work and atomically persists terminal receipts. Explicit bound
release after a failed/late preparation permits recovery; no automatic replay.
The adapter verifies entrypoint digests and native artifact bytes and rechecks the
source through the existing materializer before every admission/submission.

Source materialization and Python AST validation reuse the documented public
`createSharedGpuPackageAdapter` / `readSharedGpuPreparedArtifact` APIs. Their storage
and process-close checks are reused; NVIDIA probe, registry and timer are not.
Build/load is an admission check only and never produces a correctness verdict.

## Composition-root integration (owned by the coordinating task)

1. Register this identity/port and C500 target separately from historical C550 and
   MUSA. Keep hardware verification pending until real C500 acceptance. No relabel.
2. Construct the resolver with an operator-provided version policy and the actual
   Python/SMI/compiler paths; construct the package adapter with the supervised
   preparation port. Register both with the existing execution package store.
3. Reuse the existing serialized operator-test queue and supervised task executor.
   Select `METAX_C500_RUNNER`; preserve original clocks and release barriers.
4. Verify admission, then reverify the prepared artifact. Read frozen entries through
   its returned root/entrypoints. Derive `candidateNativeSources` from candidate-layer
   manifest files, never from untrusted UI/request text. Supply task hardware and
   matrix environments as `['C500']` plus the existing frozen testSpec/payload.
5. Pass the version JSON and tool paths to execution. Preserve candidate/package/
   acceptance identity, independent reference digest, raw failure and environment
   into the existing evidence/Gate path. Never turn probe success or CPU doubles
   into verified capability or publishable hardware evidence.

The shared composition root, registry, protocol types, launcher and package scripts
are intentionally outside this change's write ownership.

## Verification and remaining target-machine acceptance

`node tests/metax-c500/adapter-test.mjs` uses actual immutable storage and Python AST
validation with injected, explicitly labelled CPU probe/build/load/release doubles.
`python -B tests/metax-c500/runner-test.py` exercises reused complete correctness,
all required profiles, exact Event counts/synchronization, failure provenance,
independent Oracle, native fallback refusal and replay preservation using doubles.
Tests create temporary files only beneath `tools/metax-c500` and remove their own roots.

Real Linux C500 acceptance must verify the actual vendor image and compiler/fork,
GPU stream/Event units against the SDK's timer, compilation/loading, full correctness
and all benchmark profiles, result return, at least two real Agent feedback rounds,
cancel/deadline release and restart. Fixed Profiles retain their original 24 cases,
both required BF16 profiles and three-round requirements. Unknown versions stay
unknown; local CPU checks cannot replace these target-machine checks.
