# Experience study disk and reader contract — upstream clarification

This supplements EXPERIENCE_STUDY_CONTRACT.md without weakening its 13-item
matrix. Root freezes these public artifact interfaces for independent tests.
The original producer remains scripts/e2e-shared-gpu-agent-iteration.mjs and
scripts/run-shared-gpu-regression-batch.mjs. No new workflow or GPU test is authorized
in software fixtures. This is specification, not a claim the candidates pass.

## Directory and discovery

For study roots A (artifacts) and R (report), slot index i=1..9 receives
artifactDir=A/slot-NN and reportDir=R/slot-NN in BOTH ports. R/study.json holds
all nine entries before the first port invocation. Each slot has its own
runRoot strictly below its artifactDir, e.g. A/slot-01/run-fixture-01.
A standalone default reader finds runRoot from that slot's reportDir/batch.json,
invocations[0].runRoot. It does not discover a run from a parent batch or logs.
The existing smoke CLI may discover its driver run from its child log; that is
internal to the existing smoke wrapper, not the study reader contract.
Each slot's batch.json is the existing smoke report:
mode='smoke', families=['affine'], requestedRuns=1, strictN20Passed=false,
status='passed' for a successful invocation; invocations is exactly one entry,
index=0, status='completed', exitCode=0, outcome='full_success',
comparable=true, runRoot absolute, configFingerprint from that run, issues=[].
For failure retain the original nonzero/missing exit and status; never mint pass.

## Raw driver artifacts

The runRoot contains existing attempt.json and summary.json (their public schema
and required model/config fields stay as in shared-gpu-acceptance.md and
summarize-gpu-agent-runs.mjs). Fixtures construct valid independent records; do not
weaken the existing classifier or model evidence verification.
It also contains:
- affine-state.json: {state, tasks}; state.activeProjectId, state.runHistory,
  and task payload.missionId/purpose/candidate.id/candidate.digest/requestId
  retain their actual production meanings.
- bridge/prompt-audits/<name>.json: a real prepared-before-send audit from the
  public formatter, with exact project/mission/round/run bindings and prompt SHA.
- runtime/experiences/experiences.json: the standard experience repository
  envelope with records and immutable versions, including durable collected
  source-round execution experience in all conditions.
- study-audit.json as specified below.

Select the earliest completed candidate by completedAt then taskId. Its candidate
digest and queue request ID identify exactly one runHistory round. That archive's
roundFacts.target.roundId selects the target audit, whose runId must differ from
the source runId. Do not pick a globally newest audit.
attempt.familyOutcomes[0].missionId and summary.summaries[0].missionId identify
the same affine mission; state.activeProjectId identifies its owning project.
Baseline/candidate task.result.benchmark carries the existing per-profile row
shape from the producer; preserve primary/small values and units, correctness,
live-hardware and release receipts. Use actual documented producer fields;
missing values are unknown. Round/model/request counts are actual evidence.

## study-audit.json

{
  schemaVersion: 'operator-studio.experience-condition-study/v1',
  condition, snapshot: {path, schemaVersion, sourceCommit, snapshotDigest,
    unitCount, reviewedSm86UnitIds},
  projectId, missionId, family: 'affine',
  candidate: {taskId,candidateId,candidateDigest,queueRequestId},
  import: <existing real HTTP import receipt retained by the driver>,
  continuationAudit: <verifyExperienceConditionAudit receipt>
}

snapshot.path is absolute. snapshotDigest is the existing canonical snapshot
digest representation, not its file SHA. The frozen fixture snapshot is validated
by the public KernelWiki contract. continuationAudit is the public pure condition
receipt, including selectedWiki (actual selected record/unit/version identities),
condition, snapshot, sourceRound, facts and audit binding. Do not create a separate
top-level selectedWiki that substitutes for this receipt. Tests may invoke public
pure receipt/formatting APIs to serialize producer sidecars, but independent
positive/negative assertions must verify the underlying content and bindings.

## originals and hash representation

The default reader returns {runRoot, record, conditionAudit, metrics, originals}
plus optional diagnostic fields. record is the public readRunRecord DTO.
conditionAudit is the recomputed continuationAudit receipt, not the wrapper.
originals are ordered:
1 batchReport: slot reportDir/batch.json
2 attempt: runRoot/attempt.json
3 summary: runRoot/summary.json
4 state: runRoot/affine-state.json
5 promptAudit: selected target audit file
6 driverStudyAudit: runRoot/study-audit.json
7 experiences: runRoot/runtime/experiences/experiences.json
Each entry is {role,path,sha256,bytes}: path absolute; sha256 lowercase BARE
64-character hex over exact file bytes (no sha256: prefix); bytes exact length.
Extra shape fields are compatible; no source may be borrowed from another slot.
The snapshot is independently revalidated against report.snapshot, not included
as a replacement for one of these seven original files.

## Report and read-only receipt

R/study.json schemaVersion='operator-studio.experience-condition-study/v1',
runnerSchemaVersion='operator-studio.experience-condition-study-runner/v1'.
Fields: status ('completed' or 'stopped' terminal), strictN20Passed=false,
startedAt/finishedAt ISO timestamps, stopReason (null on success), requestedSlots=9,
snapshot (same identity plus path), goalPolicyVersion,
schedule (frozen nine tuples), invocations (nine matching identities),
design {sharedDesignIdentity, standardFingerprints, source:{commit,contentDigest},
model}, comparison {descriptiveOnly:true,significanceClaimed:false,byCondition}.
Each invocation: index,block,condition,status,startedAt,finishedAt,exitCode,signal,
artifactDir,reportDir,logPath,runRoot,conditionAudit,designIdentity,
standardFingerprint,metrics,originals,issues.
The runner emits these fields. Test the actual result, do not handwrite a
successful report bypassing the runner. Use only invokeSmoke injection to create
valid original fixtures for the default-reader positive.

verifyStudyReport(R or R/study.json) returns
{ok:true,reportFile,status,stopReason,strictN20Passed:false,requestedSlots:9,
slotCounts,verifiedSlots,design,schedule,snapshot}.
No schemaVersion field is required in this receipt. ok=true means faithful
verification of the report, not successful study. A genuine drift report must
verify with status='stopped', first successful slot retained, offending slot
failed, remaining seven stopped. Tampered hashes, slot identities, exit/status,
design/metrics/comparison must throw. Clean positive MUST verify first.
No Error-or-object assertion is an acceptable positive.

## Stop identity and independent negative examples

Per-slot issues is an array of strings. report.stopReason names the first failure
as 'slot_N: ' plus its issues; unstarted later slots have issues=['study_stopped'].
Use a valid first slot then single-field second-slot mutation for cross-run drift.
Stable issue prefixes:
observed_model_drift, source_or_config_drift, shared_design_identity_drift,
study_config_mismatch:, observed_model_missing,
standard_fingerprint_not_comparable:, unsafe_continuation:,
condition_mismatch, snapshot_digest_mismatch, not_full_success:,
raw_evidence_invalid:, smoke_exit_code:.
Assert the target prefix and first successful slot, not an unrelated generic stop.
The public provider.modelObservationStatus='unknown' represents unknown model
observation; never substitute a guessed model label. Existing model evidence
records and fingerprint unknown fields stay authoritative. Full required
observation, exact matrix/budgets and every required release remain mandatory.

Pure parseStudyArguments handles lexical flags/path relationships only.
Filesystem existence/realpath/junction checks are runExperienceStudy preflight,
before output creation or invoking either port. Independent tests exercise that
async public entry with zero-invocation/unchanged-directory assertions.
