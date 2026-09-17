# Prepared binding dependency-boundary addendum

Upstream frozen 2026-09-14 after integrated Root release failed at the unchanged
test:state-domain-boundary. Failure: application/benchmark-package-preparation-service.mjs
imports execution-package-store.mjs, which brings a concrete persistence dependency.
The earlier acceptance route incorrectly allowed that pure helper import through
the store. The original failure and earlier candidate verification remain evidence.

## Sole correction route

Move the existing contentDigest function body unchanged into
client-runtime/execution-package-contract.mjs, importing only createHash from node:crypto.
Export contentDigest there as the canonical pure function.
execution-package-store.mjs imports that canonical function for its own use and
re-exports the SAME binding under its existing contentDigest public API.
Remove only its now-unused createHash import; keep randomUUID and all persistence
behavior unchanged. No wrappers, duplicate algorithms or new dependencies.
The preparer imports canonicalJson and contentDigest from the pure contract.
Its factory signature, composition-root wiring, package assembly, deadline, all
error behavior and trusted preparedArtifactDigest propagation remain unchanged.
Update the changed module contracts and the nearest Client Runtime README.
Do not weaken or edit state-domain-boundary, existing queue binding tests, strict
failed verifier, live driver, matrix, budgets or acceptance classification.

## Independent compatibility checks

Extend existing tests/execution-package-contract-test.mjs without removing assertions.
Assert canonical and legacy-store contentDigest exports are the identical function.
Use literal known SHA-256 vectors for empty bytes and UTF-8 abc; verify UTF-8 string
and Buffer equivalence, arbitrary binary Uint8Array/Buffer equivalence, and no input
mutation. Do not derive the expected known hashes by calling the new function.
Retain native invalid-input rejection. These are hardware-free compatibility tests.
The unchanged state-domain-boundary is the authoritative transitive dependency check.

Authors may run syntax/targeted existing tests against available inputs. The test
author only runs syntax until the implementation is combined. Root will submit a
read-only exact-candidate command containing contract, store, state-domain-boundary,
queue-prepared-binding, failed-feedback, failed-boundary, module-boundary and
command-recovery checks. Root independently accepts that proof before integration.
Root then reruns the existing release and non-hardware gates once after this fix.
No real GPU or model request from these tasks beyond the authorized dispatch worker.
Stop with decision_request if the route conflicts with another invariant.

