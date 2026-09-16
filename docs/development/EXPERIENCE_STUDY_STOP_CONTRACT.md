# Study observation stop and nested exit contract

Authority: existing two-candidate real GPU acceptance, MODEL_OBSERVATION_ACCEPTANCE.md,
EXPERIENCE_STUDY_CONTRACT.md and EXPERIENCE_STUDY_ARTIFACT_CONTRACT.md. This addendum
changes observation timing and truthful failed-report reading, not evidence thresholds.

## S1: durable experience may already exist

The live observer currently waits for `experienceCollection.recorded > 0`. The real
slot-02 run in dispatch attempt `run_8af77bbae54b4a138aaf38b8f836659f` reached two
completed candidates while `recorded=0, existing=1`. It unnecessarily waited through
a collect timeout/recovery and a third agent start. The third run was cancelled
without a response model, correctly making the invocation non-comparable.

Export pure `hasDurableCollectedExperience(collection)` from the existing
`scripts/shared-gpu-acceptance.mjs`. Missing recorded/existing counters mean zero;
supplied counters must be nonnegative safe integers. Return true when their sum
is positive, false for absent/malformed/negative/nonfinite/string counters, zero
totals, and collection.status `failed`, `pending`, `skipped`, or other statuses
except `recorded`. This is only an observation-ready predicate, never success.

Use it in the live driver's full-success polling break in place of recorded-only.
Keep completed candidate count, unique source archive, continuation, every existing
queue/correctness/profile/digest/rollback/condition/prompt/model/stop check intact.
Upon leaving the observer loop, request the existing production stop promptly,
before further experience/audit filesystem/API reads. Preserve the pre-stop
observation state for validation and store the actual stop receipt even if later
validation fails. An unconfirmed stop cannot pass. Teardown/finally remains safe.
Collect bridge records after stop, including all real started runs; cancelled or
unobserved runs remain required and unknown. Do not change deadlines, providers,
matrices, source identity rules, or runtime autopilot. This reduces unnecessary
overrun; it does not claim an atomic server-side two-round limit.

## S2: three process layers have separate exit meanings

`study.invocations[N].exitCode` is the smoke batch child exit. The nested
`slot-NN/batch.json.invocations[0].exitCode` is the individual live driver exit.
The observed valid failure is: driver exit0/completed/full_success, smoke batch
status failed because comparable=false with provider.model issue, outer slot
exit1/failed. The read-only verifier must return a verified stopped study for this
truthful failure, retaining 1 completed + 1 failed + 7 unstarted and strictN20=false.
It must not require the two child exit codes to be equal. A nonzero smoke exit
paired with batch.status passed remains a contradiction. For nested driver exit0
under batch failed, require the retained one-invocation non-comparable failure
and its issues (not an invented success). Keep malformed/identity/path/snapshot,
false-green, source/model drift and all original evidence checks.

## Frozen independent validation

- S1 positive: new record, existing-only idempotent record, mixed counts; negative:
  no collection, zero, wrong status, negative/string/NaN/infinite/noninteger counts.
- Test the exported production helper and actual live-driver wiring/stop ordering
  with an explicitly inert harness; no real CLI, GPU, Python or network. The test
  must fail against the old recorded-only consumer, not only test a duplicate predicate.
- S2 use the public verifyStudyReport entry and real fixture files: actual nested
  failure exit1/exit0 is readable and remains failed; claimed passed batch with
  nonzero outer exit is rejected; insufficient non-comparable proof is rejected.
  Existing study fixtures and their original invariants stay intact.
- Implementers own no tests or this addendum. One independent test writer owns
  both test additions and tests/README.md. No implementer changes acceptance inputs.
- Author syntax/nearest existing targeted checks; combined independent tests,
  shared-gpu acceptance/model collector, study suite, release and two module
  boundaries at the integration point. No new full non-hardware run is required
  for this isolated script correction; prior runtime gates remain recorded.

## S3: safely exhausted budget is a readable failure (2026-09-16)

R5 (`run_52c15b22251c4935b1ba1c156423e55a`) retained three complete slots,
then a comparable `budget_terminal` driver exit0 inside a failed smoke exit1,
and five unstarted slots. S2's restriction to non-comparable failures was too
narrow. Add this separate branch without changing the original S2 branch.

Require exactly one completed driver invocation in a failed one-run affine smoke
batch, strictN20=false, and the exact smoke budget stop reason. Resolve the run
and its two originals inside that slot, rejecting filesystem aliases outside it.
Reclassify attempt/summary through the existing acceptance classifier: outcome
must be budget_terminal, with no contradictory issues. Reuse continuationSafety
for release; do not invent release from the outer exit. Preserve the failed slot,
nonzero smoke exit, absent success metrics, full denominator and strictN20=false.

Public-reader filesystem tests cover a valid stopped result, claimed passed batch,
wrong stop reason, borrowed run, missing budget proof, claimed full success and
unconfirmed release. Both passing and rejecting reads preserve all input bytes.
The actual R5 originals must reread as 3 completed / 1 failed / 5 stopped.

The user explicitly authorized direct implementation while dispatch is maintained
on 2026-09-16. This S3 change and its tests are by the primary agent, not an
independent dispatch test author. Existing acceptance invariants remain unchanged;
do not label this work as a dispatched or independently authored deliverable.
