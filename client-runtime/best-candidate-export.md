# Best retained candidate export contract

Production flow remains TUI -> Production API -> candidate validation application
service -> pure export rules -> injected immutable candidate reader. No second
iteration workflow, current-worktree read, test submission or model call exists.

## Public API

- Application: existing createCandidateValidationService gains
  getBestCandidate(missionId), with the existing readPendingCandidate port.
- HTTP: GET /api/missions/:id/best-candidate, handled by the existing thin candidate
  validation route. It reads atomic committed state, never advances/reconciles.
- Pure domain: bindRetainedBestCandidate(state,pending,{settledAt}),
  createBestCandidateExport({best,bundle}), assertBestCandidateExport(document).
- Pure source contract: pending-candidate-bundle-contract.mjs provides
  assertPendingCandidateManifest, assertPendingCandidateBundle and
  reviewedPendingSourceBoundary. Storage reuses these integrity rules; its
  filesystem/path ownership and canonical-file checks remain in the adapter.

## Retention invariant

Explicit pending feedback uses the ordinary receipt projection and Accept Gate.
Only after that path retained a matching currentBest, with passed correctness,
valid benchmark, matching test run/candidate/patch, released resources and a
complete independent baseline, it records currentBest.frozenCandidate:

    { schemaVersion: operator-studio.best-candidate-source/v1,
      reference: ORIGINAL_PENDING_DTO,
      identity: { missionId,candidateId,patchDigest,manifestDigest,sourceRunId,
        roundId,baselineDigest,semanticDigest,testSpecDigest,
        testRunId,taskId,baselineRunId,baselineTaskId },
      acceptance, evidenceDigest }

The immutable manifestDigest binds original source bytes, source policy/intake
review, business acceptance policy in testSpec, Semantic Snapshot, independent
baseline and original round. No separate version of the business policy is used.

Acceptance freezes the best summary, canonical evidence decision/Gate, candidate
receipt/result/matrix/semantic binding, comparison-baseline run and baseline
evidence. It does not promote a winner or grant publication. A correctly retained
local-development candidate with publication blocked remains exportable, with
that restriction preserved. Retained progress short of the task target reports
targetMet=false. Simulation/CPU fixtures remain explicitly software evidence.

Worse, failed or untested later candidates do not replace this binding. Runtime
restart and Mission switching preserve it through the existing currentBest
persistence. Queries use the original reference through trusted immutable storage;
later workspace, baseline and pending contents cannot substitute for it.

## Export and offline validation

DTO schema operator-studio.best-candidate-export/v1:

    { schemaVersion, identity, best, acceptance, evidenceDigest, bundle, replay }

bundle is the original verified pending-candidate bundle, including byte-exact
base64 sources and separate baseline/oracle.py bytes. replay gives separate
sources/ and baseline/ namespaces, the exact implementation/entrypoint, target
intent, observed environment/package metadata, full matrix and testSpec.

assertBestCandidateExport is the same integrity validator used by the application,
client materializer and hardware-free replay CLI. It rechecks source paths,
byte lengths/hashes, manifest/bundle hashes, semantic/test digests and original
acceptance bindings. It rejects foreign/partial baseline identities, a changed
test contract, counterfeit publication and replay namespace drift. Digests prove
local integrity, not cryptographic execution authenticity; no new verdict is made.

Offline checking needs only the exported package. Operator execution additionally
requires the explicitly selected hardware/toolchain and adapter; package validation
does not execute an operator or certify performance on another device. The full
source snapshot is authoritative; the historical diff is evidence, not a promise
that a standalone patch applies to an unspecified base checkout.

## Reviewed source boundary

For newly reviewed intake, intakeReview.files paths must equal sourcePolicy's
declared sourceFiles. Additional candidate declarations can name only known
implementation-language outputs. A frozen sourceBoundary identifies approved
input paths and possible generated output paths, all covered by manifestDigest.
Input preview digests remain initial provenance; candidate entrypoint bytes may
legitimately change during generation. Undeclared sensitive/new dependency paths
cannot silently join the frozen package. Legacy imports without a review remain
readable and are never relabeled as reviewed.

## Stable errors

- MISSION_NOT_FOUND (404): no saved Mission.
- BEST_CANDIDATE_NOT_FOUND (404): no retained best; never fall back to pending.
- BEST_CANDIDATE_SOURCE_UNAVAILABLE (409): legacy best lacks immutable source.
- BEST_CANDIDATE_CONTRACT_CHANGED (409): saved Mission intent/policy differs.
- BEST_CANDIDATE_IDENTITY_MISMATCH / EVIDENCE_MISMATCH (409): frozen source or
  acceptance identities disagree.
- BEST_CANDIDATE_REPLAY_MISMATCH / EXPORT_INVALID (409): incorrect export/replay.
- Original PENDING_CANDIDATE_* storage/integrity errors propagate unchanged.

## Verification

node tests/best-candidate-export-test.mjs uses only temporary synthetic files and
software receipts. It follows original receipt/Gate/feedback retention, then
checks A versus untested/worse B, mutable workspace/baseline changes, serialized
restart, inactive Mission query, real HTTP route mapping and corruption failures.
No model/hardware operator/server/remote service runs. An explicitly provided
BEST_CANDIDATE_EXPORT_FIXTURE_OUT saves its synthetic package for client/CLI tests.

## Ordinary automatic iterations

The benchmark command freezes an immutable candidate only after the completed Agent and all Mission resources confirm release. `benchmark.automaticFrozenCandidate` carries that original reference through the durable queue intent and receipt. `bindAutomaticBestCandidate(state)` is a pure idempotent adapter to the same retention rules. Composition binds immediately after policy/repository adoption, before a subsequent round can archive the benchmark; maintenance also binds before fixture refresh. Historical bests without source are refused rather than reconstructed.

`node tests/automatic-best-candidate-test.mjs` follows a real immutable store and durable journal/queue with synthetic software receipts, including a save failure, journal replay, later worse candidate and restart. `tests/best-candidate-tui-entry-test.mjs` then exercises actual Ink B, API, extraction and offline CLI; neither test executes a model or hardware.
