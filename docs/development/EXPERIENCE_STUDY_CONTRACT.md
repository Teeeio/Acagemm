# Phase 3 controlled experience study — frozen upstream contract (2026-09-15)

Authority: TEAM_HANDOFF §6.13 and PHASE3_WIKI_CONTRACT. Baseline a22fde2,
production bb3ddd5. This batch adds opt-in experimental condition control through
the EXISTING production prepare path and reuses the existing live driver, GPU
queue, fixed matrix, model observation and regression smoke wrapper.
No dispatch platform changes, new dependencies, new model-based selector, new
workflow, new oracle/Gate, or changes to Profile, correctness or time budgets.
Implementation authors do not modify this contract or independent tests.

## Study design and denominator

Conditions in exact order per block:
1 facts-only, local-only, local-and-wiki
2 local-only, local-and-wiki, facts-only
3 local-and-wiki, facts-only, local-only

Nine independent affine invocations, each fresh isolated project/store/mission,
two distinct verified candidates and two actual rounds under existing fixed
smoke budgets. New run identifiers are expected; Mission goal, operator, matrix,
baseline bytes, provider, source, hardware and budgets must match. Within-run
local experience grows normally; no experience is transferred across invocations.
All conditions import the SAME fixed snapshot before baseline/start, so only
selection changes. Baseline input construction and numeric oracle stay unchanged.
Use existing source snapshot docs/development/evidence/p3-wiki-20260915/snapshot.json,
source b6b4301f15e8ce6955a56776690643ce5db369e6, snapshotDigest
c849536ce799c7de4ac88fc770fb5f66ebad72350a92af42a8acb96d83557cd4.

This is a 3-per-condition exploratory comparison, NOT N20 or a significance claim.
All nine slots are written before the first process starts; failure/unknown and
unstarted slots remain. Stop before the next spawn on non-full-success,
unconfirmed release, missing artifacts, unknown/different observed model,
source/config drift, condition or snapshot mismatch, or audit failure.
No replacement, no tenth sample. One shared GPU resource; only one live batch.

Fixed study-only goal suffix (identical for all conditions):
“在保持上述数值和测试约束的前提下，可以考虑向量化（vectorization）这一待验证方向；必须先确认访问合法性，不据此声称存在带宽瓶颈。”
Do not add fusion to the goal merely to fill a knowledge quota. The existing
default goal remains unchanged unless the explicit study condition is set.

## A: runtime condition interface and ownership

A owns ONLY:
client-runtime/experience-contract.mjs/.md
client-runtime/application/round-experience-service.mjs/.md
client-runtime/local-server.mjs/.md

Optional query.selection.experienceCondition is exactly facts-only | local-only |
local-and-wiki. Unknown, null, empty or non-string explicit values fail with
EXPERIENCE_INVALID before retrieval changes state. Omission retains current D
behavior and legacy query compatibility. Do not alter rank algorithm or budgets.
Condition is an extra eligibility filter AFTER authorization/scope/status/version
checks and BEFORE ranking/quotas:
- facts-only selects zero optional experience of either source.
- local-only excludes records with selectionMetadata.source=kernel-wiki; other
  applicable local human/execution records use unchanged D ranking.
- local-and-wiki uses unchanged D selection.
Excluded authorized records may get reason experience-condition; unauthorized IDs
remain undisclosed. A zero selection still yields a valid frozen context/audit.
When explicit, audit.experienceCondition records the exact condition. Omitted mode
does not require new fields on old contexts, stores or audits.
Collection, mandatory round facts, correctness/Gate/recovery and all budgets are
unaffected in all modes.

createRoundExperienceService adds optional constructor experienceCondition;
omission means current behavior. Explicit values require retrieveWithSelection
and are passed as query.selection.experienceCondition on each new round.
Constructor rejects invalid values synchronously before effectful operations.
On same-round reuse, explicit condition must equal the frozen audit condition;
missing or different frozen explicit condition raises
ROUND_EXPERIENCE_CONTEXT_CONFLICT. It must not silently reselect or relabel.
Existing audit/context behavior in default mode remains compatible.
local-server reads OPERATOR_EXPERIENCE_CONDITION at construction and passes it
only when the env variable is present; explicit empty/invalid must fail before
listening or starting agent/GPU operations. Default unconfigured deployment is unchanged.
No agent-writable mission setting, global config mutation or new API route.

## B: study driver, common audit and bounded orchestration ownership

B owns ONLY:
scripts/e2e-shared-gpu-agent-iteration.mjs and new matching .md
scripts/shared-gpu-acceptance.mjs/.md
scripts/run-shared-gpu-regression-batch.mjs/.md
scripts/experience-condition-study.mjs/.md (new pure contract)
scripts/run-experience-condition-study.mjs/.md (new thin CLI)

The standard verifyContinuationAudit API must retain ALL existing strict
assertions, return shape and failure behavior. In shared-gpu-acceptance expose
verifyRoundFactsAudit({audit,sourceRound,missionId,projectId}), factoring common
identity, prompt SHA/UTF8 bytes, exact source archive facts, parsed MISSION
ITERATION CONTEXT equality, candidate/queue/run binding, Gate/rollback/currentBest
checks from the existing verifier. Existing verifier must still require exactly
one bound execution experience and its ID/version/full content in actual prompt;
facts-only must NEVER make the default verifier pass.
New pure module experience-condition-study exports:
EXPERIENCE_STUDY_SCHEMA_VERSION='operator-studio.experience-condition-study/v1';
EXPERIENCE_CONDITIONS (ordered facts-only,local-only,local-and-wiki);
buildStudySchedule() -> [{index:1..9,block:1..3,condition}];
verifyExperienceConditionAudit({condition,audit,sourceRound,experiences,missionId,
projectId,snapshot}) -> verified receipt or throw.
All modes run strict common facts checks and compare parsed UNTRUSTED EXPERIENCE
DATA items/versions/contextId to selection sidecar. facts-only requires zero
items and zero selected entries, but requires actual source-round execution
experience to have been durably collected (not necessarily injected).
local-only calls original strict verifier and disallows ALL kernel-wiki items.
local-and-wiki calls original strict verifier; requires >=1 reviewed sm86 Wiki
unit, exact id/version/full prompt content and sourceCommit/unitDigest matching
the imported snapshot, unverified/nonpublishable flags. Reject unreviewed or
incompatible entries and sidecar-only/fabricated selection. All modes retain
complete mandatory facts and candidate/queue bindings.
Pure imports have no side effects.

Driver opt-in E2E_EXPERIENCE_CONDITION (three exact values) and
E2E_KERNEL_WIKI_SNAPSHOT (absolute existing snapshot file, required with any study
condition, rejected without a condition). Validate options and snapshot digest
before CLI/model/GPU/runtime spawn; invalid must not fall back to default.
Pass condition to runtime env OPERATOR_EXPERIENCE_CONDITION, overriding ambient
condition; default driver must remove ambient condition to preserve its oracle.
Import snapshot through actual existing HTTP API after project creation and
BEFORE mission/baseline can auto-start, all three conditions same source.
Record import result, snapshot sourceCommit/digest and explicit condition.
Driver config.promptPolicy must record actual WIKI_SELECTION_POLICY_VERSION
(current D, not obsolete retrieve-only constant) even outside study, and when
study-enabled record experienceCondition, wikiSnapshotDigest, studyGoalPolicyVersion
='operator-studio.experience-study-goal/v1'. These fields enter fingerprints.
Study-only suffix exact above. Unconfigured driver goal and checks unchanged.
Use new condition verifier only in explicit study mode; original strict verifier
otherwise. Candidate/test/matrix/stop/rollback/model-observation invariants unchanged.
Retain per-invocation study-audit.json with condition, snapshot identity,
candidate-bound continuation audit and actual selected Wiki identities.
The existing regression batch stays smoke/n20; n20 rejects study env before
spawn (study results must never be accidentally labeled strict N20).
Do not alter existing ledger classification or pool across study conditions.

Thin runner CLI:
node scripts/run-experience-condition-study.mjs --snapshot ABS --artifact-dir ABS
--report-dir ABS --gpu-python ABS
Export parseStudyArguments(argv) and runExperienceStudy(options, ports={}) for
independent tests. Strict reject unknown/repeated/missing args and invalid paths.
New report directory only, exclusive; artifact/report paths distinct, nonoverlap,
outside repo ancestors, alias/junction validated, snapshot outside outputs.
Use the existing runRegressionBatch({mode:'smoke',families:['affine'],...}) via
existing CLI subprocess (fixed argv, no shell) for every scheduled invocation;
do not reimplement smoke's workflow, classification or release barrier.
Ports may inject invokeSmoke({index,condition,artifactDir,reportDir,snapshot,gpuPython})
returning {exitCode,signal?}, and readInvocation({index,condition,artifactDir,reportDir,snapshot})
returning {runRoot,record,conditionAudit,metrics,originals:[{path,sha256}]}; record is
the existing readRunRecord DTO. Default readInvocation reads and verifies raw
files, never trusts receipt counts alone. These ports exist only for fixtures;
never allow CLI to enable mocks. Export verifyStudyReport(reportPath) as the
read-only counterpart, in addition to parseStudyArguments/runExperienceStudy.
Child env fixes condition/snapshot; no credential copying into artifacts.
Progress DISPATCH_PROGRESS lines, actual exit drives result. Preserve byte-exact
logs and full nine-slot atomic study.json before effects. Do not accept stdout
success over nonzero exit. Report strictN20Passed=false always.
For comparison, retain each complete original configuration/fingerprint.
Compute shared design identity by deleting ONLY
config.promptPolicy.experienceCondition from normalizeConfigForFingerprint;
do not remove model/source/snapshot/matrix/budget/goal fields. Actual observed
provider model must be identical and fully observed. Missing fields stay unknown.
Comparison report descriptive only: each invocation baseline/candidate benchmark
per-profile latency from actual retained task/result evidence, candidate identity,
correctness, elapsed time and model request count. No inventing missing metrics,
no latency pooling across profiles, no independent remeasurement outside queue.
A --verify-report ABS read-only CLI mode recomputes schedule, condition receipts,
source/config/model comparability and result metrics from retained originals;
no model/GPU/runtime/process starts in this mode. Refuse changed raw artifacts.
Root will use this reader independently after the live run.

## C: independent tests and shared catalog ownership

C owns ONLY new tests/experience-condition-runtime-test.mjs,
tests/experience-condition-study-test.mjs, tests/README.md, package.json,
scripts/verify-local-c500-release.mjs, client-runtime/README.md,
client-runtime/application/README.md, docs/development/MODULE_OWNERSHIP.md.
Do not edit existing tests or production implementation to accommodate new tests.
Real production HTTP/runtime fixture uses isolated data/runtime and no GPU/model.
Matrix:
1 default old retrieval and strict verifier semantics preserved;
2 all three conditions before rank/quota including related Wiki; facts-only no
  selected entries; local-only keeps relevant execution and excludes Wiki;
3 zero-experience mode does not stop collection/mandatory facts;
4 invalid explicit/null/empty modes fail, unsupported legacy retrieval fails;
5 frozen same-round reuse cannot switch condition; new round uses configured one;
6 unauthorized IDs stay hidden, scope/hardware/version checks not bypassed;
7 exact condition/policy enters persisted selection and pre-send audit;
8 original strict continuation verifier rejects facts-only prompt;
9 study facts-only accepts actual zero items with full matching facts+collected
  source experience, rejects lost facts/tampered SHA/sidecar mismatch;
10 local-only Wiki contamination and Wiki-mode missing/unreviewed/wrong snapshot
   content fail; actual prompt not only sidecar checked;
11 exact balanced nine-slot schedule, no replacement; stop/release/unknown/model/
   source/config/snapshot/condition mismatch leave remaining slots stopped;
12 invalid CLI and import no side effects; existing dirs, overlaps/alias and
   mismatched original digests rejected; verifier read-only/no spawn;
13 standard fingerprint includes D policy, study condition/snapshot/goal; only
   condition differs in shared design identity; source/model drift not hidden.
Tests target documented public entrypoints/ports. Use meaningful independently
constructed fixtures, not implementation-text matching. Initial author syntax
only until combination; no new tests passing against absent candidates.
Register the two new suites in existing release once; update module contracts.

## Verification and stop conditions

Authors: targeted syntax/existing nearest tests only, no full suite or live run.
Root combines exact A/B/C candidates and runs two new suites, existing
round-experience-service, experience-api-service, shared-gpu-acceptance,
plus state-domain/module boundaries; the new study test covers batch wiring.
Then existing release and NH gates at
the final exact integration point (existing project cross-module requirement).
No default acceptance relaxation or profile/matrix/time changes.
Stop with decision_request on incompatible interface, ambiguous artifact shape,
missing safety/release guarantee, repeated failure, out-of-scope change or
provider/channel unavailability. No alternative architecture or new agents.
After software integration/root verification: freeze exact source, run nine-slot
study via command with gpu:0 mutual exclusion and approved existing DeepSeek
route. Independently verify all originals, retain all failures, commit evidence
and update current docs. A failed pilot is a valid diagnostic result, never
claimed as benefit/stability or replaced with extra samples.
