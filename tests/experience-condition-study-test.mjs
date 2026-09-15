// Independent acceptance matrix for EXPERIENCE_STUDY_CONTRACT.md section C items 9-13:
// the study condition verifier (facts-only / local-only / local-and-wiki), the frozen
// nine-slot schedule, the thin study runner's fixture ports, the read-only report reader,
// the shared-design fingerprint split and the production guards that keep a study environment
// out of the driver and out of the strict N20 denominator.
//
// Entry points under test are the documented public ones only: the pure study contract
// (`buildStudySchedule` / `verifyExperienceConditionAudit`), the thin runner's exported
// `parseStudyArguments` / `runExperienceStudy` / `verifyStudyReport`, the factored
// `verifyRoundFactsAudit` next to the retained `verifyContinuationAudit`, and the real
// configuration-fingerprint helpers. Study fixtures are produced by the real production
// path (experience repository -> HTTP application service -> KernelWiki importer ->
// round-experience service `prepare` -> production context formatter and prompt builder)
// and written to disk in the frozen producer layout, so the default `readInvocation` port and
// the public reader are exercised against real bytes rather than a mock reply. Every reader
// negative builds and verifies its own complete green fixture first and then mutates exactly one
// field of that same fixture, so no negative can be judged on a layout a copy already broke and
// no case inherits a cached result from another. No assertion matches implementation source text.
//
// No provider, model, network, Python or GPU work is contacted here. Every slot is filled
// through the documented `invokeSmoke` fixture port, so no smoke child starts for a slot;
// the default `readInvocation` port is left untouched wherever the frozen reader contract
// is under test. Two groups of cases do start real children, and every child is inert:
// matrix 13b runs the production driver CLI under a broken study environment whose provider
// CLI and Python executable are pinned to absent paths (only the preflight refusal is
// accepted: no run root, no state, no report), while the three `spawn` cases at the end run
// the real exported `createDefaultInvokeSmoke` default adapter against a temporary inert
// local Node child to prove the frozen startup plumbing — where the raw log really lands,
// that the child alone creates its report directory, that both streams survive in that one
// log, that a success-looking marker cannot replace the real nonzero exit code and that a
// pre-existing report directory is never overwritten. The standard N20 mode is exercised
// through its documented injected-port path and must refuse a study environment with zero
// spawns. The nine-slot schedule is
// asserted from the retained study.json written before the first spawn. Every stop case in
// the schedule matrix keeps the same retained nine-slot schedule: a released slot is never
// replaced, resampled or completed silently. Each drifted field of that stop matrix is its own
// independently reported sub-case, with its own green fixture and its own expected slot exit
// code, so a failing branch is counted into the process exit instead of masking the branches
// behind it and no branch is judged against the green zero it never had. The report reader is
// exercised against retained bytes only, so its read-only behavior is proven by identity of
// the whole fixture tree rather than by a reported flag.
//
// This file was written against the frozen interface while the parallel A/B producers were
// still uncombined; the author phase runs `node --check`, plus the one bounded targeted check
// that the nested fixture it constructs is internally consistent with the real pure helpers.
// Measured boundary in this isolated tree (never a pass): 20 pre-existing cases pass and the
// three `matrix 14` cases fail only on the still-unlanded production reader rule that must not
// require the nested driver exit code to equal the smoke batch exit code. A green run after
// combination is contract/integration evidence for the frozen interface, never a selection
// benefit, stability, N20 or publishability claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  EXPERIENCE_STUDY_SCHEMA_VERSION, EXPERIENCE_CONDITIONS,
  buildStudySchedule, verifyExperienceConditionAudit,
} from '../scripts/experience-condition-study.mjs';
import {
  parseStudyArguments, runExperienceStudy, verifyStudyReport, createDefaultInvokeSmoke,
} from '../scripts/run-experience-condition-study.mjs';
import {
  GPU_ATTEMPT_SCHEMA_VERSION, GPU_SUMMARY_SCHEMA_VERSION, ROUND_FACTS_SCHEMA_VERSION,
  buildConfigFingerprint, normalizeConfigForFingerprint, verifyContinuationAudit, verifyRoundFactsAudit,
} from '../scripts/shared-gpu-acceptance.mjs';
import { BATCH_SCHEMA_VERSION } from '../scripts/run-shared-gpu-regression-batch.mjs';
// The real end-of-batch ledger: the nested-failure fixture takes its per-invocation
// comparability verdict and issue list from the same production pure function the smoke batch
// uses, instead of hand-writing a "non-comparable" claim.
import { summarizeAcceptanceRuns } from '../scripts/summarize-gpu-agent-runs.mjs';
import { createExperienceRepository } from '../client-runtime/experience-repository.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { createExperienceApiService } from '../client-runtime/application/experience-api-service.mjs';
import { createRoundExperienceService } from '../client-runtime/application/round-experience-service.mjs';
import {
  EXPERIENCE_SELECTION_POLICY_VERSION, formatExperienceContext,
} from '../client-runtime/experience-contract.mjs';
import { WIKI_SELECTION_POLICY_VERSION } from '../client-runtime/experience-selection.mjs';
import { buildKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';
import { buildCandidateGenerationPrompt } from '../client-runtime/candidate-generation/prompt.mjs';
import {
  MODEL_OBSERVATION_PROVIDER, MODEL_OBSERVATION_SCHEMA_VERSION,
  observeClaudeModel, summarizeModelObservations,
} from '../client-runtime/model-observation.mjs';

const MISSION_ID = 'mission-study';
const PROJECT_ID = 'project-study';
const FOREIGN_PROJECT_ID = 'project-study-foreign';
const SOURCE_ROUND = `${MISSION_ID}:round:1`;
const TARGET_ROUND = `${MISSION_ID}:round:2`;
// The frozen KernelWiki source commit of the study snapshot; the alternate commit proves a
// snapshot whose provenance does not match the imported records is refused.
const STUDY_COMMIT = 'b6b4301f15e8ce6955a56776690643ce5db369e6';
const OTHER_COMMIT = 'c'.repeat(40);
const SOURCE_RUN = 'run_study_source';
const CONTINUATION_RUN = 'run_study_continuation';
const QUEUE_REQUEST = 'run_study_queue_1';
const CANDIDATE_ID = 'candidate-study-01';
const PATCH_DIGEST = 'a'.repeat(64);
const SNAPSHOT_DIGEST = `sha256:${'d'.repeat(64)}`;
const STUDY_GOAL_POLICY_VERSION = 'operator-studio.experience-study-goal/v1';
const OBSERVED_MODEL = 'deepseek-v4-flash';
const DIFFERENT_MODEL = 'another-model';
const FIXED_CLOCK = Date.parse('2026-09-15T09:00:00.000Z');
const GOAL = 'Reduce vector_add tail latency; candidate technique: vectorization for the tail block handling.';
// The frozen balanced schedule, written out literally: the module export is compared against
// it first, so a drifting producer cannot make the rest of this file agree with itself.
const FROZEN_SCHEDULE = [
  { index: 1, block: 1, condition: 'facts-only' },
  { index: 2, block: 1, condition: 'local-only' },
  { index: 3, block: 1, condition: 'local-and-wiki' },
  { index: 4, block: 2, condition: 'local-only' },
  { index: 5, block: 2, condition: 'local-and-wiki' },
  { index: 6, block: 2, condition: 'facts-only' },
  { index: 7, block: 3, condition: 'local-and-wiki' },
  { index: 8, block: 3, condition: 'facts-only' },
  { index: 9, block: 3, condition: 'local-only' },
];
// The frozen stop vocabulary of the artifact contract. A drift case asserts one documented
// prefix; `unrelated` names the prefixes that must NOT be the reason, so an unrelated
// generic stop can never satisfy a targeted case.
const STOP_PREFIXES = Object.freeze([
  'observed_model_drift', 'source_or_config_drift', 'shared_design_identity_drift',
  'study_config_mismatch:', 'observed_model_missing', 'standard_fingerprint_not_comparable:',
  'unsafe_continuation:', 'condition_mismatch', 'snapshot_digest_mismatch',
  'not_full_success:', 'raw_evidence_invalid:', 'smoke_exit_code:',
]);
const EXPERIENCE_BEGIN = '----- BEGIN UNTRUSTED EXPERIENCE DATA -----\n';
const EXPERIENCE_END = '\n----- END UNTRUSTED EXPERIENCE DATA -----';
const ORIGINAL_ROLES = Object.freeze([
  'batchReport', 'attempt', 'summary', 'state', 'promptAudit', 'driverStudyAudit', 'experiences',
]);

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const fileDigest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const digest = (character) => character.repeat(64);
const roots = [];

let passed = 0;
let failed = 0;
// Every case is isolated: one failure reports its own name and stack and the remaining cases
// still run, so a combination collects every error instead of only the first. Any failure
// makes the process exit non-zero, so a partial run is never reported as green.
const test = async (name, run) => {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};
// The verifier contract is "verified receipt or throw": a rejected input must throw an Error
// (never resolve to a receipt) and the case fails when it silently accepts.
const expectRejected = (label, run) => assert.throws(run, Error, `${label}: the verifier must reject this input`);
const countOf = (value) => (Array.isArray(value) ? value.length : (Number.isInteger(value) ? value : null));
const merge = (base, patch) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? merge(base[key], value) : value;
  }
  return out;
};
const failureOf = (issues) => (Array.isArray(issues) ? issues : []).map(String);

// --- production fixtures -----------------------------------------------------------------

const mission = Object.freeze({
  id: MISSION_ID, projectId: PROJECT_ID, operator: 'vector_add', tags: [],
  hardware: ['nvidia-gpu'], architecture: ['sm86'], goal: GOAL,
});
const stateFor = () => ({
  activeMissionId: MISSION_ID,
  iterationStats: {
    resolvedTarget: { missionId: MISSION_ID, hardware: ['nvidia-gpu'], architecture: ['sm86'], capabilities: [], software: [] },
  },
  benchmark: { status: 'idle' },
  runHistory: [],
});
// The frozen facts carry the same source-round binding the retained archive carries,
// including the actual candidate source run: the audit's `previous`, the archived round
// (on disk and as the direct oracle) and the producing task must name one real source, so
// the direct positive and the disk reader are never allowed to disagree on that binding.
const roundFactsFor = () => ({
  schemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  recordedAt: '2026-09-15T08:00:00.000Z',
  target: { missionId: MISSION_ID, projectId: PROJECT_ID, roundId: TARGET_ROUND },
  previous: {
    missionId: MISSION_ID, projectId: PROJECT_ID, runId: SOURCE_RUN, roundId: SOURCE_ROUND,
    candidateId: CANDIDATE_ID, candidateDigest: `sha256:${PATCH_DIGEST}`, queueRequestId: QUEUE_REQUEST,
    candidateSourceRunId: SOURCE_RUN,
  },
  candidate: { candidateId: CANDIDATE_ID, digest: `sha256:${PATCH_DIGEST}` },
  correctness: { passed: true, cases: 4 },
  failure: null,
  gate: { result: 'reference' },
  decision: { status: 'allowed' },
  rollback: { performed: true, origin: SOURCE_ROUND },
  currentBest: { candidateId: null, status: 'reference' },
});
// The direct-oracle archive is structurally identical to the round the default reader
// derives from the retained `runHistory`: dropping `candidateSourceRunId` here would let the
// direct positive pass while the very same binding failed on the raw artifacts, so the
// documented source-round identity is kept on both paths instead of being deleted on one.
const sourceRoundFor = (facts) => ({
  roundId: SOURCE_ROUND,
  runId: SOURCE_RUN,
  candidateId: CANDIDATE_ID,
  candidateDigest: `sha256:${PATCH_DIGEST}`,
  queueRequestId: QUEUE_REQUEST,
  candidateSourceRunId: SOURCE_RUN,
  decisionReview: { resolution: { outcome: 'reference' } },
  roundFacts: facts,
});
const executionEvidence = () => ({
  missionId: MISSION_ID, candidateId: CANDIDATE_ID, runId: QUEUE_REQUEST,
  patchDigest: `sha256:${PATCH_DIGEST}`, packageDigest: `sha256:${digest('b')}`,
  environmentDigest: `sha256:${digest('c')}`, acceptanceDigest: `sha256:${digest('d')}`,
  hardware: 'nvidia-gpu', architecture: 'sm86', executionMode: 'gpu', outcome: 'passed', operation: 'correctness',
});
const wikiPage = ({ id, body }) => ({
  path: `wiki/techniques/${id}.md`,
  text: [
    '---',
    `id: ${id}`,
    `title: "${id} tail guidance"`,
    'type: technique',
    'tags: ["vectorization"]',
    'symptoms:',
    '  - tail block handling',
    'candidate_techniques:',
    '  - masked-tail-loop',
    'architectures:',
    '  - sm86',
    'performance_claims:',
    '  speedup: "9.9x"',
    '---',
    '',
    body,
    '',
  ].join('\n'),
});
const PAGE_ID = 'study-tail-handling';
const PAGE_BODY = 'Mask the final partial block instead of padding the whole tensor.';
// `reviewed: false` builds the frozen "unreviewed" unit: the importer stores it, but its
// applicability never qualifies it for injection, so a verifier that accepts it as a
// reviewed study unit is wrong even though the record really exists in the store.
const snapshotFor = ({ reviewed = true, sourceCommit = STUDY_COMMIT, architectures = ['sm86'] } = {}) => buildKernelWikiSnapshot({
  pages: [wikiPage({ id: PAGE_ID, body: PAGE_BODY })],
  sourceCommit,
  reviews: reviewed ? [{
    pageId: PAGE_ID, reviewId: `review-${PAGE_ID}`, mode: 'architecture-specific',
    hardware: ['nvidia-gpu'], architectures, requiredCapabilities: [], software: [],
  }] : [],
});
// The reviewed sm86 identities the frozen snapshot really carries, derived from the public
// snapshot document rather than from a literal in this file.
const reviewedSm86UnitIds = (snapshot) => (snapshot.units ?? [])
  .filter((unit) => unit.selectionMetadata?.applicability?.mode !== 'unreviewed'
    && (unit.selectionMetadata?.applicability?.architectures ?? []).includes('sm86'))
  .map((unit) => unit.unitId)
  .sort();

const roundServiceFor = (experienceService, extra = {}) => createRoundExperienceService({
  experienceService,
  resolveAccess: ({ mission: owner }) => ({ projectId: owner.projectId, allowedProjectIds: [] }),
  verifyObservationEvidence: async ({ observation }) => ({ verified: true, evidence: observation.evidence, summary: 'In-memory verification receipt.' }),
  timers: { setTimeout, clearTimeout },
  timeoutMs: 2000,
  ...extra,
});
// One shared setup builder: a KernelWiki unit imported through the HTTP application service
// (the only writer of selection metadata), one applicable local observation, and optionally
// an execution observation recorded through the real round service. The returned store is a
// real repository transaction history, so the slot fixture can retain its exact bytes.
const setup = async (label, { execution = true, reviewed = true, sourceCommit = STUDY_COMMIT } = {}) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `operator-study-${label}-`));
  roots.push(rootDir);
  const repository = createExperienceRepository({ rootDir });
  let serial = 0;
  const service = createExperienceService({
    repository,
    now: () => new Date(FIXED_CLOCK + serial * 1000).toISOString(),
    createId: () => `EXP-STUDY-${++serial}`,
  });
  const api = createExperienceApiService({
    loadState: async () => ({ projects: [{ id: PROJECT_ID }, { id: FOREIGN_PROJECT_ID }] }),
    experiences: service,
  });
  const snapshot = snapshotFor({ reviewed, sourceCommit });
  const imported = await api.importKernelWiki(PROJECT_ID, { snapshot, author: 'study-test' });
  assert.equal(imported.statusCode, 200, JSON.stringify(imported.payload));
  await api.create(PROJECT_ID, {
    visibility: 'project', title: 'Local tail observation', author: 'engineer',
    content: 'The masked tail block previously produced mismatched values.',
    scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
  });
  let collected = 0;
  if (execution) {
    const recorder = roundServiceFor(service);
    const recorded = await recorder.record({ state: stateFor(), mission, observation: { evidence: executionEvidence(), evidenceRefs: ['result.json'] } });
    assert.equal(recorded.status, 'recorded', JSON.stringify(recorded));
    collected = 1;
  }
  return { rootDir, repository, service, api, snapshot, imported, collected };
};
const recordsOf = async (service) => (await service.read(null, { projectId: PROJECT_ID })).experiences;
// The real production prepare path with an explicit study condition; the frozen context and
// its persisted selection sidecar are the only source of the audited artifacts.
const prepare = async (service, condition, state = stateFor(), roundId = TARGET_ROUND) => {
  const roundService = roundServiceFor(service, condition === undefined ? {} : { experienceCondition: condition });
  const context = await roundService.prepare({ state, mission, roundId });
  return { context, selection: state.iterationStats.roundExperienceSelection };
};
const wikiItems = (items) => items.filter((item) => item.selectionMetadata?.source === 'kernel-wiki');
const promptFor = (context, facts) => buildCandidateGenerationPrompt({
  mission: { ...mission, iterationContext: facts },
  goal: GOAL,
  workspace: path.join(os.tmpdir(), 'operator-study-workspace'),
  baseline: {},
  testMatrix: {},
  workspaceInventory: ['run.py'],
  experienceInstruction: formatExperienceContext(context, { projectId: PROJECT_ID, missionId: MISSION_ID, roundId: context.roundId }),
});
const auditFor = ({ context, selection, facts, runId = CONTINUATION_RUN }) => {
  const prompt = promptFor(context, facts);
  return {
    schemaVersion: 'operator-studio.prompt-audit/v1',
    deliveryStage: 'prepared-before-send',
    createdAt: '2026-09-15T08:30:00.000Z',
    missionId: MISSION_ID, projectId: PROJECT_ID, roundId: context.roundId, runId,
    prompt, promptDigest: `sha256:${sha256(prompt)}`, promptBytes: Buffer.byteLength(prompt, 'utf8'),
    roundFacts: facts, selection,
  };
};
// Rebuild an audit after a deliberate edit: the sidecar digest/bytes are recomputed so a case
// fails on the rule it targets, never on a stale digests-first check.
const reaudit = (audit, prompt, selection = audit.selection) => ({
  ...audit,
  prompt,
  ...(selection === null ? {} : { selection }),
  promptDigest: `sha256:${sha256(prompt)}`,
  promptBytes: Buffer.byteLength(prompt, 'utf8'),
});
// Every prompt tamper below arrives with a recomputed SHA/byte count, so the case can only fail
// on the rule it targets (fabricated unit, duplicated item, omitted item, sidecar disagreement)
// and never on the cheap "the digest does not match the prompt" check that comes first.
const tamperedAudit = (audit, prompt, selection = audit.selection) => {
  assert.notEqual(prompt, audit.prompt, 'a tamper case must really change the audited prompt');
  const rebuilt = reaudit(audit, prompt, selection);
  assert.equal(rebuilt.promptDigest, `sha256:${sha256(prompt)}`, 'the tampered prompt carries its own recomputed SHA');
  assert.equal(rebuilt.promptBytes, Buffer.byteLength(prompt, 'utf8'));
  assert.notEqual(rebuilt.promptDigest, audit.promptDigest, 'the tampered prompt is not the audited one');
  return rebuilt;
};
const experienceBlock = (prompt) => {
  const start = prompt.indexOf(EXPERIENCE_BEGIN);
  const stop = prompt.indexOf(EXPERIENCE_END, start + EXPERIENCE_BEGIN.length);
  assert.ok(start >= 0 && stop > start, 'the production prompt must carry its untrusted experience block');
  return { start, stop, block: JSON.parse(prompt.slice(start + EXPERIENCE_BEGIN.length, stop)) };
};
const withExperienceBlock = (prompt, mutate) => {
  const { start, stop, block } = experienceBlock(prompt);
  mutate(block);
  return prompt.slice(0, start + EXPERIENCE_BEGIN.length) + JSON.stringify(block) + prompt.slice(stop);
};
// A study receipt is "verified receipt or throw"; only the frozen identity below is asserted,
// because everything else is producer-internal and must not be guessed by an independent test.
const verifyCondition = ({ condition, audit, sourceRound, experiences, snapshot }) => {
  const receipt = verifyExperienceConditionAudit({
    condition, audit, sourceRound, experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
  });
  assert.ok(receipt !== null && typeof receipt === 'object', `the ${condition} verifier must return a receipt object`);
  if (receipt.condition !== undefined) assert.equal(receipt.condition, condition, 'a receipt that names a condition must name the frozen one');
  return receipt;
};

// --- slot fixture: the frozen producer layout on disk -------------------------------------

// The observed response-model proof the retained acceptance DTO carries. It is built with the
// production pure observation API, so the ledger's independent recomputation over the retained
// DTOs really agrees with the declared summary instead of trusting a hand-written verdict.
const modelProofFor = (model, runId) => {
  const sessionId = `sess-${runId}`;
  const observations = [observeClaudeModel({
    runId, missionId: MISSION_ID, sessionId,
    events: [{ type: 'assistant', session_id: sessionId, message: { model } }],
  })];
  const requiredRuns = [{ provider: MODEL_OBSERVATION_PROVIDER, runId, missionId: MISSION_ID, sessionId }];
  return {
    modelObservations: observations,
    modelObservationRequiredRuns: requiredRuns,
    modelObservationSummary: summarizeModelObservations(observations, { requiredRuns }),
  };
};
// The retained response-model proof of a slot whose provider model was never truthfully
// observed: one required run identity really answered while the other one stayed unobserved, so
// the production summarizer reports the incomplete proof as `unknown` with a named reason and
// the run cannot be comparable. This is the real shape behind the frozen nested-exit case — the
// workflow itself succeeded, the evidence about which model served it did not. It is built with
// the same production pure API, so the ledger's independent recomputation over the retained
// DTOs still agrees with the declared summary.
const unknownModelProofFor = (runId) => {
  const observedSession = `sess-${runId}-observed`;
  const unobservedSession = `sess-${runId}-unobserved`;
  const observations = [
    observeClaudeModel({
      runId: `${runId}_observed`, missionId: MISSION_ID, sessionId: observedSession,
      events: [{ type: 'assistant', session_id: observedSession, message: { model: OBSERVED_MODEL } }],
    }),
    // Only a session bootstrap: the run really started but no response model was ever read, so
    // the run stays a required, unobserved identity rather than a fabricated observation.
    observeClaudeModel({
      runId, missionId: MISSION_ID, sessionId: unobservedSession,
      events: [{ type: 'system', subtype: 'init', session_id: unobservedSession, model: null }],
    }),
  ];
  const requiredRuns = [
    { provider: MODEL_OBSERVATION_PROVIDER, runId: `${runId}_observed`, missionId: MISSION_ID, sessionId: observedSession },
    { provider: MODEL_OBSERVATION_PROVIDER, runId, missionId: MISSION_ID, sessionId: unobservedSession },
  ];
  return {
    modelObservations: observations,
    modelObservationRequiredRuns: requiredRuns,
    modelObservationSummary: summarizeModelObservations(observations, { requiredRuns }),
  };
};
// The terminal provider identity the real driver derives from its frozen model summary
// (`model: modelObserved ? modelSummary.model : 'unknown'`, `modelSource: modelObserved ?
// 'observed' : 'unknown'`, and the summary's own status/schema version). A fixture that keeps a
// declared observed model next to an unknown proof is self-contradictory, so the nested case
// derives its provider identity from the proof it really retains instead of declaring a model the
// run never read. Everything derived from that configuration - the fingerprint, the retained
// attempt/summary provider copies and the acceptance ledger's comparability verdict - then agrees.
const unobservedProviderIdentity = (summary) => ({
  model: 'unknown',
  modelSource: 'unknown',
  modelObservationStatus: summary.status,
  modelObservationVersion: summary.schemaVersion,
});
// The shared-GPU runner result shape (`tools/local-shared-gpu-runner.py` normalizing
// `tools/local-c500-runner.py`): per-profile rows carry the measured value, its unit and the
// percentiles, the environment carries the live-hardware probe and the candidate digest the
// runner itself recorded, and the row correctness block is the real per-case receipt. The
// shapes below are the producer's; an independent test may not reshape them.
const GPU_RESULT_SCHEMA_VERSION = 'operator-studio.shared-gpu-result/v1';
const DEVICE = 'NVIDIA GeForce RTX 3060 Laptop GPU';
const DRIVER_VERSION = '555.99';
const correctnessReceipt = () => ({
  passed: true, total: 4, passedCases: 4, failedCase: null, failedCaseName: null, failedCaseCategory: null,
  caseResults: ['minimal', 'representative', 'boundary', 'ragged'].map((name) => ({
    case: name, dtype: 'float32', maxDiff: 1e-6, rmse: 1e-7, cosDiff: 1e-8, passed: true,
  })),
  error: null,
});
const benchmarkRows = (scale) => [
  {
    environment: 'local-shared-gpu', metric: 'latency_p50', profile: 'primary',
    value: 11.264 * scale, unit: 'us', samples: 10, warmup: 3, p95: 12.166 * scale,
    referenceValue: 11.264, speedup: 1 / scale, correctness: correctnessReceipt(),
  },
  {
    environment: 'local-shared-gpu', metric: 'latency_p50', profile: 'small',
    value: 9.801 * scale, unit: 'us', samples: 10, warmup: 3, p95: 10.585 * scale,
    referenceValue: 9.801, speedup: 1 / scale, correctness: correctnessReceipt(),
  },
];
const environmentReceipt = ({ digestValue }) => ({
  requested: ['local-shared-gpu'],
  runtime: 'local-shared-gpu-runner/v1',
  service: 'local-shared-gpu-adapter',
  source: 'local-shared-gpu',
  hardware: 'nvidia-gpu',
  architecture: 'sm86',
  device: DEVICE,
  driverVersion: DRIVER_VERSION,
  executionMode: 'gpu',
  liveHardware: true,
  publishable: false,
  candidateDigest: digestValue,
  targetProbe: { deviceName: DEVICE, driverVersion: DRIVER_VERSION, architecture: 'sm86' },
});
// A completed task in the documented producer shape: purpose/request binding, the per-profile
// benchmark rows with units and correctness, the live-hardware environment receipt with the
// bound candidate digest and the confirmed resource release. The candidate execution evidence
// repeats the same candidate/queue binding the runner recorded, so the task is admissible
// evidence (`isRealGpuCompletedCandidate`) instead of an inflated status claim.
const taskFor = ({ taskId, purpose, completedAt, digestValue, queueRequestId, candidateId, scale }) => ({
  taskId, status: 'completed', progress: 100, completedAt, durationMs: 2000,
  resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
  payload: {
    missionId: MISSION_ID, purpose, requestId: queueRequestId,
    candidate: { id: candidateId, digest: digestValue, sourceRunId: SOURCE_RUN },
    packageDigest: `sha256:${digest('b')}`, admissionId: `admission-${taskId}`,
    workspaceId: MISSION_ID,
    target: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
  },
  result: {
    schemaVersion: GPU_RESULT_SCHEMA_VERSION, status: 'completed', publishable: false,
    environment: environmentReceipt({ digestValue }),
    benchmark: benchmarkRows(scale),
    experienceEvidence: {
      missionId: MISSION_ID, candidateId, runId: queueRequestId, patchDigest: digestValue,
      packageDigest: `sha256:${digest('b')}`, environmentDigest: `sha256:${digest('c')}`,
      acceptanceDigest: `sha256:${digest('d')}`,
      hardware: 'nvidia-gpu', architecture: 'sm86', executionMode: 'gpu',
      outcome: 'passed', operation: 'correctness', liveHardware: true,
    },
  },
});
// The confirmed stop receipt the production driver retains per family. It is built by the same
// public rule the driver uses (`evaluateMissionStopReceipt`), so the fixture's release claim is
// the producer's own shape rather than a hand-written flag.
const stopReceiptFor = (runId) => ({
  missionId: MISSION_ID, statusCode: 200, confirmed: true, reasons: [],
  state: {
    activeMissionId: MISSION_ID,
    missionPaused: true,
    iterationStats: { loopStatus: 'stopped' },
    agent: { runId, missionId: MISSION_ID, status: 'stopped', resourceRelease: { confirmed: true, status: 'confirmed', resources: [] } },
    workflowRecovery: { resourceRelease: { confirmed: true, status: 'confirmed', resources: [] } },
    runtimeEvents: [],
  },
});
// A complete invocation result in the documented readRunRecord DTO shape: runRoot plus the
// retained attempt/summary documents in the real producer shape (terminal phase, per-family
// outcomes bound to the real Mission, the completed-candidate attribution, the confirmed
// release and the full observed-model proof). Everything here is required for the invocation
// to be a comparable `full_success`: without the Mission binding or the confirmed stop
// receipts the reader/batch would refuse the slot, which would make every drift case vacuous.
// Every mismatch case below is this record with exactly one documented field changed.
const runRecordFor = ({ runRoot, config, label, proof, sourceRound, continuationAudit = null, outcome = 'full_success', fullSuccess = true }) => {
  const fingerprint = buildConfigFingerprint(config, { code: config.code }).fingerprint;
  const runId = `${CONTINUATION_RUN}_${label}`;
  const completedCandidates = [
    { taskId: 'task-candidate-01', candidateDigest: `sha256:${PATCH_DIGEST}`, candidateSourceRunId: SOURCE_RUN, queueRequestId: QUEUE_REQUEST, packageDigest: `sha256:${digest('b')}` },
    { taskId: 'task-candidate-02', candidateDigest: `sha256:${digest('e')}`, candidateSourceRunId: SOURCE_RUN, queueRequestId: 'queue-candidate-02', packageDigest: `sha256:${digest('b')}` },
  ];
  const attemptPath = path.join(runRoot, 'attempt.json');
  const summaryPath = path.join(runRoot, 'summary.json');
  const stopReceipt = stopReceiptFor(runId);
  const evidence = {
    runRoot, attemptPath, summaryPath,
    promptAuditDir: path.join(runRoot, 'bridge', 'prompt-audits'),
    runtimeLog: path.join(runRoot, 'runtime.log'),
    stateFiles: [path.join(runRoot, 'affine-state.json')],
  };
  const shared = {
    runtime: 'claude-code', provider: config.provider, backend: config.backend,
    config, code: config.code, configFingerprint: fingerprint,
    fingerprintUnknownFields: [], comparable: true,
    families: ['affine'], completedFamilies: fullSuccess ? ['affine'] : [],
    unfinishedFamilies: fullSuccess ? [] : ['affine'],
    ...proof,
  };
  return {
    runDir: runRoot,
    attemptPath,
    summaryPath,
    attempt: {
      ...shared,
      schemaVersion: GPU_ATTEMPT_SCHEMA_VERSION,
      attemptId: path.basename(runRoot), runRoot,
      phase: 'terminal', status: 'terminal',
      startedAt: '2026-09-15T08:00:10.000Z', endedAt: '2026-09-15T08:02:00.000Z',
      outcome, fullSuccess,
      candidateTasks: 2,
      observedTargets: [{ family: 'affine', hardware: ['nvidia-gpu'], architecture: ['sm86'], device: DEVICE, driverVersion: DRIVER_VERSION, backend: 'local-shared-gpu', sourceRunId: SOURCE_RUN }],
      familyOutcomes: [{
        family: 'affine', outcome, fullSuccess, reasons: fullSuccess ? [] : ['candidate_not_completed_real_gpu'],
        missionId: MISSION_ID, firstRun: SOURCE_RUN, sourceRunId: SOURCE_RUN,
        sourceRoundId: SOURCE_ROUND, continuedRun: runId,
        budgetTerminalAccepted: false, completedCandidates: fullSuccess ? completedCandidates.length : 0,
      }],
      failure: fullSuccess ? null : { message: 'the family did not reach the frozen two-round success', code: null },
      cleanup: {
        runtimeSpawned: true,
        runtimeExit: { at: '2026-09-15T08:02:00.000Z', code: 0 },
        stopReceipts: [stopReceipt],
        teardownStop: stopReceipt,
        teardownWrites: 0,
        artifactsRetained: true,
        artifactsRoot: runRoot,
      },
      evidence,
    },
    summary: {
      schemaVersion: GPU_SUMMARY_SCHEMA_VERSION,
      status: fullSuccess ? 'passed' : 'failed',
      outcome, fullSuccess, ...shared,
      attemptPath, summaryPath, evidence,
      summaries: [{
        family: 'affine', missionId: MISSION_ID, firstRun: SOURCE_RUN, sourceRunId: SOURCE_RUN,
        sourceRoundId: SOURCE_ROUND, sourceRoundTargetRoundId: sourceRound?.roundFacts?.target?.roundId ?? TARGET_ROUND,
        firstRoundOutcome: sourceRound?.decisionReview?.resolution?.outcome ?? 'reference',
        outcome, fullSuccess,
        outcomeReasons: fullSuccess ? [] : ['candidate_not_completed_real_gpu'],
        budgetTerminalAccepted: false, budgetTerminalEvidence: null,
        // In an explicit study condition the driver verifies with the condition verifier, so the
        // retained family identity carries that public receipt — not a null placeholder and not
        // a strict-mode receipt the study never computed.
        continuationAudit, continuedRun: runId, rollbackCount: 1,
        completed: fullSuccess ? completedCandidates : [],
        workflowWritesAfterStart: 0, experienceCount: 1,
        observedTarget: { hardware: ['nvidia-gpu'], architecture: ['sm86'], device: DEVICE, driverVersion: DRIVER_VERSION, backend: 'local-shared-gpu' },
        stopReceipt,
      }],
      stopReceipts: [stopReceipt],
      teardownStop: stopReceipt,
      teardownWrites: 0,
      failure: fullSuccess ? null : { message: 'the family did not reach the frozen two-round success', code: null },
      writes: [],
    },
    errors: [],
  };
};
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

// The fixture's own completeness receipt. It is asserted on the clean construction, before any
// case-specific mutation, so a later negative can be trusted to fail on the rule it targets
// rather than on a fixture that was already unusable. Nothing here is a producer-internal
// guess: every field checked is either frozen by the artifact contract (model proof, Mission
// binding, candidate attribution, live-hardware rows, snapshot metadata) or produced by the
// public pure APIs used above.
const assertFixtureComplete = ({ index, documents, snapshot, sourceRound, condition, drifted = false }) => {
  const label = `slot ${index}`;
  const { record, state, studyAudit, proof, batch } = documents;
  // A nested-failure fixture is the one deliberate exception to the complete observed-model
  // proof: its workflow really completed but its retained model evidence is honestly
  // incomplete. It must still be a well-formed UNKNOWN proof — a real required identity left
  // unobserved with a named reason — never a malformed or fabricated one, otherwise the case
  // would be exercising a broken fixture instead of the frozen non-comparable failure.
  const nested = documents.nestedNonComparable === true;
  if (nested) {
    assert.equal(proof.modelObservationSummary.status, 'unknown', `${label}: the nested fixture must retain an incomplete model proof`);
    assert.equal(proof.modelObservationSummary.observedRunCount < proof.modelObservationSummary.requiredRunCount, true,
      `${label}: the nested fixture must really leave a required run unobserved`);
    assert.ok(proof.modelObservationSummary.requiredRunCount >= 1, `${label}: at least one run identity is required`);
    assert.ok(proof.modelObservationSummary.reasons.length >= 1, `${label}: an unresolved proof names why it is unresolved`);
    assert.equal(documents.config.provider.model, 'unknown', `${label}: the nested fixture declares a provider model it never observed`);
    // The whole terminal provider identity is the one the driver derives from this proof, not just
    // the model label: provenance, status and schema version are the summary's own, so the
    // configuration can never claim an observation its retained evidence does not support.
    assert.equal(documents.config.provider.modelSource, 'unknown',
      `${label}: the nested fixture claims no observed provenance for a model it never read`);
    assert.equal(documents.config.provider.modelObservationStatus, proof.modelObservationSummary.status,
      `${label}: the nested fixture's declared model status is its retained summary's status`);
    assert.equal(documents.config.provider.modelObservationVersion, proof.modelObservationSummary.schemaVersion,
      `${label}: the nested fixture's declared model schema version is its retained summary's version`);
    for (const container of [record.attempt, record.summary]) {
      const where = container === record.attempt ? 'attempt' : 'summary';
      assert.equal(container.provider?.model, 'unknown', `${label}: the retained ${where} provider copy is the same unobserved model identity`);
      assert.equal(container.provider?.modelSource, 'unknown', `${label}: the retained ${where} provider copy claims no observed provenance`);
      assert.equal(container.provider?.modelObservationStatus, proof.modelObservationSummary.status,
        `${label}: the retained ${where} provider status is the retained summary's status`);
      assert.equal(container.provider?.modelObservationVersion, proof.modelObservationSummary.schemaVersion,
        `${label}: the retained ${where} provider schema version is the retained summary's version`);
    }
    assert.equal(record.attempt.fullSuccess, true, `${label}: the nested fixture's workflow really did complete`);
    assert.equal(record.summary.fullSuccess, true, `${label}: the nested fixture's retained summary really did complete`);
  } else {
    // The retained model proof is complete and really observed for the declared model, and the
    // attempt/summary carry the same top-level evidence the production driver retains.
    assert.equal(proof.modelObservationSummary.status, 'observed', `${label}: the fixture must retain a complete observed model proof`);
    assert.equal(proof.modelObservationSummary.model, documents.config.provider.model, `${label}: the observed model is the declared model`);
    assert.equal(proof.modelObservationSummary.observedRunCount, proof.modelObservationSummary.requiredRunCount,
      `${label}: every required run identity is observed`);
    assert.ok(proof.modelObservationSummary.requiredRunCount >= 1, `${label}: at least one run identity is required`);
    assert.deepEqual(proof.modelObservationSummary.reasons, [], `${label}: an observed summary carries no unresolved reason`);
  }
  for (const container of [record.attempt, record.summary]) {
    assert.equal(container.modelObservationSummary?.status, nested ? 'unknown' : 'observed',
      `${label}: the ${container === record.attempt ? 'attempt' : 'summary'} retains the ${nested ? 'incomplete' : 'observed'} model summary`);
    assert.deepEqual(container.modelObservationRequiredRuns, proof.modelObservationRequiredRuns, `${label}: the required run identities are retained verbatim`);
    assert.ok(Array.isArray(container.modelObservations) && container.modelObservations.length === proof.modelObservations.length,
      `${label}: the raw per-run observations are retained`);
  }
  // Both retained family identities are bound to the real Mission, and the terminal attempt
  // really reports the outcome its family entries claim.
  assert.equal(record.attempt.familyOutcomes[0].missionId, MISSION_ID, `${label}: the attempt family outcome is bound to the real Mission`);
  assert.equal(record.summary.summaries[0].missionId, MISSION_ID, `${label}: the summary family identity is bound to the real Mission`);
  assert.equal(record.attempt.phase, 'terminal', `${label}: the retained attempt is terminal`);
  assert.equal(record.attempt.familyOutcomes[0].outcome, record.attempt.outcome, `${label}: the family outcome agrees with the attempt outcome`);
  assert.equal(record.attempt.familyOutcomes[0].fullSuccess, record.attempt.fullSuccess, `${label}: the family full-success flag agrees with the attempt`);
  assert.equal(record.summary.outcome, record.attempt.outcome, `${label}: the summary and the attempt agree on the outcome`);
  // Candidate attribution: the earliest completed candidate's digest and queue request id
  // identify exactly one archived runHistory round, and that round is the audited source.
  const candidates = state.tasks.filter((task) => task.payload?.purpose === 'candidate' && task.status === 'completed');
  assert.ok(candidates.length >= 2, `${label}: the fixture retains the two-round candidate set`);
  const ordered = [...candidates].sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt))
    || String(left.taskId).localeCompare(String(right.taskId)));
  const first = ordered[0];
  const rounds = state.state.runHistory.filter((round) => round.candidateDigest === first.payload.candidate.digest
    && round.queueRequestId === first.payload.requestId);
  assert.equal(rounds.length, 1, `${label}: the earliest completed candidate identifies exactly one archived round`);
  assert.equal(rounds[0].roundId, sourceRound.roundId, `${label}: the archived round is the audited source round`);
  assert.ok(new Set(ordered.map((task) => task.payload.candidate.digest)).size >= 2, `${label}: the completed candidates are distinct`);
  assert.equal(state.state.activeProjectId, PROJECT_ID, `${label}: the raw state names the owning project`);
  // Every task the reader derives metrics from really is a live-GPU producer record with the
  // documented per-profile row shape.
  for (const task of state.tasks) {
    const environment = task.result?.environment;
    assert.equal(environment?.source, 'local-shared-gpu', `${label}: ${task.taskId} is a shared-GPU result`);
    assert.equal(environment?.executionMode, 'gpu', `${label}: ${task.taskId} ran on the GPU path`);
    assert.equal(environment?.liveHardware, true, `${label}: ${task.taskId} carries the live-hardware receipt`);
    assert.equal(environment?.candidateDigest, task.payload.candidate.digest, `${label}: ${task.taskId} keeps the runner's candidate digest`);
    assert.equal(task.resourceRelease?.confirmed, true, `${label}: ${task.taskId} retains a confirmed release`);
    for (const profile of ['primary', 'small']) {
      const row = task.result.benchmark.find((item) => item.profile === profile);
      assert.ok(row, `${label}: ${task.taskId} retains its ${profile} benchmark row`);
      assert.equal(row.unit, 'us', `${label}: ${task.taskId}/${profile} keeps the producer unit`);
      assert.equal(Number.isFinite(row.value), true, `${label}: ${task.taskId}/${profile} keeps the producer value`);
      assert.equal(row.correctness?.passed, true, `${label}: ${task.taskId}/${profile} keeps its correctness receipt`);
    }
  }
  // Snapshot metadata retained in the study audit is the real public snapshot document.
  assert.equal(studyAudit.snapshot.snapshotDigest, snapshot.snapshotDigest, `${label}: the retained snapshot digest is the real one`);
  assert.equal(studyAudit.snapshot.sourceCommit, snapshot.sourceCommit, `${label}: the retained source commit is the real one`);
  assert.equal(studyAudit.snapshot.unitCount, snapshot.units.length, `${label}: the retained unit count is the real one`);
  assert.deepEqual(studyAudit.snapshot.reviewedSm86UnitIds, reviewedSm86UnitIds(snapshot), `${label}: the retained reviewed unit identities are the real ones`);
  assert.ok(studyAudit.snapshot.reviewedSm86UnitIds.length >= 1, `${label}: the snapshot really carries a reviewed sm86 unit`);
  assert.equal(studyAudit.continuationAudit, documents.receipt, `${label}: the retained condition receipt is the pure verifier receipt`);
  assert.equal(record.summary.summaries[0].continuationAudit, documents.receipt, `${label}: the family identity carries that same receipt`);
  // The study audit names the condition the slot really ran. A case that deliberately drifts the
  // retained configuration away from the scheduled condition is exactly the negative this check
  // would otherwise mask, so the config/receipt cross-check is only made on an undrifted slot.
  assert.equal(studyAudit.condition, condition, `${label}: the study audit names the slot's scheduled condition`);
  if (!drifted) {
    assert.equal(documents.config.promptPolicy.experienceCondition, condition, `${label}: the slot configuration carries the scheduled condition`);
    if (documents.receipt.condition !== undefined) {
      assert.equal(documents.receipt.condition, condition, `${label}: the pure receipt names the scheduled condition`);
    }
  }
  // The slot's own smoke report is the documented single-invocation smoke report.
  assert.equal(batch.mode, 'smoke', `${label}: the slot report is a smoke report`);
  assert.deepEqual(batch.families, ['affine']);
  assert.equal(batch.invocations.length, 1, `${label}: the smoke report retains exactly one invocation`);
  assert.equal(batch.invocations[0].index, 0);
  assert.equal(batch.strictN20Passed, false, `${label}: the slot smoke report never claims strict N20`);
  assert.equal(batch.invocations[0].runRoot, documents.runRoot, `${label}: the smoke invocation names this slot's run root`);
};

// One complete slot, written in the frozen layout: A/slot-NN/run-fixture-NN holds the raw
// driver artifacts and R/slot-NN holds the existing smoke report whose single invocation names
// that run root. The default reader must discover and verify all of this by itself.
// `options.config` is merged into the documented study configuration before the record, its
// fingerprint and its model proof are built, so a drift case changes exactly one documented
// field and everything derived from it stays internally consistent (the failure is then the
// drift rule, never a self-contradictory fixture). `options.mutate` is the escape hatch for
// mutations that are not configuration fields (a tampered sidecar, a degraded report).
const materializeSlot = async ({ index, condition, artifactDir, reportDir, snapshot, snapshotFile, options = {} }) => {
  const setupLabel = `slot-${index}-${options.label ?? 'green'}`;
  const built = await setup(setupLabel, { execution: true });
  const { context, selection } = await prepare(built.service, condition);
  const facts = roundFactsFor();
  const runId = `${CONTINUATION_RUN}_${index}`;
  const audit = auditFor({ context, selection, facts, runId });
  const sourceRound = sourceRoundFor(facts);
  const experiences = await recordsOf(built.service);
  const receipt = verifyExperienceConditionAudit({
    condition, audit, sourceRound, experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
  });
  assert.ok(receipt !== null && typeof receipt === 'object', `slot ${index}: the condition receipt must be an object`);
  // The slot records the real digest of the snapshot it was handed, so a green slot can never
  // be read as snapshot drift. Every digest the runner could compare a slot against is therefore
  // the real one, and only a deliberate override below can make them disagree.
  const config = studyConfig(condition, merge({ promptPolicy: { wikiSnapshotDigest: snapshot.snapshotDigest } }, options.config));
  const runRoot = path.join(artifactDir, `run-fixture-${String(index).padStart(2, '0')}`);
  // `smoke: 'nested-noncomparable'` is the frozen nested-exit case: the slot's smoke batch
  // really failed (exit 1, status failed) because the single live driver it invoked completed
  // successfully but its provider model was never observed. The driver still reports a
  // completed full-success attempt; only the comparability verdict is false. The fixture below
  // keeps those two facts distinct instead of collapsing them into one verdict.
  const nested = options.smoke === 'nested-noncomparable';
  const proof = nested ? unknownModelProofFor(runId) : modelProofFor(config.provider.model, runId);
  // An unknown model proof and a configuration that still declares an observed model are two
  // contradictory claims about the same run: the real driver writes the terminal provider
  // identity it derived from the frozen summary, so the nested fixture derives it from its own
  // proof. The fingerprint, the retained attempt/summary provider copies and the ledger verdict
  // below are all recomputed from this configuration, so they stay consistent by construction.
  if (nested) Object.assign(config.provider, unobservedProviderIdentity(proof.modelObservationSummary));
  const record = runRecordFor({
    runRoot, config, label: `${index}`, proof, sourceRound, continuationAudit: receipt,
    outcome: options.smoke === 'failed' ? 'family_failure' : 'full_success',
    fullSuccess: options.smoke !== 'failed',
  });
  const documents = {
    runRoot,
    config,
    proof,
    nestedNonComparable: nested,
    record,
    audit,
    receipt,
    snapshot,
    snapshotFile,
    reportDir,
    artifactDir,
    sourceRound,
    experiences,
    batch: {
      schemaVersion: BATCH_SCHEMA_VERSION,
      mode: 'smoke',
      families: ['affine'],
      requestedRuns: 1,
      startedAt: '2026-09-15T08:00:10.000Z',
      finishedAt: '2026-09-15T08:00:20.000Z',
      // The nested case is a batch whose smoke verdict is failed for a reason that is not a
      // stop: the production batch records exactly this as status failed with a null
      // stopReason, because the run reached full success and only its comparability failed.
      status: options.smoke === 'failed' || nested ? 'failed' : 'passed',
      stopReason: options.smoke === 'failed' ? 'smoke_not_full_success: family_failure' : null,
      strictN20Passed: false,
      invocations: [{
        index: 0,
        status: options.smoke === 'failed' ? 'failed' : 'completed',
        startedAt: '2026-09-15T08:00:10.000Z',
        finishedAt: '2026-09-15T08:00:20.000Z',
        // The invocation exit code is the nested live driver's own exit code. For the nested
        // case it really is zero even though the batch around it failed, which is precisely why
        // the two process layers must never be required to agree.
        exitCode: options.smoke === 'failed' ? 1 : 0,
        signal: null,
        runRoot,
        logPath: path.join(artifactDir, 'logs', `run-${String(index).padStart(2, '0')}.log`),
        outcome: options.smoke === 'failed' ? 'family_failure' : 'full_success',
        comparable: options.smoke !== 'failed' && !nested,
        configFingerprint: null,
        issues: [],
      }],
    },
    state: {
      state: {
        activeMissionId: MISSION_ID,
        // The owning project of the affine Mission: the study reader attributes the slot's
        // raw state through this field, so it is the real project id and not a placeholder.
        activeProjectId: PROJECT_ID,
        stage: 'stopped',
        missionPaused: true,
        iterationStats: { loopStatus: 'stopped', round: 2, experienceCollection: 'collected' },
        agent: {
          runId, missionId: MISSION_ID, status: 'stopped',
          resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
        },
        workflowRecovery: { resourceRelease: { confirmed: true, status: 'confirmed', resources: [] } },
        benchmark: { status: 'idle' },
        runtimeEvents: [{ type: 'workflow.round_rolled_back', payload: { missionId: MISSION_ID, runId, workspaceClean: true } }],
        runHistory: [{
          roundId: SOURCE_ROUND,
          runId: SOURCE_RUN,
          candidateId: CANDIDATE_ID,
          candidateDigest: `sha256:${PATCH_DIGEST}`,
          queueRequestId: QUEUE_REQUEST,
          candidateSourceRunId: SOURCE_RUN,
          decisionReview: { resolution: { outcome: 'reference' } },
          roundFacts: facts,
        }],
      },
      tasks: [
        taskFor({ taskId: 'task-baseline', purpose: 'baseline', completedAt: '2026-09-15T07:50:00.000Z', digestValue: `sha256:${digest('b')}`, queueRequestId: 'queue-baseline', candidateId: 'baseline-01', scale: 1 }),
        taskFor({ taskId: 'task-candidate-01', purpose: 'candidate', completedAt: '2026-09-15T08:00:00.000Z', digestValue: `sha256:${PATCH_DIGEST}`, queueRequestId: QUEUE_REQUEST, candidateId: CANDIDATE_ID, scale: 1 }),
        taskFor({ taskId: 'task-candidate-02', purpose: 'candidate', completedAt: '2026-09-15T08:10:00.000Z', digestValue: `sha256:${digest('e')}`, queueRequestId: 'queue-candidate-02', candidateId: 'candidate-study-02', scale: 0.94 }),
      ],
    },
    studyAudit: {
      schemaVersion: EXPERIENCE_STUDY_SCHEMA_VERSION,
      condition,
      snapshot: {
        path: snapshotFile,
        schemaVersion: snapshot.schemaVersion,
        sourceCommit: snapshot.sourceCommit,
        snapshotDigest: snapshot.snapshotDigest,
        unitCount: snapshot.units.length,
        reviewedSm86UnitIds: reviewedSm86UnitIds(snapshot),
      },
      projectId: PROJECT_ID,
      missionId: MISSION_ID,
      family: 'affine',
      candidate: {
        taskId: 'task-candidate-01', candidateId: CANDIDATE_ID,
        candidateDigest: `sha256:${PATCH_DIGEST}`, queueRequestId: QUEUE_REQUEST,
      },
      import: built.imported.payload,
      continuationAudit: receipt,
    },
    experienceStoreBytes: await readFile(built.repository.path, 'utf8'),
  };
  // The clean construction is checked before any case-specific mutation, so a negative can
  // never be validated on a fixture that was already broken in an unrelated way: the retained
  // records really carry the complete observed-model proof, the Mission-bound family
  // identities, the live-hardware candidate attribution and the real snapshot metadata.
  assertFixtureComplete({ index, documents, snapshot, sourceRound, condition, drifted: options.config !== undefined });
  // A mutation may change any document, including the configuration; the derived identity
  // fields are then recomputed so the fixture stays self-consistent by construction.
  if (typeof options.mutate === 'function') await options.mutate(documents);
  // The retained identity is always recomputed from the configuration the slot actually
  // carries, including the fingerprint's unknown/comparable verdict: a drifted slot must be
  // refused because its own raw evidence says so, never because this fixture hard-coded a
  // verdict that contradicts its own config.
  const identity = buildConfigFingerprint(documents.config, { code: documents.config.code });
  for (const container of [documents.record.attempt, documents.record.summary]) {
    container.configFingerprint = identity.fingerprint;
    container.fingerprintUnknownFields = identity.unknownFields;
    container.comparable = identity.comparable;
  }
  documents.batch.invocations[0].configFingerprint = identity.fingerprint;
  if (nested) {
    // The per-invocation comparability verdict and issue list are taken from the real
    // end-of-batch ledger over the retained raw documents — the same production pure function
    // the smoke batch itself uses — instead of being written by hand. Whatever the case then
    // asserts about the non-comparable failure is the ledger's own verdict, and the fixture's
    // declared evidence and that verdict cannot disagree unless a case deliberately mutates the
    // report after this point.
    const ledger = summarizeAcceptanceRuns([
      { runDir: documents.runRoot, attempt: documents.record.attempt, summary: documents.record.summary },
    ]);
    const entry = (ledger.groups ?? []).flatMap((group) => group.runs ?? []).find((run) => run.index === 0) ?? null;
    assert.ok(entry, `slot ${index}: the nested fixture must be classified by the real acceptance ledger`);
    assert.equal(entry.comparable, false, `slot ${index}: the nested fixture must really be non-comparable`);
    assert.ok(failureOf(entry.comparabilityIssues).includes('provider.model'),
      `slot ${index}: the nested fixture must be refused by the provider.model fingerprint field`);
    // The ledger reads the same derived identity back out of the retained configuration and out
    // of its own fingerprint: the non-comparability is the unobserved model, and the ledger never
    // reports the declared observed model the fixture would otherwise have left behind.
    assert.equal(entry.provider?.model, 'unknown',
      `slot ${index}: the ledger must read the unobserved provider identity from the retained configuration`);
    assert.equal(entry.provider?.modelObservationStatus, documents.proof.modelObservationSummary.status,
      `slot ${index}: the ledger must read the unobserved model status from the retained configuration`);
    assert.ok(failureOf(entry.unknownFields).includes('provider.model'),
      `slot ${index}: the ledger's own unknown-field set must name the unobserved model fingerprint field`);
    documents.batch.invocations[0].comparable = entry.comparable;
    documents.batch.invocations[0].issues = [...new Set([
      ...documents.batch.invocations[0].issues,
      ...failureOf(entry.issues),
      ...failureOf(entry.comparabilityIssues),
      ...failureOf(entry.modelObservationIssues),
    ])];
  }
  // The last word on the retained smoke report, applied after the ledger derived its verdict: a
  // case uses this to state a report that contradicts the raw evidence it retains (a claimed
  // pass, an invented successful invocation). It can never make the fixture self-consistent.
  if (typeof options.batchMutate === 'function') await options.batchMutate(documents);
  if (options.smoke === 'none') return { exitCode: 0, signal: null };
  await writeJson(path.join(reportDir, 'batch.json'), documents.batch);
  await writeJson(path.join(documents.runRoot, 'attempt.json'), documents.record.attempt);
  await writeJson(path.join(documents.runRoot, 'summary.json'), documents.record.summary);
  await writeJson(path.join(documents.runRoot, 'affine-state.json'), documents.state);
  await writeJson(path.join(documents.runRoot, 'bridge', 'prompt-audits', `prepared-before-send-${TARGET_ROUND.replaceAll(':', '-')}.json`), documents.audit);
  await writeJson(path.join(documents.runRoot, 'study-audit.json'), documents.studyAudit);
  await mkdir(path.join(documents.runRoot, 'runtime', 'experiences'), { recursive: true });
  await writeFile(path.join(documents.runRoot, 'runtime', 'experiences', 'experiences.json'), documents.experienceStoreBytes, 'utf8');
  await mkdir(path.join(artifactDir, 'logs'), { recursive: true });
  await writeFile(documents.batch.invocations[0].logPath, `[study-fixture] slot ${index} ${condition}: no live child was started.\n`, 'utf8');
  await writeFile(path.join(documents.runRoot, 'runtime.log'), `[study-fixture] slot ${index}: in-memory fixture log.\n`, 'utf8');
  // The exit code the RUNNER sees is the smoke BATCH child's own exit code, which is a
  // different thing from the nested live driver's exit code recorded inside batch.json. The
  // nested case is exactly the truthful failure where the two disagree: the batch around the
  // run failed (exit 1) although the driver it invoked completed with exit 0.
  return { exitCode: options.smoke === 'failed' || nested ? 1 : 0, signal: null, runRoot };
};

// --- runner fixture directories ----------------------------------------------------------

const studyDirs = async (label, snapshot) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `operator-study-run-${label}-`));
  roots.push(root);
  const artifactDir = path.join(root, 'artifacts');
  const reportDir = path.join(root, 'report');
  const snapshotFile = path.join(root, 'wiki-snapshot.json');
  const gpuPython = path.join(root, 'python.exe');
  await mkdir(artifactDir, { recursive: true });
  await writeJson(snapshotFile, snapshot);
  await writeFile(gpuPython, '', 'utf8');
  const argv = ['--snapshot', snapshotFile, '--artifact-dir', artifactDir, '--report-dir', reportDir, '--gpu-python', gpuPython];
  return { root, artifactDir, reportDir, snapshotFile, gpuPython, argv };
};
const readStudyJson = async (reportDir) => JSON.parse(await readFile(path.join(reportDir, 'study.json'), 'utf8'));
// Parse and run in one step: a refusal raised while parsing the argument list is an outcome of
// the case, not a harness error, so the assertions below always report what really happened.
const attemptStudy = async (argv, ports) => {
  try {
    return await runExperienceStudy(parseStudyArguments(argv), ports);
  } catch (error) {
    return error;
  }
};
// The retained schedule and the retained invocation identities are read from the two frozen
// public keys of study.json (`schedule`, `invocations`). A shape-recursive search is never used:
// it would also accept a nested copy of the same array and could not tell a real second array
// from a duplicate, so it could not prove "one schedule and no tenth sample" at all.
const retainedSchedule = (document) => {
  const schedule = requiredField(document, 'schedule', 'the retained study report');
  assert.ok(Array.isArray(schedule), 'the retained schedule must be an array');
  assert.equal(schedule.length, FROZEN_SCHEDULE.length, 'the retained schedule must carry exactly the nine frozen slots');
  const slots = schedule.map((slot) => {
    assert.ok(slot && typeof slot === 'object' && !Array.isArray(slot), 'a retained schedule slot must be an object');
    assert.ok(Number.isInteger(slot.index) && Number.isInteger(slot.block), 'a retained schedule slot keeps its integer index/block');
    assert.ok(typeof slot.condition === 'string', 'a retained schedule slot names its condition');
    return { index: slot.index, block: slot.block, condition: slot.condition };
  });
  assert.deepEqual(slots, FROZEN_SCHEDULE, 'the retained schedule must be the frozen balanced condition order');
  return slots;
};
const retainedInvocations = (document) => {
  const invocations = requiredField(document, 'invocations', 'the retained study report');
  assert.ok(Array.isArray(invocations), 'the retained invocations must be an array');
  assert.equal(invocations.length, FROZEN_SCHEDULE.length, 'the retained report carries exactly the nine scheduled slots: no replacement and no tenth sample');
  const identities = invocations.map((invocation) => {
    assert.ok(invocation && typeof invocation === 'object' && !Array.isArray(invocation), 'a retained invocation must be an object');
    assert.ok(Number.isInteger(invocation.index), 'a retained invocation carries its integer index');
    assert.ok(Number.isInteger(invocation.block), 'a retained invocation carries its integer block');
    assert.ok(typeof invocation.condition === 'string', 'a retained invocation names its condition');
    return { index: invocation.index, block: invocation.block, condition: invocation.condition };
  });
  assert.deepEqual(identities, FROZEN_SCHEDULE, 'the retained invocations keep the frozen slot identities in order');
  assert.equal(new Set(identities.map((slot) => slot.index)).size, FROZEN_SCHEDULE.length, 'every retained slot index is unique');
  for (const slot of identities) {
    assert.equal(slot.condition, FROZEN_SCHEDULE[slot.index - 1].condition, `slot ${slot.index} keeps its scheduled condition`);
    assert.equal(slot.block, FROZEN_SCHEDULE[slot.index - 1].block, `slot ${slot.index} keeps its scheduled block`);
  }
  return invocations;
};
// Recursive content identity of a retained directory: used to prove the report reader and the
// --verify-report CLI mode are read-only instead of trusting a self-reported flag.
const treeIdentity = async (target) => {
  if (!existsSync(target)) return null;
  const info = await stat(target);
  if (!info.isDirectory()) return `${path.basename(target)}:${await fileDigest(target)}`;
  const entries = [];
  const walk = async (current, prefix) => {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, item.name);
      const relative = `${prefix}${item.name}`;
      if (item.isDirectory()) {
        entries.push(`${relative}/`);
        await walk(full, `${relative}/`);
      } else {
        entries.push(`${relative}:${await fileDigest(full)}`);
      }
    }
  };
  await walk(target, '');
  return entries.join('\n');
};
const acceptedSnapshotValue = (value, { snapshotFile, snapshot }) => {
  if (typeof value === 'string') return value === snapshotFile;
  if (value && typeof value === 'object') {
    return value.sourceCommit === snapshot.sourceCommit && value.snapshotDigest === snapshot.snapshotDigest;
  }
  return false;
};
const slotSummary = (invocation) => ({
  index: invocation?.index, condition: invocation?.condition,
  artifactDir: invocation?.artifactDir, reportDir: invocation?.reportDir,
  snapshot: invocation?.snapshot, gpuPython: invocation?.gpuPython,
});
// Slot directories are per-invocation work directories: every slot works in its own
// `slot-NN` directory directly under the study root, never in the study's own top-level
// directory and never in another slot's directory.
const assertExclusiveSlotDirs = (slot, dirs, label) => {
  assert.ok(Number.isInteger(slot.index), `${label}: a slot must carry its integer index`);
  const slotPattern = new RegExp(`^slot-0*${slot.index}$`);
  const artifact = path.resolve(slot.artifactDir);
  const report = path.resolve(slot.reportDir);
  assert.ok(slotPattern.test(path.basename(artifact)), `${label}: the slot artifact directory must be the slot's own slot-NN directory, saw ${artifact}`);
  assert.equal(path.dirname(artifact), path.resolve(dirs.artifactDir), `${label}: the slot artifact directory belongs to the study artifact root`);
  assert.ok(slotPattern.test(path.basename(report)), `${label}: the slot report directory must be the slot's own slot-NN directory, saw ${report}`);
  assert.equal(path.dirname(report), path.resolve(dirs.reportDir), `${label}: the slot report directory belongs to the study report root`);
  assert.notEqual(artifact, path.resolve(dirs.artifactDir), `${label}: a slot artifact directory is not the study artifact root`);
  assert.notEqual(report, path.resolve(dirs.reportDir), `${label}: a slot report directory is not the study report root`);
  assert.notEqual(artifact, report, `${label}: a slot keeps its raw artifacts and its report apart`);
  const overlaps = (left, right) => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
  assert.equal(overlaps(artifact, report), false, `${label}: slot directories must not overlap`);
  assert.notEqual(artifact, path.resolve(dirs.snapshotFile), `${label}: the slot never writes over the snapshot`);
};
// Every string retained anywhere under a report tree, so a recorded stop reason can be
// asserted without guessing the envelope key it is wrapped in.
const collectStrings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
};
const retainedStrings = async (target, out = []) => {
  if (!existsSync(target)) return out;
  const info = await stat(target);
  if (!info.isDirectory()) {
    const text = await readFile(target, 'utf8').catch(() => '');
    out.push(text);
    try { collectStrings(JSON.parse(text), out); } catch { /* raw log or non-JSON stays text */ }
    return out;
  }
  for (const item of await readdir(target, { withFileTypes: true })) {
    await retainedStrings(path.join(target, item.name), out);
  }
  return out;
};
// The per-slot study verdict, read from the retained report rather than from free text: the
// frozen contract fixes `issues` as the per-slot reason array and `stopReason` as
// 'slot_N: ' + that slot's issues.
const invocationOf = (document, index) => {
  const invocations = Array.isArray(document?.invocations) ? document.invocations : [];
  const match = invocations.find((item) => item.index === index);
  assert.ok(match, `the retained report must carry invocation ${index}`);
  return match;
};
const issuesOf = (document, index) => failureOf(invocationOf(document, index).issues ?? invocationOf(document, index).failureIssues);
// `reason` is the documented prefix that must be the slot's failure reason; `unrelated` lists
// prefixes that must NOT be present, so a generic stop can never satisfy a targeted case.
const assertSlotStoppedFor = (document, index, { reason, unrelated = [] }, label) => {
  const issues = issuesOf(document, index);
  assert.ok(issues.length > 0, `${label}: slot ${index} must retain its failure issues`);
  assert.ok(issues.some((issue) => reason.test(issue)), `${label}: slot ${index} must stop for ${reason}, saw ${JSON.stringify(issues)}`);
  for (const pattern of unrelated) {
    assert.equal(issues.some((issue) => pattern.test(issue)), false,
      `${label}: slot ${index} must not stop for the unrelated ${pattern}, saw ${JSON.stringify(issues)}`);
  }
  assert.ok(STOP_PREFIXES.some((prefix) => issues.some((issue) => issue.startsWith(prefix))),
    `${label}: slot ${index} must use a frozen stop prefix, saw ${JSON.stringify(issues)}`);
  const stopReason = String(document.stopReason ?? '');
  assert.ok(stopReason.startsWith(`slot_${index}: `), `${label}: stopReason must name the first failing slot, saw ${JSON.stringify(stopReason)}`);
};
// A complete, internally consistent run record built from the documented readRunRecord DTO
// plus the study prompt policy: only the invocation's own configuration changes per slot.
const studyConfig = (condition, overrides = {}) => merge({
  provider: {
    runtime: 'claude-code', cliVersion: '1.2.3', cliVersionSource: 'runtime-descriptor',
    model: OBSERVED_MODEL, modelSource: 'observed',
    modelObservationStatus: 'observed', modelObservationVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
  },
  backend: { kind: 'local-shared-gpu', executionMode: 'gpu', publishable: false },
  hardware: ['nvidia-gpu'], architecture: ['sm86'],
  device: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '555.99',
  families: ['affine'], candidateTasks: 2,
  matrix: { environments: ['local-shared-gpu'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 4, warmup: 3, repeats: 10 },
  promptPolicy: {
    experienceSelectionPolicyVersion: WIKI_SELECTION_POLICY_VERSION,
    roundFactsSchemaVersion: ROUND_FACTS_SCHEMA_VERSION,
    experienceCondition: condition,
    wikiSnapshotDigest: SNAPSHOT_DIGEST,
    studyGoalPolicyVersion: STUDY_GOAL_POLICY_VERSION,
  },
  budgets: { missionBudgetMs: 720_000, mainAgentBudgetMs: 180_000 },
  code: { commit: 'a'.repeat(40), dirty: false, contentDigest: `sha256:${'b'.repeat(64)}` },
}, overrides);

// --- per-case green fixtures --------------------------------------------------------------

// Build one complete green nine-slot study and prove THIS fixture verifies, on its own bytes,
// before anything else happens to it. Nothing is copied, repointed or cached: a negative
// mutates the fixture it just proved green, so it can never be validated on a layout that was
// already wrong, and a failed positive can never be inherited by a later case.
const freshStudy = async (label, { options = {} } = {}) => {
  const snapshot = snapshotFor();
  const dirs = await studyDirs(label, snapshot);
  const calls = [];
  const outcome = await attemptStudy(dirs.argv, {
    invokeSmoke: async (invocation) => {
      calls.push(slotSummary(invocation));
      return materializeSlot({
        index: invocation.index, condition: invocation.condition,
        artifactDir: invocation.artifactDir, reportDir: invocation.reportDir,
        snapshot, snapshotFile: dirs.snapshotFile, options: { label: 'green', ...options },
      });
    },
  });
  assert.equal(outcome instanceof Error, false, `${label}: the fixture study must run to a stopped/completed result: ${outcome?.message ?? ''}`);
  const document = await readStudyJson(dirs.reportDir);
  retainedSchedule(document);
  retainedInvocations(document);
  for (const slot of FROZEN_SCHEDULE) {
    const invocation = invocationOf(document, slot.index);
    assert.equal(invocation.status, 'completed', `${label}: slot ${slot.index} must be completed in the clean fixture`);
    assert.equal(invocation.exitCode, 0, `${label}: slot ${slot.index} must have exited zero in the clean fixture`);
    assert.equal(invocation.condition, slot.condition, `${label}: slot ${slot.index} keeps its frozen condition in the clean fixture`);
    assert.deepEqual(failureOf(invocation.issues).filter((issue) => issue !== 'study_stopped'), [],
      `${label}: slot ${slot.index} retains no failure issue in the clean fixture`);
  }
  const receipt = await verifyStudyReport(dirs.reportDir);
  assert.equal(receipt.ok, true, `${label}: the clean fixture must verify on its own bytes`);
  assertAllSlotsCompleted(receipt, 9, label);
  assert.equal(verifiedSlotsOf(receipt, document, label).length, 9, `${label}: the clean fixture verifies all nine retained slots`);
  return { dirs, snapshot, calls, outcome, document, receipt };
};
const readReport = async (reportDir) => JSON.parse(await readFile(path.join(reportDir, 'study.json'), 'utf8'));
const writeReport = async (reportDir, document) => writeJson(path.join(reportDir, 'study.json'), document);
// A reader negative: a fresh green fixture is generated and verified, then exactly one
// document/field is mutated in place. The reader must refuse it, and the refusal must leave
// every retained byte — report and raw artifacts — exactly as the tamper left them.
const readerRejects = async (label, tamper) => {
  const { dirs, receipt } = await freshStudy(`reader-${label}`);
  assert.equal(receipt.ok, true, `${label}: this fixture verified before the tamper`);
  assertAllSlotsCompleted(receipt, 9, label);
  assert.equal(countOf(receipt.verifiedSlots), 9, `${label}: this fixture verified all nine retained slots before the tamper`);
  const cleanReport = await treeIdentity(dirs.reportDir);
  const cleanArtifacts = await treeIdentity(dirs.artifactDir);
  const targets = await tamper({ reportDir: dirs.reportDir, artifactDir: dirs.artifactDir, dirs });
  const tamperedReport = await treeIdentity(dirs.reportDir);
  const tamperedArtifacts = await treeIdentity(dirs.artifactDir);
  // Some negatives retype a report field, others rewrite a raw original: either way the
  // retained bytes must really have changed, so a passing refusal is never vacuous.
  assert.notEqual(`${tamperedReport}\u0000${tamperedArtifacts}`, `${cleanReport}\u0000${cleanArtifacts}`,
    `${label}: the tamper must really change the retained report or its raw originals`);
  await assert.rejects(() => verifyStudyReport(dirs.reportDir), Error, `${label}: the reader must refuse this report`);
  assert.equal(await treeIdentity(dirs.reportDir), tamperedReport, `${label}: a refusing reader rewrites no report byte`);
  assert.equal(await treeIdentity(dirs.artifactDir), tamperedArtifacts, `${label}: a refusing reader rewrites no raw artifact byte`);
  for (const target of targets ?? []) {
    assert.equal(existsSync(target), true, `${label}: the tampered original stays on disk for review`);
  }
};
const requiredField = (container, key, label) => {
  assert.ok(container && typeof container === 'object' && !Array.isArray(container)
    && Object.hasOwn(container, key), `${label}: the retained report must carry ${key} (saw ${container ? Object.keys(container).join(', ') : typeof container})`);
  return container[key];
};
// The verified receipt carries two different things and they must never be conflated:
// `slotCounts` is the actual outcome histogram of the retained slots, while `verifiedSlots`
// is the reader's per-slot verification coverage over that same report. A faithful report
// verifies every slot it retains — completed, failed and stopped alike — so
// `verifiedSlots.length` is coverage, never a success count, and `ok: true` only means the
// report was faithfully verified, never that the study succeeded.
const slotCountsOf = (receipt, label) => {
  const counts = requiredField(receipt, 'slotCounts', label);
  assert.ok(counts && typeof counts === 'object' && !Array.isArray(counts), `${label}: the reader receipt must carry its slot outcome histogram`);
  return counts;
};
const assertAllSlotsCompleted = (receipt, count, label) => {
  const counts = slotCountsOf(receipt, label);
  assert.equal(counts.completed, count, `${label}: every retained slot really completed in this fixture`);
  for (const status of ['failed', 'stopped']) {
    assert.equal(counts[status] ?? 0, 0, `${label}: a completed fixture retains no ${status} slot`);
  }
};
const verifiedSlotsOf = (receipt, document, label) => {
  const slots = requiredField(receipt, 'verifiedSlots', label);
  assert.ok(Array.isArray(slots), `${label}: verifiedSlots must be an array`);
  const entries = slots.map((slot) => {
    assert.ok(slot && typeof slot === 'object' && !Array.isArray(slot), `${label}: a verified slot must be an object`);
    assert.ok(Number.isInteger(slot.index), `${label}: a verified slot keeps its integer index`);
    assert.ok(typeof slot.status === 'string', `${label}: a verified slot keeps its retained status`);
    return { index: slot.index, status: slot.status };
  });
  // The contract does not freeze the receipt's array order, so the mapping is asserted as a
  // set: every frozen slot index appears exactly once and nothing else does.
  assert.deepEqual(entries.map((entry) => entry.index).sort((left, right) => left - right),
    FROZEN_SCHEDULE.map((slot) => slot.index),
    `${label}: every retained slot index is verified exactly once`);
  for (const entry of entries) {
    assert.equal(entry.status, invocationOf(document, entry.index).status,
      `${label}: verified slot ${entry.index} must report the status the retained report really carries`);
  }
  return entries;
};
// The seven frozen originals live under two public roots: the slot's own smoke report
// (`batchReport`) under the slot report root, and every raw driver artifact under the slot
// artifact root. Each role is checked against the root it really belongs to, so a negative
// that only checked "under the artifact root" would wrongly reject the report original and a
// negative that checked nothing could accept a path borrowed from another slot.
const assertOriginalRoot = (entry, { reportDir, artifactDir }, label) => {
  assert.ok(entry && typeof entry === 'object', `${label}: a recorded original must be an object`);
  const root = entry.role === 'batchReport' ? reportDir : artifactDir;
  assert.ok(ORIGINAL_ROLES.includes(entry.role), `${label}: ${entry.role} is a frozen original role`);
  assert.equal(path.resolve(entry.path).startsWith(`${path.resolve(root)}${path.sep}`), true,
    `${label}: the ${entry.role} original must live under its own ${entry.role === 'batchReport' ? 'report' : 'artifact'} root, saw ${entry.path}`);
  return entry;
};

// One drift sub-case, owned by the study-matrix group but reported as its own independent case:
// every drifted field builds its own green fixture and its own PASS/FAIL line, so a failure in
// one drift branch can never mask the later ones and every failure still accumulates into the
// process exit code. Slot one is a complete, comparable `full_success` whose release is
// confirmed, and slot two is that same invocation with exactly one documented field changed.
// The first slot must therefore be followed by a second spawn, the drifted second slot must be
// released for the targeted reason, and the remaining seven slots must never start: nothing is
// replaced or silently completed. `expectedExitCode` is the real exit code of the drifted slot's
// own smoke child, so a case states it per scenario instead of assuming the green zero: a
// configuration or observation drift keeps the zero, while a released non-full-success slot
// keeps its actual non-zero exit and its failed evidence instead of being minted into a pass.
const runDriftCase = async ({ label, snapshot, options, reason, unrelated = [], expectedExitCode = 0 }) => {
  const dirs = await studyDirs(label, snapshot);
  const spawned = [];
  const outcome = await attemptStudy(dirs.argv, {
    invokeSmoke: async (invocation) => {
      spawned.push(slotSummary(invocation));
      return materializeSlot({
        index: invocation.index, condition: invocation.condition,
        artifactDir: invocation.artifactDir, reportDir: invocation.reportDir,
        snapshot, snapshotFile: dirs.snapshotFile,
        options: invocation.index === 2 ? { label, ...options } : { label: 'green' },
      });
    },
  });
  assert.equal(outcome instanceof Error, false, `${label}: a drifted slot is a stopped study, not a harness error: ${outcome?.message ?? ''}`);
  assert.deepEqual(spawned.map((slot) => slot.index), [1, 2],
    `${label}: the first slot must succeed before the drifted second slot is released (started ${spawned.map((slot) => slot.index).join(',')})`);
  assertExclusiveSlotDirs(spawned[0], dirs, `${label} slot 1`);
  assertExclusiveSlotDirs(spawned[1], dirs, `${label} slot 2`);
  assert.equal(new Set(spawned.map((slot) => path.resolve(slot.artifactDir))).size, 2, `${label}: both slots keep their own artifact directory`);
  assert.equal(new Set(spawned.map((slot) => path.resolve(slot.reportDir))).size, 2, `${label}: both slots keep their own report directory`);
  // The drifted slot's own smoke report is retained on disk as the released evidence of the
  // stop: the actual exit code, the failed status and the non-full-success outcome stay as the
  // slot really reported them and are never rewritten into a pass after the stop.
  const releasedBatch = JSON.parse(await readFile(path.join(spawned[1].reportDir, 'batch.json'), 'utf8'));
  assert.equal(releasedBatch.invocations[0].exitCode, expectedExitCode,
    `${label}: the released slot's own smoke report keeps its actual exit code (${expectedExitCode})`);
  assert.equal(releasedBatch.strictN20Passed, false, `${label}: a released slot's smoke report never claims strict N20`);
  if (expectedExitCode !== 0) {
    assert.equal(releasedBatch.status, 'failed', `${label}: the released slot's smoke report retains its failed status`);
    assert.equal(releasedBatch.invocations[0].status, 'failed', `${label}: the released slot's smoke invocation retains its failed status`);
    assert.notEqual(releasedBatch.invocations[0].outcome, 'full_success', `${label}: a non-zero slot is never retained as a full success`);
  }
  const retained = await readStudyJson(dirs.reportDir);
  // The first slot really succeeded and was retained as such, so the stop below is caused
  // by the single mutation and not by a broken green fixture.
  assert.equal(invocationOf(retained, 1).status, 'completed', `${label}: the first slot is retained as a completed invocation`);
  assert.equal(invocationOf(retained, 1).exitCode, 0, `${label}: the first slot really exited zero`);
  assert.equal(invocationOf(retained, 2).status, 'failed', `${label}: the drifted slot is retained as a failure`);
  assertSlotStoppedFor(retained, 2, { reason, unrelated }, label);
  assert.equal(invocationOf(retained, 2).exitCode, expectedExitCode,
    `${label}: the retained drifted slot keeps the actual exit code of its own smoke child (${expectedExitCode})`);
  for (const slot of FROZEN_SCHEDULE.slice(2)) {
    assert.deepEqual(issuesOf(retained, slot.index), ['study_stopped'], `${label}: slot ${slot.index} must never start after the stop`);
    assert.equal(invocationOf(retained, slot.index).status, 'stopped', `${label}: slot ${slot.index} must stay an explicit stopped slot`);
  }
  assert.deepEqual(retainedSchedule(retained), FROZEN_SCHEDULE, `${label}: the retained schedule is still the frozen nine slots`);
  retainedInvocations(retained);
  const strings = await retainedStrings(dirs.reportDir);
  assert.ok(strings.some((text) => /"strictN20Passed"\s*:\s*false/.test(text)), `${label}: the retained report always reports strictN20Passed=false`);
  // The stopped report is still faithfully verifiable by the public reader; a drift report
  // is a real reviewable outcome and never an unreadable one.
  const receipt = await verifyStudyReport(dirs.reportDir);
  assert.equal(receipt.ok, true, `${label}: a genuinely drifted report must still verify`);
  assert.equal(receipt.status, 'stopped', `${label}: a drifted report is retained as stopped`);
  assert.equal(receipt.strictN20Passed, false, `${label}: a drifted report never claims the strict N20 rule`);
  // The reader verifies the retained report faithfully, not "the successful slots": the
  // actual outcome histogram is one completed, one failed and the seven stopped slots,
  // and every one of them is verified with the status the report really retains. Its
  // length is therefore coverage of the nine-slot schedule, never a count of successes.
  assert.deepEqual(slotCountsOf(receipt, label), { completed: 1, failed: 1, stopped: 7 },
    `${label}: the reader receipt must carry the actual outcome histogram of the released study`);
  const verified = verifiedSlotsOf(receipt, retained, label);
  assert.equal(verified.length, FROZEN_SCHEDULE.length,
    `${label}: every retained slot is verified, including the failed and the stopped ones`);
  assert.equal(verified.filter((slot) => slot.status === 'completed').length, 1,
    `${label}: exactly the retained first slot counts as completed`);
  return dirs;
};
// The drifted field of each sub-case, in the frozen stop vocabulary, one independent case each.
// `reason` is the documented prefix that must be the slot's real failure reason and
// `unrelated` names the prefixes that must NOT be it, so an unrelated generic stop can never
// satisfy a targeted case. Where a raw-artifact invalidation could stand in for the targeted
// rule it is listed as unrelated, so a configuration or observation drift is never accepted
// as "the evidence was unreadable".
const DRIFT_CASES = [
  {
    label: 'config-source',
    description: 'source drift in the second slot stops the study and leaves the remaining seven stopped',
    // Source drift: the retained configuration describes different source bytes.
    options: { config: { code: { contentDigest: `sha256:${'1'.repeat(64)}` } } },
    reason: /source_or_config_drift/,
    unrelated: [/observed_model_drift/, /not_full_success/, /smoke_exit_code/],
  },
  {
    label: 'config-budget',
    description: 'budget drift in the second slot stops the study and leaves the remaining seven stopped',
    // Budget drift: the second slot ran under different budgets, so it is a different design.
    options: { config: { budgets: { mainAgentBudgetMs: 240_000 } } },
    reason: /source_or_config_drift|shared_design_identity_drift/,
    unrelated: [/observed_model_drift/, /not_full_success/, /smoke_exit_code/],
  },
  {
    label: 'config-model',
    description: 'observed model drift in the second slot stops the study and leaves the remaining seven stopped',
    // Model drift: the actually observed provider model differs from the study's observation.
    // The model proof is rebuilt for the drifted label, so the slot is a genuinely observing
    // run that reports another model.
    options: { config: { provider: { model: DIFFERENT_MODEL } } },
    reason: /observed_model_drift/,
    unrelated: [/source_or_config_drift/, /not_full_success/, /smoke_exit_code/, /raw_evidence_invalid/],
  },
  {
    label: 'config-snapshot',
    description: 'snapshot drift in the retained second-slot configuration stops the study',
    // Snapshot drift: only the retained configuration names a different Wiki snapshot digest
    // while the raw snapshot original itself is untouched, so the refusal is the configuration
    // mismatch against the declared snapshot identity (with the shared design identity drift
    // it implies) and NOT a raw-evidence invalidation, which is refused here.
    options: { config: { promptPolicy: { wikiSnapshotDigest: `sha256:${'e'.repeat(64)}` } } },
    reason: /^study_config_mismatch: wikiSnapshotDigest\b/,
    unrelated: [/observed_model_drift/, /not_full_success/, /smoke_exit_code/, /raw_evidence_invalid/],
  },
  {
    label: 'config-condition',
    description: 'condition mismatch in the second slot stops the study and leaves the remaining seven stopped',
    // Condition mismatch: the slot really ran under a different explicit condition than the
    // schedule assigned it, while its receipt still names the scheduled one.
    options: { config: { promptPolicy: { experienceCondition: 'facts-only' } } },
    reason: /condition_mismatch|study_config_mismatch|standard_fingerprint_not_comparable/,
    unrelated: [/observed_model_drift/, /not_full_success/, /smoke_exit_code/],
  },
  {
    label: 'config-policy',
    description: 'selection-policy drift in the second slot stops the study and leaves the remaining seven stopped',
    // Policy drift: the slot stamped the obsolete retrieve-only policy constant instead of the
    // production D policy, so the policy field really enters the design from the raw artifacts.
    options: { config: { promptPolicy: { experienceSelectionPolicyVersion: EXPERIENCE_SELECTION_POLICY_VERSION } } },
    reason: /source_or_config_drift|shared_design_identity_drift|standard_fingerprint_not_comparable/,
    unrelated: [/observed_model_drift/, /not_full_success/, /smoke_exit_code/],
  },
  {
    label: 'unknown-model',
    description: 'an unknown model observation in the second slot stops the study as not comparable',
    // Unknown observation: the model was not fully observed, so the slot is not comparable and
    // the study must not continue. Every other field is the green one, so this cannot stop for
    // a source/config drift or for a released/non-zero-exit slot.
    // The frozen reader compares the declared unknown observation against the retained
    // reference model, so its `observed_model_missing` verdict may legitimately come with the
    // companion `observed_model_drift` error derived from the same null observed model. That
    // companion is part of the rule under test and must not be listed as unrelated; the
    // target branch itself is still asserted through `observed_model_missing` (or the
    // not-comparable fingerprint verdict), never a generic stop. Unrelated raw-artifact
    // errors stay refused: only the model-observation branch may be reported here.
    options: { config: { provider: { modelObservationStatus: 'unknown' } } },
    reason: /standard_fingerprint_not_comparable|observed_model_missing/,
    unrelated: [/source_or_config_drift/, /not_full_success/, /smoke_exit_code/, /raw_evidence_invalid/],
  },
  {
    label: 'released-failure',
    description: 'a released non-full-success second slot stops the study with its real non-zero exit retained',
    // Non-full-success release: the slot terminated without full success and its own smoke child
    // really exited non-zero, so the case requires that exact exit code and the exact
    // `smoke_exit_code:1` verdict instead of the green zero. The smoke report it retains on disk
    // already records the failure, so this is neither a fixture success nor a cancellation.
    options: { smoke: 'failed' },
    reason: /^smoke_exit_code:1\b/,
    unrelated: [/observed_model_drift/, /source_or_config_drift/],
    expectedExitCode: 1,
  },
];

try {
  await test('matrix 11a: the frozen schedule is exactly nine balanced slots in the frozen block order', async () => {
    assert.equal(EXPERIENCE_STUDY_SCHEMA_VERSION, 'operator-studio.experience-condition-study/v1');
    assert.deepEqual([...EXPERIENCE_CONDITIONS], ['facts-only', 'local-only', 'local-and-wiki'],
      'the condition enum is frozen in order');
    const schedule = buildStudySchedule();
    assert.deepEqual(schedule, FROZEN_SCHEDULE, 'the schedule is the frozen nine-slot matrix');
    assert.deepEqual(buildStudySchedule(), FROZEN_SCHEDULE, 'the schedule is deterministic');
    assert.equal(schedule.length, 9);
    for (const condition of EXPERIENCE_CONDITIONS) {
      assert.equal(schedule.filter((slot) => slot.condition === condition).length, 3, `${condition} keeps three independent slots`);
    }
    for (const block of [1, 2, 3]) assert.equal(schedule.filter((slot) => slot.block === block).length, 3);
  });

  await test('matrix 9: facts-only verifies real zero items with complete facts and collected source experience', async () => {
    const facts = roundFactsFor();
    const { service, snapshot } = await setup('facts-only', { execution: true });
    const { context, selection } = await prepare(service, 'facts-only');
    assert.deepEqual(context.items, [], 'facts-only injects no optional experience');
    assert.deepEqual(selection.selected, [], 'facts-only records zero selected entries');
    assert.equal(selection.experienceCondition, 'facts-only', 'the audit records the exact explicit condition');
    const audit = auditFor({ context, selection, facts });
    const experiences = await recordsOf(service);
    assert.equal(experiences.filter((item) => item.source === 'execution').length, 1, 'the source-round execution experience is durably collected');

    // The factored common facts checks stay mandatory in facts-only mode; the retained strict
    // verifier must still never pass a facts-only prompt.
    const factsReceipt = verifyRoundFactsAudit({ audit, sourceRound: sourceRoundFor(facts), missionId: MISSION_ID, projectId: PROJECT_ID });
    assert.ok(factsReceipt !== null && typeof factsReceipt === 'object', 'the factored facts verifier returns a receipt');
    assert.throws(() => verifyContinuationAudit({ audit, sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID }),
      'facts-only must never satisfy the retained default continuation verifier');
    verifyCondition({ condition: 'facts-only', audit, sourceRound: sourceRoundFor(facts), experiences, snapshot });

    // Lost mandatory facts: the archive no longer carries the frozen facts the audit claims.
    const lostFacts = structuredClone(sourceRoundFor(facts));
    delete lostFacts.roundFacts.rollback;
    expectRejected('facts-only with a lost mandatory round fact', () => verifyExperienceConditionAudit({
      condition: 'facts-only', audit, sourceRound: lostFacts, experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // Tampered prompt digest: the sidecar is not trusted over the real prompt bytes.
    const tamperedDigest = { ...audit, promptDigest: `sha256:${digest('0')}` };
    expectRejected('facts-only with a tampered prompt digest', () => verifyExperienceConditionAudit({
      condition: 'facts-only', audit: tamperedDigest, sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // Sidecar mismatch: the selection sidecar no longer describes the audited prompt context.
    const mismatchedSidecar = { ...structuredClone(selection), contextId: `EXPCTX_${'9'.repeat(64)}` };
    expectRejected('facts-only with a selection sidecar that does not describe the prompt', () => verifyExperienceConditionAudit({
      condition: 'facts-only', audit: { ...audit, selection: mismatchedSidecar }, sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // Sidecar/condition disagreement: the frozen explicit condition is part of the receipt.
    expectRejected('facts-only audit verified under a different condition', () => verifyExperienceConditionAudit({
      condition: 'local-only', audit, sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // Non-empty injected items: facts-only is zero items, not "zero after ranking".
    const injected = withExperienceBlock(audit.prompt, (block) => {
      block.items = [experiences.find((item) => item.source === 'human')];
      block.versions = { [block.items[0].id]: block.items[0].version };
    });
    expectRejected('facts-only prompt that actually injects an optional record', () => verifyExperienceConditionAudit({
      condition: 'facts-only', audit: tamperedAudit(audit, injected), sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));

    // Without the durably collected source-round execution experience the receipt is refused
    // even though the injected set is legitimately empty.
    const uncollected = await setup('facts-only-uncollected', { execution: false });
    const uncollectedPrepared = await prepare(uncollected.service, 'facts-only');
    const uncollectedExperiences = await recordsOf(uncollected.service);
    assert.equal(uncollectedExperiences.filter((item) => item.source === 'execution').length, 0, 'the source-round execution experience was never collected in this fixture');
    expectRejected('facts-only without the collected source-round execution experience', () => verifyExperienceConditionAudit({
      condition: 'facts-only',
      audit: auditFor({ context: uncollectedPrepared.context, selection: uncollectedPrepared.selection, facts }),
      sourceRound: sourceRoundFor(facts),
      experiences: uncollectedExperiences,
      missionId: MISSION_ID, projectId: PROJECT_ID, snapshot: uncollected.snapshot,
    }));
  });

  await test('matrix 10: local-only rejects Wiki contamination and local-and-wiki requires a reviewed matching unit', async () => {
    const facts = roundFactsFor();
    const { service, snapshot } = await setup('wiki-modes', { execution: true });
    const experiences = await recordsOf(service);
    const wikiRecord = experiences.find((item) => item.selectionMetadata?.source === 'kernel-wiki');
    assert.ok(wikiRecord, 'the reviewed sm86 Wiki unit is imported as a real record');

    // local-only keeps applicable local execution guidance and never injects a Wiki unit.
    const local = await prepare(service, 'local-only');
    assert.equal(wikiItems(local.context.items).length, 0, 'local-only never injects a kernel-wiki unit');
    assert.ok(local.context.items.some((item) => item.source === 'execution'), 'local-only keeps the bound execution record');
    const localAudit = auditFor({ context: local.context, selection: local.selection, facts });
    verifyCondition({ condition: 'local-only', audit: localAudit, sourceRound: sourceRoundFor(facts), experiences, snapshot });
    // Wiki contamination in the actual prompt (and a consistent sidecar): local-only forbids
    // every kernel-wiki item, so the audit is refused rather than silently accepted.
    const contaminatedPrompt = withExperienceBlock(localAudit.prompt, (block) => {
      block.items = [...block.items, wikiRecord];
      block.versions = { ...block.versions, [wikiRecord.id]: wikiRecord.version };
    });
    const contaminatedSelection = {
      ...structuredClone(local.selection),
      selected: [...local.selection.selected, { id: wikiRecord.id, version: wikiRecord.version, source: wikiRecord.source, useAs: 'suggestion', reason: 'frozen-context' }],
    };
    expectRejected('local-only prompt contaminated with a kernel-wiki unit', () => verifyExperienceConditionAudit({
      condition: 'local-only', audit: tamperedAudit(localAudit, contaminatedPrompt, contaminatedSelection),
      sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));

    // local-and-wiki keeps the unchanged D set, including the reviewed related Wiki unit.
    const wiki = await prepare(service, 'local-and-wiki');
    const selectedWiki = wikiItems(wiki.context.items);
    assert.ok(selectedWiki.length >= 1, 'the reviewed sm86 unit is selected under local-and-wiki');
    assert.ok(wiki.context.items.some((item) => item.source === 'execution'));
    const wikiAudit = auditFor({ context: wiki.context, selection: wiki.selection, facts });
    verifyCondition({ condition: 'local-and-wiki', audit: wikiAudit, sourceRound: sourceRoundFor(facts), experiences, snapshot });
    const { block } = experienceBlock(wikiAudit.prompt);
    assert.equal(block.items.filter((item) => item.selectionMetadata?.source === 'kernel-wiki').length, selectedWiki.length,
      'the actual prompt carries every selected Wiki unit, not only the sidecar');

    // A Wiki-mode receipt without any reviewed Wiki unit is refused.
    expectRejected('local-and-wiki without a reviewed Wiki unit in the prompt', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: reaudit(localAudit, localAudit.prompt, { ...structuredClone(local.selection), experienceCondition: 'local-and-wiki' }),
      sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // Actual prompt content disagrees with the stored record: only the sidecar would match.
    const wrongContent = withExperienceBlock(wikiAudit.prompt, (mutable) => {
      const index = mutable.items.findIndex((item) => item.selectionMetadata?.source === 'kernel-wiki');
      assert.ok(index >= 0, 'the fixture prompt really contains the Wiki unit');
      mutable.items[index] = { ...mutable.items[index], content: 'A fabricated, never imported Wiki body.' };
    });
    expectRejected('local-and-wiki whose actual prompt content differs from the imported unit', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: tamperedAudit(wikiAudit, wrongContent), sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // A fully dressed fabricated unit: every selection-metadata field and a reviewed
    // applicability block exactly like an importer writes them, for a page no snapshot ever
    // carried. A verifier that only checks "the metadata is complete and looks reviewed"
    // accepts it; the frozen rules must refuse it because the unit was never imported.
    const fabricatedContent = 'A plausible-looking Wiki unit that no imported snapshot ever carried.';
    const fabricatedUnit = {
      ...structuredClone(wikiRecord),
      id: 'fabricated-never-imported-unit',
      title: 'Fabricated tail guidance',
      content: fabricatedContent,
    };
    // The fabrication is internally consistent — the unit digest really hashes its content and
    // the reviewed applicability block is complete — so the only reason to refuse it is that no
    // imported snapshot ever carried this page/unit.
    fabricatedUnit.selectionMetadata = {
      ...structuredClone(wikiRecord.selectionMetadata),
      pageId: 'fabricated-never-imported-page',
      sourcePath: 'wiki/techniques/fabricated-never-imported-page.md',
      sourceDigest: digest('7'),
      unitDigest: sha256(fabricatedContent),
      applicability: { ...structuredClone(wikiRecord.selectionMetadata.applicability), reviewId: 'fabricated-review' },
    };
    const fabricatedPrompt = withExperienceBlock(wikiAudit.prompt, (mutable) => {
      const index = mutable.items.findIndex((item) => item.selectionMetadata?.source === 'kernel-wiki');
      mutable.items[index] = fabricatedUnit;
      mutable.versions = { ...mutable.versions, [fabricatedUnit.id]: fabricatedUnit.version };
    });
    expectRejected('local-and-wiki citing a fully dressed but never imported Wiki unit', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: tamperedAudit(wikiAudit, fabricatedPrompt), sourceRound: sourceRoundFor(facts),
      experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // Source duplication: the same imported unit is injected twice while the frozen selection
    // sidecar lists it once, so the prompt no longer describes the audited selection.
    const duplicated = withExperienceBlock(wikiAudit.prompt, (mutable) => {
      const index = mutable.items.findIndex((item) => item.selectionMetadata?.source === 'kernel-wiki');
      assert.ok(index >= 0, 'the fixture prompt really contains the Wiki unit');
      mutable.items.push(structuredClone(mutable.items[index]));
    });
    expectRejected('local-and-wiki whose prompt injects the same Wiki unit twice', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: tamperedAudit(wikiAudit, duplicated), sourceRound: sourceRoundFor(facts),
      experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
    // A Wiki item that exists in the store but was never reviewed can never satisfy the mode.
    const unreviewed = await setup('unreviewed-wiki', { execution: true, reviewed: false });
    const unreviewedRecords = await recordsOf(unreviewed.service);
    const unreviewedRecord = unreviewedRecords.find((item) => item.selectionMetadata?.applicability?.mode === 'unreviewed');
    assert.ok(unreviewedRecord, 'the unreviewed unit is imported without a review');
    const unreviewedPrompt = withExperienceBlock(wikiAudit.prompt, (mutable) => {
      const index = mutable.items.findIndex((item) => item.selectionMetadata?.source === 'kernel-wiki');
      mutable.items[index] = unreviewedRecord;
      mutable.versions = { ...mutable.versions, [unreviewedRecord.id]: unreviewedRecord.version };
    });
    expectRejected('local-and-wiki citing an unreviewed KernelWiki unit', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: tamperedAudit(wikiAudit, unreviewedPrompt),
      sourceRound: sourceRoundFor(facts), experiences: unreviewedRecords.length ? unreviewedRecords : experiences,
      missionId: MISSION_ID, projectId: PROJECT_ID, snapshot: unreviewed.snapshot,
    }));
    // A snapshot whose provenance does not match the imported units cannot verify them.
    expectRejected('local-and-wiki against a snapshot from a different source commit', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: wikiAudit, sourceRound: sourceRoundFor(facts), experiences,
      missionId: MISSION_ID, projectId: PROJECT_ID, snapshot: snapshotFor({ sourceCommit: OTHER_COMMIT }),
    }));
    // Sidecar-only selection: the frozen sidecar still lists the reviewed Wiki unit while the
    // actual prompt never carried it. The mode requires at least one reviewed sm86 unit in the
    // prompt itself, so a verifier that trusts the sidecar must fail here.
    const omittedWiki = withExperienceBlock(wikiAudit.prompt, (mutable) => {
      mutable.items = mutable.items.filter((item) => item.selectionMetadata?.source !== 'kernel-wiki');
      mutable.versions = Object.fromEntries(mutable.items.map((item) => [item.id, item.version]));
    });
    expectRejected('local-and-wiki whose prompt dropped the selected Wiki unit (sidecar only)', () => verifyExperienceConditionAudit({
      condition: 'local-and-wiki', audit: tamperedAudit(wikiAudit, omittedWiki),
      sourceRound: sourceRoundFor(facts), experiences, missionId: MISSION_ID, projectId: PROJECT_ID, snapshot,
    }));
  });

  await test('matrix 11b: the runner writes the full nine-slot schedule before the first spawn and stops on a released slot', async () => {
    const { snapshot } = await setup('runner-schedule', { execution: true });
    const dirs = await studyDirs('schedule', snapshot);
    const invocations = [];
    let scheduleBeforeFirstSpawn = null;
    let readCalls = 0;
    // The failing slot really wrote its own report into its own slot directory, so the
    // per-slot directory identity below is observed on disk and not only in the port call.
    const outcome = await attemptStudy(dirs.argv, {
      invokeSmoke: async (invocation) => {
        invocations.push(slotSummary(invocation));
        const result = await materializeSlot({
          index: invocation.index, condition: invocation.condition,
          artifactDir: invocation.artifactDir, reportDir: invocation.reportDir,
          snapshot, snapshotFile: dirs.snapshotFile, options: { label: 'released', smoke: 'failed' },
        });
        if (scheduleBeforeFirstSpawn === null) scheduleBeforeFirstSpawn = await readStudyJson(dirs.reportDir);
        return result;
      },
      readInvocation: async () => { readCalls += 1; throw new Error('a non-full-success slot must stop the study before any read'); },
    });
    assert.equal(outcome instanceof Error, false, `a released slot is a stopped study, not a harness error: ${outcome?.message ?? ''}`);
    assert.equal(invocations.length, 1, 'a non-full-success slot stops the study before the next spawn and is never replaced');
    assert.equal(readCalls, 0, 'a released slot is never read as if it had completed');
    const first = invocations[0];
    assert.equal(first.index, 1);
    assert.equal(first.condition, FROZEN_SCHEDULE[0].condition);
    // The invocation receives its own per-slot work directories, never the study's
    // top-level artifact/report directories and never another slot's.
    assertExclusiveSlotDirs(first, dirs, 'the first stopped slot');
    assert.equal(path.resolve(first.gpuPython), path.resolve(dirs.gpuPython));
    assert.ok(acceptedSnapshotValue(first.snapshot, { snapshotFile: dirs.snapshotFile, snapshot }), 'the child is handed the requested snapshot identity');
    assert.equal(existsSync(path.join(first.reportDir, 'batch.json')), true, 'the slot wrote its own smoke report into its own slot report directory');
    assert.equal(existsSync(path.join(dirs.reportDir, 'batch.json')), false, 'a slot report is never written into the study report root');
    const retained = await readStudyJson(dirs.reportDir);
    assert.ok(scheduleBeforeFirstSpawn, 'the complete schedule is persisted before the first process starts');
    retainedSchedule(scheduleBeforeFirstSpawn);
    retainedSchedule(retained);
    retainedInvocations(retained);
    // A stopped study never claims success, and never claims the strict N20 rule.
    const strings = await retainedStrings(dirs.reportDir);
    assert.ok(strings.some((text) => /"strictN20Passed"\s*:\s*false/.test(text)), 'the retained report always reports strictN20Passed=false');
    // The actual exit code of the released slot is preserved instead of being absorbed, and the
    // remaining eight slots stay stopped and unstarted.
    assert.equal(invocationOf(retained, 1).exitCode, 1, 'the retained report keeps the actual non-zero exit code of the released slot');
    assert.equal(invocationOf(retained, 1).status, 'failed');
    for (const slot of FROZEN_SCHEDULE.slice(1)) {
      assert.deepEqual(issuesOf(retained, slot.index), ['study_stopped'], `slot ${slot.index} must remain explicitly stopped`);
    }
  });

  // The study stop matrix is reported as one independent sub-case per drifted field: every
  // branch keeps its own case name, its own fixture and its own PASS/FAIL line, and any
  // failing branch is counted as a failure of this process instead of hiding the later ones
  // behind the first `assert`. The matrix content itself is unchanged: each branch still
  // proves that one documented one-field drift in the second slot stops the study, retains
  // the real exit of that slot and leaves the remaining seven slots explicitly stopped.
  for (const drift of DRIFT_CASES) {
    await test(`matrix 11c/${drift.label}: ${drift.description}`, async () => {
      const { snapshot } = await setup(`runner-drift-${drift.label}`, { execution: true });
      await runDriftCase({ ...drift, snapshot });
    });
  }

  // --- S2: the three process layers have separate exit meanings ---------------------------
  //
  // `study.invocations[N].exitCode` is the smoke BATCH child exit; the nested
  // `slot-NN/batch.json.invocations[0].exitCode` is the individual live driver exit. The
  // frozen observed valid failure is: driver exit0 / completed / full_success, the smoke batch
  // around it status failed because comparable=false with a provider.model issue, and the outer
  // slot exit1 / failed. The reader must return a verified stopped study for that truthful
  // failure - it must NOT require the two child exit codes to be equal - while a claimed pass
  // over a nonzero outer exit, and a nested failure that dropped its own non-comparable proof,
  // stay refusals.

  // Run the real study runner with slot 1 complete and slot 2 the frozen nested-exit failure.
  // `spawned` keeps the runner's own per-slot directories, so every assertion below reads the
  // bytes the runner really retained instead of a re-derived expectation.
  const runNestedStudy = async (label) => {
    const { snapshot } = await setup(`nested-${label}`, { execution: true });
    const dirs = await studyDirs(`nested-${label}`, snapshot);
    const spawned = [];
    const runRoots = new Map();
    const outcome = await attemptStudy(dirs.argv, {
      invokeSmoke: async (invocation) => {
        spawned.push(slotSummary(invocation));
        const result = await materializeSlot({
          index: invocation.index, condition: invocation.condition,
          artifactDir: invocation.artifactDir, reportDir: invocation.reportDir,
          snapshot, snapshotFile: dirs.snapshotFile,
          options: invocation.index === 2
            ? { label, smoke: 'nested-noncomparable' } : { label: 'green' },
        });
        // The port result carries the slot's own run root back, so the case reads the raw
        // driver artifacts from the path the fixture really wrote instead of re-deriving it.
        runRoots.set(invocation.index, result.runRoot ?? null);
        return result;
      },
    });
    assert.equal(outcome instanceof Error, false,
      `${label}: a nested non-comparable failure is a stopped study, not a harness error: ${outcome?.message ?? ''}`);
    assert.deepEqual(spawned.map((slot) => slot.index), [1, 2],
      `${label}: the green first slot must be followed by the nested second slot (started ${spawned.map((slot) => slot.index).join(',')})`);
    const document = await readStudyJson(dirs.reportDir);
    retainedSchedule(document);
    retainedInvocations(document);
    return { dirs, snapshot, spawned, document, runRootOf: (index) => runRoots.get(index) ?? null };
  };
  const nestedBatchFile = (spawned) => path.join(spawned[1].reportDir, 'batch.json');
  // The nested slot's own retained evidence, read from its raw originals rather than trusted
  // from the smoke report: the workflow really succeeded and only the model proof is
  // incomplete, which is what makes the run non-comparable instead of unsuccessful.
  const assertNestedEvidenceTruthful = async ({ spawned, runRootOf }, label) => {
    const batch = JSON.parse(await readFile(nestedBatchFile(spawned), 'utf8'));
    assert.equal(batch.status, 'failed', `${label}: the nested smoke batch really failed`);
    assert.equal(batch.invocations[0].exitCode, 0, `${label}: the nested live driver itself really exited zero`);
    assert.equal(batch.invocations[0].status, 'completed', `${label}: the nested live driver really completed`);
    assert.equal(batch.invocations[0].outcome, 'full_success', `${label}: the nested live driver really reached full success`);
    assert.equal(batch.invocations[0].comparable, false, `${label}: the nested driver run is not comparable`);
    assert.ok(failureOf(batch.invocations[0].issues).includes('provider.model'),
      `${label}: the nested failure names the provider.model comparability issue, saw ${JSON.stringify(failureOf(batch.invocations[0].issues))}`);
    const runRoot = runRootOf(2);
    assert.ok(runRoot, `${label}: the nested slot retained no run root`);
    const attempt = JSON.parse(await readFile(path.join(runRoot, 'attempt.json'), 'utf8'));
    assert.equal(attempt.fullSuccess, true, `${label}: the retained driver attempt really completed successfully`);
    assert.equal(attempt.modelObservationSummary?.status, 'unknown',
      `${label}: the retained driver attempt really never observed its provider model`);
    assert.equal(attempt.comparable, false, `${label}: the retained driver attempt is really non-comparable`);
    return { batch, attempt };
  };
  // A nested-failure reader negative: the stopped fixture is built and verified first, then the
  // nested slot's own retained smoke report is mutated. The reader must refuse it, and the
  // refusal must leave every retained byte exactly as the tamper left it.
  const nestedReaderRejects = async (label, tamper) => {
    const fixture = await runNestedStudy(label);
    const { dirs, spawned, document } = fixture;
    const receipt = await verifyStudyReport(dirs.reportDir);
    assert.equal(receipt.ok, true, `${label}: the nested fixture verified before the tamper`);
    assert.equal(receipt.status, 'stopped', `${label}: the nested fixture is a stopped study`);
    assert.deepEqual(slotCountsOf(receipt, label), { completed: 1, failed: 1, stopped: 7 },
      `${label}: the untampered nested fixture keeps its one-completed/one-failed/seven-stopped histogram`);
    assert.equal(countOf(receipt.verifiedSlots), 9, `${label}: the nested fixture verified all nine retained slots before the tamper`);
    const cleanReport = await treeIdentity(dirs.reportDir);
    const cleanArtifacts = await treeIdentity(dirs.artifactDir);
    await tamper({ ...fixture, batchFile: nestedBatchFile(spawned) });
    const tamperedReport = await treeIdentity(dirs.reportDir);
    const tamperedArtifacts = await treeIdentity(dirs.artifactDir);
    assert.notEqual(`${tamperedReport}\u0000${tamperedArtifacts}`, `${cleanReport}\u0000${cleanArtifacts}`,
      `${label}: the tamper must really change the retained report or its raw originals`);
    await assert.rejects(() => verifyStudyReport(dirs.reportDir), Error, `${label}: the reader must refuse this report`);
    assert.equal(await treeIdentity(dirs.reportDir), tamperedReport, `${label}: a refusing reader rewrites no report byte`);
    assert.equal(await treeIdentity(dirs.artifactDir), tamperedArtifacts, `${label}: a refusing reader rewrites no raw artifact byte`);
  };

  await test('matrix 14a: a nested driver exit0 under a failed smoke batch is a verified stopped study', async () => {
    const fixture = await runNestedStudy('positive');
    const { dirs, spawned, document } = fixture;
    // The first slot really succeeded and stays completed; the nested slot is retained failed
    // and the remaining seven slots never start.
    assert.equal(invocationOf(document, 1).status, 'completed', 'the first slot is retained as completed');
    assert.equal(invocationOf(document, 1).exitCode, 0, 'the first slot really exited zero');
    assert.equal(invocationOf(document, 2).status, 'failed', 'the nested slot is retained as a failure');
    assert.equal(invocationOf(document, 2).exitCode, 1,
      'the nested slot keeps the real exit code of its own smoke batch child');
    for (const slot of FROZEN_SCHEDULE.slice(2)) {
      assert.equal(invocationOf(document, slot.index).status, 'stopped', `slot ${slot.index} must never start after the nested failure`);
      assert.deepEqual(issuesOf(document, slot.index), ['study_stopped'], `slot ${slot.index} stays explicitly stopped`);
    }
    assert.equal(document.status, 'stopped', 'the study is retained as stopped, never as completed');
    assert.equal(document.strictN20Passed, false, 'a stopped study never claims the strict N20 rule');
    // The nested layer is the observed valid failure and its own raw evidence says so.
    const { batch } = await assertNestedEvidenceTruthful(fixture, 'matrix 14a');
    assert.notEqual(invocationOf(document, 2).exitCode, batch.invocations[0].exitCode,
      'the two child exit codes really differ: that disagreement is the case, not a defect');
    // The read-only reader verifies this truthful failure: it must not require the outer smoke
    // exit to equal the nested driver exit, must not emit the invented success, and must still
    // report the real outcome histogram of the nine scheduled slots.
    const receipt = await verifyStudyReport(dirs.reportDir);
    assert.equal(receipt.ok, true, 'the nested-failure study is a faithfully verified report');
    assert.equal(receipt.status, 'stopped', 'the verified study is stopped');
    assert.equal(receipt.strictN20Passed, false, 'the verified study never claims strict N20');
    assert.deepEqual(slotCountsOf(receipt, 'matrix 14a'), { completed: 1, failed: 1, stopped: 7 },
      'the verified study retains one completed, one failed and seven unstarted slots');
    const verified = verifiedSlotsOf(receipt, document, 'matrix 14a');
    assert.equal(verified.length, FROZEN_SCHEDULE.length, 'every retained slot is verified, including the nested failure');
    assert.equal(verified.filter((slot) => slot.status === 'completed').length, 1,
      'exactly the first slot counts as completed');
    // The verified slot detail keeps the outer smoke exit code of the failed slot as its own
    // fact; the nested driver exit stays in the slot's raw evidence, never merged into it.
    // `verifiedSlotsOf` deliberately projects each verified slot down to `{ index, status }`,
    // so the exit-code fact is read from the reader's raw receipt record, not that projection.
    const rawNestedSlot = receipt.verifiedSlots.find((slot) => slot.index === 2);
    assert.equal(rawNestedSlot?.exitCode, 1,
      'the verified nested slot reports the outer smoke exit code it really retained');
  });

  await test('matrix 14b: a claimed passed batch over a nonzero smoke exit stays a contradiction', async () => {
    // The tamper states the one thing the frozen reader must never accept: a smoke report that
    // claims success while the study retained a nonzero exit for that same slot.
    await nestedReaderRejects('false-green', async ({ batchFile }) => {
      const batch = JSON.parse(await readFile(batchFile, 'utf8'));
      batch.status = 'passed';
      batch.stopReason = null;
      await writeJson(batchFile, batch);
    });
  });

  await test('matrix 14c: a nested failure whose non-comparable proof was dropped is refused', async () => {
    await nestedReaderRejects('missing-proof', async ({ batchFile, ...nested }) => {
      const before = await assertNestedEvidenceTruthful(nested, 'matrix 14c');
      assert.equal(before.batch.invocations[0].comparable, false, 'the untampered nested report really is non-comparable');
      const batch = JSON.parse(await readFile(batchFile, 'utf8'));
      // The claimed pass is exactly the invented success the contract forbids: the batch still
      // says failed, but its one invocation now asserts comparability and drops the issue that
      // made the run non-comparable while the raw driver artifacts still retain the unknown
      // model proof. Nothing in the fixture can be made self-consistent by this mutation.
      batch.invocations[0].comparable = true;
      batch.invocations[0].issues = failureOf(batch.invocations[0].issues).filter((issue) => issue !== 'provider.model');
      await writeJson(batchFile, batch);
    });
  });

  await test('matrix 11c/missing-artifacts: a slot whose raw record is unreadable stops the study', async () => {
    const { snapshot } = await setup('runner-drift-missing', { execution: true });
    // Missing artifacts: the slot exits zero but retains no readable record at all.
    const missingDirs = await studyDirs('missing', snapshot);
    const missingInvocations = [];
    await attemptStudy(missingDirs.argv, {
      invokeSmoke: async (invocation) => {
        missingInvocations.push(slotSummary(invocation));
        return { exitCode: 0, signal: null };
      },
      readInvocation: async () => { throw Object.assign(new Error('retained originals are missing'), { code: 'ENOENT' }); },
    });
    // Whatever the runner reports about the unreadable slot, the retained schedule must still be
    // the frozen nine-slot one and no further slot may be started: a slot whose raw artifacts
    // cannot be read is never replaced, never resampled and never silently completed.
    assert.deepEqual(missingInvocations.map((slot) => slot.index), [1], 'a slot whose artifacts are missing stops the study before the next spawn');
    const missingReport = await readStudyJson(missingDirs.reportDir);
    retainedSchedule(missingReport);
    retainedInvocations(missingReport);
    assert.notEqual(missingReport.status, 'completed', 'a study whose slot evidence is unreadable never claims completion');
    assert.equal(missingReport.strictN20Passed, false, 'a study never reports the strict N20 rule as passed');
  });

  await test('matrix 12: invalid CLI and refused imports have no side effects; the report reader is read-only', async () => {
    const { snapshot } = await setup('runner-cli', { execution: true });
    const dirs = await studyDirs('cli', snapshot);
    // A directory that already holds the snapshot cannot also be the report directory.
    const snapshotHolder = path.join(dirs.root, 'snapshot-holder');
    await mkdir(snapshotHolder, { recursive: true });
    const heldSnapshot = path.join(snapshotHolder, 'wiki-snapshot.json');
    await writeJson(heldSnapshot, snapshot);
    const noPorts = {};
    const rejections = [
      ['no arguments at all', []],
      ['an unknown flag', [...dirs.argv, '--nope', 'x']],
      ['a repeated flag', ['--snapshot', dirs.snapshotFile, '--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.reportDir, '--gpu-python', dirs.gpuPython]],
      ['a missing required flag', dirs.argv.filter((token) => token !== '--gpu-python' && token !== dirs.gpuPython)],
      ['a missing value', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.reportDir, '--gpu-python']],
      ['a relative report directory', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', 'relative-report', '--gpu-python', dirs.gpuPython]],
      ['a relative snapshot', ['--snapshot', 'wiki-snapshot.json', '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.reportDir, '--gpu-python', dirs.gpuPython]],
      ['a relative gpu python', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.reportDir, '--gpu-python', 'python.exe']],
      ['one directory used for artifacts and reports', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.artifactDir, '--gpu-python', dirs.gpuPython]],
      ['a report directory inside the artifact directory', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', path.join(dirs.artifactDir, 'report'), '--gpu-python', dirs.gpuPython]],
      ['a report directory that contains the snapshot', ['--snapshot', heldSnapshot, '--artifact-dir', dirs.artifactDir, '--report-dir', snapshotHolder, '--gpu-python', dirs.gpuPython]],
      // Alias spellings of a path that must stay distinct: lexical normalization cannot be
      // skipped, and it is the pure parser's job because it needs no filesystem access.
      ['a report directory spelled with a trailing separator', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.artifactDir + path.sep, '--gpu-python', dirs.gpuPython]],
      ['a report directory spelled with a dot segment', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', path.join(dirs.artifactDir, '.'), '--gpu-python', dirs.gpuPython]],
      ...(process.platform === 'win32' ? [['a report directory spelled with backslash separators', ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', dirs.artifactDir.replaceAll('/', '\\'), '--gpu-python', dirs.gpuPython]]] : []),
    ];
    for (const [label, argv] of rejections) {
      // Every row above is a lexical rule about the spellings in the argument list, so the pure
      // parser owns it: it must refuse the list without touching the filesystem.
      assert.throws(() => parseStudyArguments(argv), Error, `the CLI must reject ${label}`);
    }
    assert.equal(existsSync(dirs.reportDir), false, 'a rejected argument list creates no report directory');
    assert.equal(await treeIdentity(dirs.artifactDir), '', 'a rejected argument list leaves the artifact directory untouched');
    // Beyond lexing, the runner itself validates what only real I/O can decide. Each of these
    // option sets parses cleanly and is refused by the asynchronous preflight, before any spawn
    // and before any output exists.
    const parsed = parseStudyArguments(dirs.argv);
    assert.equal(path.resolve(parsed.reportDir), path.resolve(dirs.reportDir), 'the parser returns the requested report directory');
    // The snapshot really has to be read to build the receipts, so a missing file is a refusal
    // the asynchronous preflight owns even though every spelling above is legal.
    await assert.rejects(() => runExperienceStudy({ ...parsed, snapshot: path.join(dirs.root, 'absent-snapshot.json') }, noPorts),
      Error, 'the runner must refuse a snapshot file that does not exist');
    assert.equal(existsSync(dirs.reportDir), false, 'a refused preflight writes no report');
    assert.equal(await treeIdentity(dirs.artifactDir), '', 'a refused preflight writes no artifact');

    // A junction alias of the artifact directory is the same directory, not a new exclusive
    // one. Alias resolution is real I/O, so it belongs to the asynchronous preflight and not
    // to the pure parser: the parser accepts the argument list (it only owns lexical rules),
    // and the real runner refuses the alias before it spawns or writes anything.
    let alias = null;
    try {
      alias = path.join(dirs.root, 'artifact-alias');
      await symlink(dirs.artifactDir, alias, 'junction');
    } catch {
      alias = null;
    }
    if (alias) {
      const aliasArgv = ['--snapshot', dirs.snapshotFile, '--artifact-dir', dirs.artifactDir, '--report-dir', alias, '--gpu-python', dirs.gpuPython];
      const parsedAlias = parseStudyArguments(aliasArgv);
      assert.ok(parsedAlias && typeof parsedAlias === 'object', 'the pure parser returns the parsed arguments and touches no filesystem');
      let aliasSpawns = 0;
      await assert.rejects(() => runExperienceStudy(parsedAlias, {
        invokeSmoke: async () => { aliasSpawns += 1; return { exitCode: 0, signal: null }; },
        readInvocation: async () => { aliasSpawns += 1; return null; },
      }), Error, 'the asynchronous preflight must refuse a report directory that aliases the artifact directory');
      assert.equal(aliasSpawns, 0, 'the alias is refused before any invocation is spawned');
      assert.equal(existsSync(dirs.reportDir), false, 'the alias is refused before any report output is written');
      assert.equal(await treeIdentity(dirs.artifactDir), '', 'the alias is refused before any artifact output is written');
    } else {
      console.log('SKIP an alias of the artifact directory: this platform refused to create the junction');
    }

    // A pre-existing report directory is refused before any invocation, and the snapshot inside
    // the report outputs is refused as an overlap rather than silently accepted.
    await mkdir(dirs.reportDir, { recursive: true });
    await writeFile(path.join(dirs.reportDir, 'existing.txt'), 'keep', 'utf8');
    let invoked = 0;
    await assert.rejects(() => runExperienceStudy(parseStudyArguments(dirs.argv), {
      invokeSmoke: async () => { invoked += 1; return { exitCode: 0, signal: null }; },
      readInvocation: async () => { invoked += 1; return null; },
    }), Error, 'the runner must refuse an existing report directory');
    assert.equal(invoked, 0, 'the runner refuses an existing report directory before any effect');
    assert.equal(await readFile(path.join(dirs.reportDir, 'existing.txt'), 'utf8'), 'keep', 'the runner never overwrites an existing report directory');

    // The read-only reader takes only a retained report path. It is never a runner: an extra
    // ports argument is ignored, no invocation is ever spawned while it reads, and nothing
    // under the report or its artifacts is created, rewritten or deleted. This fixture is
    // generated and verified on its own bytes here, so the positive is real and every negative
    // below is meaningful rather than vacuous.
    const green = await freshStudy('reader-positive');
    const cleanBefore = await treeIdentity(green.dirs.reportDir);
    const cleanArtifactsBefore = await treeIdentity(green.dirs.artifactDir);
    let readerSpawns = 0;
    const cleanReceipt = await verifyStudyReport(green.dirs.reportDir, {
      invokeSmoke: async () => { readerSpawns += 1; return { exitCode: 0, signal: null }; },
      readInvocation: async () => { readerSpawns += 1; return null; },
    });
    assert.equal(cleanReceipt.ok, true, 'the clean nine-slot report must verify');
    assert.equal(cleanReceipt.strictN20Passed, false, 'the reader receipt always reports strictN20Passed=false');
    assert.equal(cleanReceipt.requestedSlots, 9, 'the reader receipt retains the requested nine slots');
    assertAllSlotsCompleted(cleanReceipt, 9, 'reader-positive');
    assert.equal(verifiedSlotsOf(cleanReceipt, green.document, 'reader-positive').length, 9, 'every retained slot of the clean report verifies');
    assert.equal(readerSpawns, 0, 'the reader never starts an invocation, even when handed ports');
    assert.equal(await treeIdentity(green.dirs.reportDir), cleanBefore, 'the report reader rewrites nothing in the retained report');
    assert.equal(await treeIdentity(green.dirs.artifactDir), cleanArtifactsBefore, 'the report reader rewrites nothing under the artifacts');

    // A hand-written report that no producer ever wrote cannot be verified: the reader must
    // refuse it instead of trusting the fixture's own claims, and it must leave it alone.
    const fabricated = path.join(green.dirs.root, 'fabricated-report');
    await mkdir(fabricated, { recursive: true });
    await writeJson(path.join(fabricated, 'study.json'), {
      schemaVersion: EXPERIENCE_STUDY_SCHEMA_VERSION,
      schedule: buildStudySchedule(),
      strictN20Passed: false,
      invocations: FROZEN_SCHEDULE.map((slot) => ({ ...slot, status: 'completed', exitCode: 0 })),
    });
    const fabricatedBefore = await treeIdentity(fabricated);
    await assert.rejects(() => verifyStudyReport(fabricated), Error, 'a hand-written report without retained raw artifacts must be refused');
    assert.equal(await treeIdentity(fabricated), fabricatedBefore, 'the refusing reader still leaves the report untouched');
    // A report directory that does not exist is refused, and never created.
    const absent = path.join(green.dirs.root, 'absent-report');
    await assert.rejects(() => verifyStudyReport(absent), Error, 'an absent report directory is refused');
    assert.equal(existsSync(absent), false, 'the report reader never creates a report directory');
    assert.equal(await treeIdentity(green.dirs.artifactDir), cleanArtifactsBefore, 'the report reader retains no artifact child of its own');

    // Each reader negative builds and verifies its OWN complete green fixture (inside
    // readerRejects) and then mutates exactly one documented field or one raw original of that
    // fixture. Nothing is copied or repointed, so a validated negative can never be validated
    // against a layout that the copy itself already broke.
    const slotSample = async (reportDir, label, mutate) => {
      const document = await readReport(reportDir);
      mutate(requiredField(document, 'invocations', label)[0]);
      await writeReport(reportDir, document);
    };
    // The recorded original digest no longer describes the retained file bytes.
    await readerRejects('original-hash', async ({ reportDir, artifactDir }) => {
      const document = await readReport(reportDir);
      const entry = document.invocations[0].originals[0];
      assert.equal(entry.role, 'batchReport', 'the first recorded original is the slot smoke report');
      assertOriginalRoot(entry, { reportDir, artifactDir }, 'original-hash');
      entry.sha256 = digest('0');
      await writeReport(reportDir, document);
      return [entry.path];
    });
    // The raw artifact bytes themselves were changed after the run.
    await readerRejects('original-bytes', async ({ reportDir, artifactDir }) => {
      const document = await readReport(reportDir);
      const entry = document.invocations[1].originals.find((item) => item.role === 'attempt');
      assert.ok(entry, 'the fixture retains the attempt original of the second slot');
      assertOriginalRoot(entry, { reportDir, artifactDir }, 'original-bytes');
      await writeFile(entry.path, `${await readFile(entry.path, 'utf8')}\n`, 'utf8');
      return [entry.path];
    });
    // A recorded byte length that does not match the retained file.
    await readerRejects('original-bytes-length', async ({ reportDir, artifactDir }) => {
      const document = await readReport(reportDir);
      const entry = document.invocations[2].originals.find((item) => item.role === 'summary');
      assert.ok(entry, 'the fixture retains the summary original of the third slot');
      assertOriginalRoot(entry, { reportDir, artifactDir }, 'original-bytes-length');
      entry.bytes = Number(entry.bytes) + 1;
      await writeReport(reportDir, document);
      return [entry.path];
    });
    await readerRejects('slot-condition', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      const invocation = requiredField(document, 'invocations', 'slot-condition')[2];
      requiredField(invocation, 'condition', 'slot-condition');
      invocation.condition = 'facts-only';
      await writeReport(reportDir, document);
    });
    await readerRejects('slot-order', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      requiredField(document, 'invocations', 'slot-order').reverse();
      await writeReport(reportDir, document);
    });
    await readerRejects('slot-identity', async ({ reportDir }) => {
      await slotSample(reportDir, 'slot-identity', (invocation) => {
        assert.ok(Number.isInteger(requiredField(invocation, 'index', 'slot-identity')), 'a retained invocation carries its integer index');
        invocation.index = 8;
      });
    });
    await readerRejects('slot-exit', async ({ reportDir }) => {
      await slotSample(reportDir, 'slot-exit', (invocation) => { invocation.exitCode = 1; });
    });
    await readerRejects('slot-status', async ({ reportDir }) => {
      await slotSample(reportDir, 'slot-status', (invocation) => { invocation.status = 'stopped'; });
    });
    // Any further field the report retains about a slot: none of them may be retyped freely.
    await readerRejects('slot-metrics', async ({ reportDir }) => {
      await slotSample(reportDir, 'slot-metrics', (invocation) => { invocation.metrics = { invented: true }; });
    });
    await readerRejects('slot-run-root', async ({ reportDir }) => {
      await slotSample(reportDir, 'slot-run-root', (invocation) => { invocation.runRoot = null; });
    });
    // The schedule itself is part of the frozen report, not a decorative copy.
    await readerRejects('schedule-condition', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      const schedule = requiredField(document, 'schedule', 'schedule-condition');
      schedule[3].condition = 'facts-only';
      await writeReport(reportDir, document);
    });
    // The compared design is recomputed from the raw artifacts, never taken from the report:
    // the report's own design block and the originals it was derived from must agree. Each of
    // these changes exactly one field of the report; the raw originals stay untouched, so a
    // reader that echoed the report instead of recomputing would accept them.
    await readerRejects('design-model-identity', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      const design = requiredField(document, 'design', 'design-model-identity');
      assert.ok(typeof design === 'object' && !Array.isArray(design), 'the retained design must be an object');
      const modelKey = ['model', 'observedModel', 'modelSummary'].find((key) => Object.hasOwn(design, key));
      assert.ok(modelKey, `design-model-identity: the retained design must carry an observed model (saw ${Object.keys(design).join(', ')})`);
      design[modelKey] = DIFFERENT_MODEL;
      await writeReport(reportDir, document);
    });
    await readerRejects('design-source', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      const design = requiredField(document, 'design', 'design-source');
      const source = requiredField(design, 'source', 'design-source');
      const commitKey = ['commit', 'codeCommit', 'sourceCommit'].find((key) => Object.hasOwn(source, key));
      assert.ok(commitKey, `design-source: the retained design source must carry a commit (saw ${Object.keys(source).join(', ')})`);
      source[commitKey] = 'f'.repeat(40);
      await writeReport(reportDir, document);
    });
    await readerRejects('design-identity', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      const design = requiredField(document, 'design', 'design-identity');
      const identityKey = Object.hasOwn(design, 'sharedDesignIdentity') ? 'sharedDesignIdentity'
        : Object.keys(design).find((key) => typeof design[key] === 'string' && /^[0-9a-f]{64}$/.test(design[key]));
      assert.ok(identityKey, `design-identity: the retained design must carry a bare sha256 identity (saw ${Object.keys(design).join(', ')})`);
      design[identityKey] = digest('f');
      await writeReport(reportDir, document);
    });
    // The comparison block is exploratory by construction: a report that claims significance is
    // refused, and the frozen descriptive-only flag may not be flipped either.
    await readerRejects('comparison-claim', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      const comparison = requiredField(document, 'comparison', 'comparison-claim');
      assert.ok(typeof comparison === 'object' && !Array.isArray(comparison), 'the retained comparison must be an object');
      assert.equal(comparison.descriptiveOnly, true, 'the retained comparison stays descriptive');
      assert.equal(comparison.significanceClaimed, false, 'the retained comparison claims no significance');
      comparison.significanceClaimed = true;
      await writeReport(reportDir, document);
    });
    // The report may never claim more than the frozen schedule: a study never passes N20.
    await readerRejects('strict-n20-claim', async ({ reportDir }) => {
      const document = await readReport(reportDir);
      document.strictN20Passed = true;
      await writeReport(reportDir, document);
    });
  });

  await test('matrix 12b: the nine-slot green study runs the real default reader to success', async () => {
    // This positive is generated and verified by freshStudy on its own bytes, and it asserts
    // nine completed slots before any other case may consume it as a base for a negative.
    const { dirs, calls, outcome, document: retained, receipt } = await freshStudy('green');
    assert.equal(outcome instanceof Error, false, `the green study must complete: ${outcome?.message ?? ''}`);
    // Exactly nine invocations, in schedule order, each in its own frozen condition: no slot is
    // repeated, replaced, skipped or fabricated.
    assert.deepEqual(calls.map((slot) => slot.index), FROZEN_SCHEDULE.map((slot) => slot.index),
      'the runner starts exactly the nine scheduled slots in order');
    assert.deepEqual(calls.map((slot) => slot.condition), FROZEN_SCHEDULE.map((slot) => slot.condition),
      'each slot runs its frozen condition');
    for (const slot of calls) assertExclusiveSlotDirs(slot, dirs, `green slot ${slot.index}`);
    assert.deepEqual(retainedSchedule(retained), FROZEN_SCHEDULE, 'the retained schedule stays the single frozen nine-slot one');
    retainedInvocations(retained);
    assert.equal(retained.status, 'completed', 'a fully successful study is retained as completed');
    assert.equal(retained.stopReason, null, 'a fully successful study retains no stop reason');
    assert.equal(retained.strictN20Passed, false, 'a study never reports the strict N20 rule as passed');
    assert.equal(retained.requestedSlots, 9, 'the report retains the frozen requested slot count');
    assert.equal(retained.invocations.length, 9, 'the report retains all nine invocation identities');
    // Every invocation is explicitly completed with exit zero — the positive is real progress,
    // not "the first slot failed but the assertion was loose".
    for (const slot of FROZEN_SCHEDULE) {
      const invocation = invocationOf(retained, slot.index);
      assert.equal(invocation.status, 'completed', `slot ${slot.index} must be retained as completed`);
      assert.equal(invocation.exitCode, 0, `slot ${slot.index} must retain its real zero exit code`);
      assert.equal(invocation.condition, slot.condition, `slot ${slot.index} must retain its frozen condition`);
      assert.equal(invocation.runRoot !== null && invocation.runRoot !== undefined, true, `slot ${slot.index} must retain the run root the reader discovered`);
      assert.deepEqual(failureOf(invocation.issues).filter((issue) => issue !== 'study_stopped'), [], `slot ${slot.index} must retain no failure issue`);
    }
    // The condition receipt the runner retained is the public receipt of that slot, and it is
    // bound to the slot's own condition rather than to a shared placeholder.
    for (const slot of FROZEN_SCHEDULE) {
      const conditionReceipt = invocationOf(retained, slot.index).conditionAudit;
      assert.ok(conditionReceipt && typeof conditionReceipt === 'object' && !Array.isArray(conditionReceipt),
        `slot ${slot.index} must retain its condition receipt`);
      if (conditionReceipt.condition !== undefined) {
        assert.equal(conditionReceipt.condition, slot.condition, `slot ${slot.index} keeps the receipt of its own condition`);
      }
      assert.equal(JSON.parse(JSON.stringify(conditionReceipt)).condition ?? slot.condition, conditionReceipt.condition ?? slot.condition,
        `slot ${slot.index}: the retained receipt survives serialization unchanged`);
    }
    // The seven frozen originals are retained per slot, in the documented order, with the real
    // bare lowercase sha256 and byte length of the files under that slot.
    for (const slot of FROZEN_SCHEDULE) {
      const originals = invocationOf(retained, slot.index).originals;
      assert.ok(Array.isArray(originals) && originals.length === ORIGINAL_ROLES.length,
        `slot ${slot.index} must retain its seven raw originals`);
      assert.deepEqual(originals.map((entry) => entry.role), ORIGINAL_ROLES, `slot ${slot.index} keeps the frozen original order`);
      for (const entry of originals) {
        assert.equal(path.isAbsolute(entry.path), true, `${slot.index}/${entry.role}: an original path is absolute`);
        assert.equal(/^[0-9a-f]{64}$/.test(String(entry.sha256)), true, `${slot.index}/${entry.role}: sha256 is bare lowercase hex`);
        assert.equal(entry.sha256.startsWith('sha256:'), false, `${slot.index}/${entry.role}: sha256 carries no prefix`);
        assert.equal(entry.bytes, (await stat(entry.path)).size, `${slot.index}/${entry.role}: bytes is the real file length`);
        assert.equal(entry.sha256, await fileDigest(entry.path), `${slot.index}/${entry.role}: sha256 is the real file digest`);
      }
    }
    // The seven originals are private to their own slot: no source is borrowed from another.
    for (const role of ORIGINAL_ROLES) {
      const paths = FROZEN_SCHEDULE.map((slot) => invocationOf(retained, slot.index).originals.find((entry) => entry.role === role).path);
      assert.equal(new Set(paths.map((item) => path.resolve(item))).size, 9, `${role}: every slot retains its own original`);
    }
    // The public reader is the authority on the retained report; the actual result must verify.
    assert.equal(receipt.ok, true, 'the public reader must verify the nine-slot study');
    assert.equal(receipt.status, 'completed', 'the verified status is the retained completed status');
    assert.equal(receipt.strictN20Passed, false, 'the reader receipt always reports strictN20Passed=false');
    assert.equal(receipt.stopReason, null, 'a verified successful study has no stop reason');
    assert.equal(receipt.requestedSlots, 9, 'the reader receipt retains the requested slots');
    assertAllSlotsCompleted(receipt, 9, 'green');
    assert.equal(verifiedSlotsOf(receipt, retained, 'green').length, 9, 'the reader verifies all nine retained slots');
    assert.ok(receipt.design && typeof receipt.design === 'object', 'the reader receipt retains the compared design');
    assert.ok(receipt.schedule && receipt.snapshot, 'the reader receipt retains the schedule and the snapshot identity');
    // The retained comparison is the frozen exploratory one: descriptive only, no significance
    // claim, and it groups the retained slots by the three frozen conditions.
    const retainedComparison = requiredField(retained, 'comparison', 'green');
    assert.equal(retainedComparison.descriptiveOnly, true, 'the retained comparison is descriptive only');
    assert.equal(retainedComparison.significanceClaimed, false, 'the retained comparison claims no significance');
    const byCondition = requiredField(retainedComparison, 'byCondition', 'green');
    const grouped = Array.isArray(byCondition) ? byCondition.map((entry) => entry?.condition) : Object.keys(byCondition);
    assert.deepEqual([...new Set(grouped)].sort(), [...EXPERIENCE_CONDITIONS].sort(),
      'the retained comparison groups exactly the three frozen conditions, never a fourth sample');
    assert.equal(path.isAbsolute(String(receipt.reportFile)), true, 'the reader receipt names the absolute report file');
    // The production D policy version really comes from the production export: the study
    // configuration of every slot is built from it, and the obsolete retrieve-only constant is
    // a different, observable value that never appears in a study configuration.
    assert.equal(WIKI_SELECTION_POLICY_VERSION, 'operator-studio.optimization-hypothesis-selection/v1');
    assert.notEqual(EXPERIENCE_SELECTION_POLICY_VERSION, WIKI_SELECTION_POLICY_VERSION);
    for (const condition of EXPERIENCE_CONDITIONS) {
      assert.equal(studyConfig(condition).promptPolicy.experienceSelectionPolicyVersion, WIKI_SELECTION_POLICY_VERSION,
        'a study configuration stamps the production D policy version');
    }
  });

  await test('matrix 13: the fingerprint keeps the D policy and study fields, and only the condition may differ', async () => {
    // The study records the current D selection policy, never the legacy retrieve-only constant.
    assert.equal(WIKI_SELECTION_POLICY_VERSION, 'operator-studio.optimization-hypothesis-selection/v1');
    assert.notEqual(EXPERIENCE_SELECTION_POLICY_VERSION, WIKI_SELECTION_POLICY_VERSION);
    const config = studyConfig('facts-only');
    const fingerprint = buildConfigFingerprint(config, { code: config.code });
    assert.deepEqual(fingerprint.unknownFields, [], 'a complete study configuration is comparable');
    assert.equal(fingerprint.comparable, true);
    assert.ok(fingerprint.requiredFields.includes('promptPolicy.experienceSelectionPolicyVersion'), 'the standard fingerprint keeps the selection policy path');
    // Every study field survives normalization: they are configuration, not per-run volatile data.
    assert.deepEqual(normalizeConfigForFingerprint(config).promptPolicy, config.promptPolicy);
    // The legacy retrieve-only policy version is a different, still-unknown-free configuration:
    // stamping it would be observable instead of silently equal to the D policy.
    assert.notEqual(buildConfigFingerprint(studyConfig('facts-only', { promptPolicy: { experienceSelectionPolicyVersion: EXPERIENCE_SELECTION_POLICY_VERSION } }), { code: config.code }).fingerprint,
      fingerprint.fingerprint, 'the D policy version enters the fingerprint');
    // Shared design identity: delete ONLY the explicit condition from the normalized config.
    const sharedDesign = (value) => {
      const normalized = structuredClone(normalizeConfigForFingerprint(value));
      delete normalized.promptPolicy.experienceCondition;
      return normalized;
    };
    const factsOnly = sharedDesign(studyConfig('facts-only'));
    assert.deepEqual(factsOnly, sharedDesign(studyConfig('local-only')), 'two conditions share one design identity');
    assert.deepEqual(factsOnly, sharedDesign(studyConfig('local-and-wiki')), 'all three conditions share one design identity');
    assert.equal(factsOnly.promptPolicy.wikiSnapshotDigest, SNAPSHOT_DIGEST, 'the snapshot identity stays inside the shared design');
    assert.equal(factsOnly.promptPolicy.studyGoalPolicyVersion, STUDY_GOAL_POLICY_VERSION, 'the study goal policy stays inside the shared design');
    assert.equal(factsOnly.promptPolicy.experienceSelectionPolicyVersion, WIKI_SELECTION_POLICY_VERSION, 'the D policy stays inside the shared design');
    assert.ok(factsOnly.matrix && factsOnly.budgets && factsOnly.code && factsOnly.provider && factsOnly.families, 'model/source/matrix/budget fields are never dropped');
    // Drift is never hidden: each of these must change the shared design identity.
    assert.notDeepEqual(factsOnly, sharedDesign(studyConfig('facts-only', { promptPolicy: { wikiSnapshotDigest: `sha256:${'e'.repeat(64)}` } })), 'a different Wiki snapshot is a different design');
    assert.notDeepEqual(factsOnly, sharedDesign(studyConfig('facts-only', { provider: { model: DIFFERENT_MODEL } })), 'a different observed model is a different design');
    assert.notDeepEqual(factsOnly, sharedDesign(studyConfig('facts-only', { code: { commit: 'f'.repeat(40) } })), 'a different source commit is a different design');
    assert.notDeepEqual(factsOnly, sharedDesign(studyConfig('facts-only', { code: { contentDigest: `sha256:${'1'.repeat(64)}` } })), 'different source bytes are a different design');
    assert.notDeepEqual(factsOnly, sharedDesign(studyConfig('facts-only', { promptPolicy: { experienceSelectionPolicyVersion: EXPERIENCE_SELECTION_POLICY_VERSION } })), 'a different selection policy is a different design');
    // The condition itself is still part of the recorded standard fingerprint.
    assert.notEqual(buildConfigFingerprint(studyConfig('facts-only'), { code: config.code }).fingerprint,
      buildConfigFingerprint(studyConfig('local-only'), { code: config.code }).fingerprint,
      'the explicit condition is retained in the standard configuration fingerprint');
  });

  await test('matrix 13b: the production driver and the standard N20 refuse a study environment before any effect', async () => {
    // The two production entry points themselves must reject a study environment — not a
    // fixture that only restates the rule. The driver is exercised as the real CLI child, and
    // the standard N20 mode through its documented hardware-free port path, so this case proves
    // the refusal order (validate first, then everything else) instead of merely echoing a flag.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'operator-study-guards-'));
    roots.push(rootDir);
    const artifactRoot = path.join(rootDir, 'artifacts');
    await mkdir(artifactRoot, { recursive: true });
    const snapshotFile = path.join(rootDir, 'wiki-snapshot.json');
    await writeJson(snapshotFile, snapshotFor());
    const absentSnapshot = path.join(rootDir, 'absent-snapshot.json');
    const providerDir = path.join(rootDir, 'providers');
    await mkdir(providerDir, { recursive: true });
    // The provider CLI and the Python executable are pinned to paths that do not exist, so a
    // driver that wrongly continued could reach neither a model nor a device; the case would
    // then fail on the retained run root and the non-zero exit instead of doing real work.
    const driverEnv = {
      ...process.env,
      E2E_AGENT_RUNTIME: 'claude-code',
      E2E_GPU_ARTIFACT_DIR: artifactRoot,
      OPERATOR_DATA_DIR: path.join(rootDir, 'data'),
      OPERATOR_RUNTIME_DIR: path.join(rootDir, 'runtime'),
      OPERATOR_GPU_PYTHON: path.join(providerDir, 'absent-python.exe'),
      OPERATOR_CLAUDE_BIN: path.join(providerDir, 'absent-cli.exe'),
    };
    const runDriver = async (extra, label) => {
      const child = spawn(process.execPath, ['scripts/e2e-shared-gpu-agent-iteration.mjs'], {
        cwd: path.resolve(import.meta.dirname, '..'), shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...driverEnv, ...extra },
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await Promise.race([
        new Promise((resolve) => child.once('exit', (code) => resolve(code))),
        sleep(20_000).then(() => { child.kill('SIGKILL'); return 'deadline'; }),
      ]);
      assert.notEqual(exitCode, 0, `${label}: the production driver must refuse this environment (output: ${output.slice(0, 300)})`);
      return output;
    };
    // The ambient environment of this test process must not leak a condition into the cases:
    // each case sets exactly the variables it describes.
    const ambient = {};
    for (const key of ['E2E_EXPERIENCE_CONDITION', 'E2E_KERNEL_WIKI_SNAPSHOT', 'OPERATOR_EXPERIENCE_CONDITION']) {
      ambient[key] = process.env[key];
      delete process.env[key];
    }
    try {
      await runDriver({ E2E_EXPERIENCE_CONDITION: 'facts-only-and-wiki' }, 'an unknown study condition');
      await runDriver({ E2E_EXPERIENCE_CONDITION: 'local-only', E2E_KERNEL_WIKI_SNAPSHOT: absentSnapshot }, 'a study condition without a snapshot file');
      await runDriver({ E2E_EXPERIENCE_CONDITION: 'facts-only', E2E_KERNEL_WIKI_SNAPSHOT: path.join('relative', 'wiki-snapshot.json') },
        'a study condition with a relative snapshot path');
      await runDriver({ E2E_KERNEL_WIKI_SNAPSHOT: snapshotFile }, 'a snapshot without a study condition');
      // The real CLI's policy metadata is validated against real artifacts and the public
      // entry points, not against a literal retyped in this fixture: the frozen snapshot the
      // driver was handed is the same document the production KernelWiki contract builds, and
      // the D selection policy version the driver must record is the production export.
      assert.equal(typeof WIKI_SELECTION_POLICY_VERSION, 'string');
      assert.notEqual(WIKI_SELECTION_POLICY_VERSION, EXPERIENCE_SELECTION_POLICY_VERSION);
      assert.equal(buildConfigFingerprint(studyConfig('facts-only', { promptPolicy: { experienceSelectionPolicyVersion: WIKI_SELECTION_POLICY_VERSION } })).comparable, true);
      // Nothing was retained: the refusal happens before a run root, a raw log or a state write.
      assert.deepEqual(await readdir(artifactRoot), [], 'a refused driver environment retains no run root under the artifact parent');
      for (const name of ['data', 'runtime']) {
        const dir = path.join(rootDir, name);
        if (existsSync(dir)) assert.deepEqual(await readdir(dir), [], `a refused driver environment writes no state into its ${name} directory`);
      }
      // The standard N20 mode must refuse a study environment before its first spawn: a study
      // slot can never be relabelled as a strict N20 sample, and the batch is exercised through
      // its documented injected-port path, so no driver child is started by this case either.
      const n20Artifact = path.join(rootDir, 'n20-artifacts');
      const n20Report = path.join(rootDir, 'n20-report');
      await mkdir(n20Artifact, { recursive: true });
      for (const [key, value] of Object.entries({ E2E_EXPERIENCE_CONDITION: 'local-only', E2E_KERNEL_WIKI_SNAPSHOT: snapshotFile })) {
        process.env[key] = value;
      }
      const { runRegressionBatch } = await import('../scripts/run-shared-gpu-regression-batch.mjs');
      let spawns = 0;
      const refused = await runRegressionBatch({
        mode: 'n20', families: ['affine'], artifactDir: n20Artifact, reportDir: n20Report,
        gpuPython: path.join(providerDir, 'absent-python.exe'),
      }, {
        invokeDriver: async () => { spawns += 1; return { exitCode: 0, signal: null, runRoot: null }; },
      }).then(() => null, (error) => error);
      assert.ok(refused instanceof Error, 'the standard N20 mode must refuse a study environment instead of running strict samples');
      assert.equal(spawns, 0, 'no N20 invocation is spawned under a study environment');
      assert.equal(existsSync(n20Report), false, 'the refusal happens before any report directory is created');
      assert.deepEqual(await readdir(n20Artifact), [], 'the refusal happens before any artifact or log is written');
    } finally {
      for (const [key, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // --- default smoke adapter: the three frozen real-child scenarios -------------------------
  //
  // EXPERIENCE_STUDY_SPAWN_CONTRACT.md freezes these three cases on the real exported default
  // adapter (`createDefaultInvokeSmoke`), never on the injected `invokeSmoke` fixture port: each
  // scenario starts one genuinely inert local Node child of its own, in its own temporary
  // directory. The child validates the fixed smoke argv, the fixed affine family, the
  // condition/snapshot environment and its own exclusive report-directory creation, then emits
  // one distinct stdout marker and one distinct stderr marker. No provider, Python, network,
  // Acagemm runtime or GPU is contacted. What is asserted is behavior — where the raw log lands,
  // what it contains, which exit code survives and what happens to a pre-existing report
  // directory — never implementation source text. Each child reports its own documented marker
  // and exit code instead of relying on an uncaught assertion, so every scenario can prove which
  // check really stopped it.

  // The inert child is written outside the repository. It is a fixture, not a stand-in for the
  // production smoke CLI: the adapter under test spawns it exactly the way it spawns the fixed
  // production script (same executable, same argv shape, same environment propagation, same
  // stream capture, same exit semantics).
  const inertChildSource = (plan) => [
    "'use strict';",
    '// Inert local fixture child: no provider, Python, network, Acagemm runtime or GPU.',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const plan = ${JSON.stringify(plan)};`,
    // Synchronous fd writes, so a marker can never be truncated by an immediate process.exit.
    "const fail = (code, marker) => { fs.writeSync(2, marker + '\\n'); process.exit(code); };",
    'const argv = process.argv.slice(2);',
    "if (JSON.stringify(argv) !== JSON.stringify(plan.argv)) fail(11, 'STUDY-CHILD-ARGV-MISMATCH: ' + JSON.stringify(argv));",
    "if (process.env.E2E_EXPERIENCE_CONDITION !== plan.condition) fail(12, 'STUDY-CHILD-CONDITION-MISMATCH');",
    "if (process.env.E2E_KERNEL_WIKI_SNAPSHOT !== plan.snapshot) fail(13, 'STUDY-CHILD-SNAPSHOT-MISMATCH');",
    "if (!plan.preexisting && fs.existsSync(plan.reportDir)) fail(21, 'STUDY-CHILD-REPORT-EXISTS-BEFORE-CHILD');",
    'try { fs.mkdirSync(plan.reportDir); }',
    'catch (error) {',
    "  if (plan.preexisting && error.code === 'EEXIST') fail(21, 'STUDY-CHILD-EXCLUSIVE-MKDIR-EEXIST');",
    "  fail(22, 'STUDY-CHILD-MKDIR-FAILED: ' + error.code);",
    '}',
    'if (plan.receiptFile !== null) {',
    '  fs.writeFileSync(path.join(plan.reportDir, plan.receiptFile), JSON.stringify({',
    '    argv, reportDir: plan.reportDir, condition: process.env.E2E_EXPERIENCE_CONDITION,',
    '    snapshot: process.env.E2E_KERNEL_WIKI_SNAPSHOT, exclusiveMkdir: true,',
    '  }, null, 2));',
    '}',
    "fs.writeSync(1, plan.stdoutMarker + '\\n');",
    "fs.writeSync(2, plan.stderrMarker + '\\n');",
    'process.exit(plan.exitCode);',
    '',
  ].join('\n');

  // One inert child, its own temporary artifact parent, report directory, snapshot file and
  // Python placeholder, plus one unique pair of stream markers, so no case can be satisfied by
  // another case's bytes and no case can inherit a cached result.
  const spawnFixture = async ({ label, condition, index, preexistingReport = false, exitCode = 0 }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `operator-study-spawn-${label}-`));
    roots.push(root);
    const artifactDir = path.join(root, 'artifacts');
    const reportDir = path.join(root, 'report');
    const snapshot = path.join(root, 'wiki-snapshot.json');
    const gpuPython = path.join(root, 'python.exe');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(snapshot, '{"schemaVersion":"fixture"}\n', 'utf8');
    await writeFile(gpuPython, '', 'utf8');
    const token = sha256(`${label}:${index}:${Date.now()}:${Math.random()}`).slice(0, 16);
    // A child planned to exit nonzero still claims success on stdout, as an explicit JSON
    // declaration rather than a neutral token: the nonzero scenario only means something if the
    // raw log really carries a marker that says success/complete next to the real failure. The
    // green scenarios keep the plain token, so success-looking bytes exist exactly where a case
    // asserts they cannot replace the real exit code.
    const stdoutMarker = exitCode === 0
      ? `STUDY-SMOKE-STDOUT ${token}`
      : JSON.stringify({ success: true, status: 'completed', marker: `STUDY-SMOKE-SUCCESS ${token}` });
    const stderrMarker = `STUDY-SMOKE-STDERR ${token}`;
    // The frozen smoke argv: mode smoke, the affine family and the three explicit paths.
    const argv = ['--mode', 'smoke', '--families', 'affine', '--artifact-dir', artifactDir,
      '--report-dir', reportDir, '--gpu-python', gpuPython];
    const script = path.join(root, `inert-smoke-child-${index}.cjs`);
    await writeFile(script, inertChildSource({
      argv, condition, snapshot, reportDir, preexisting: preexistingReport, exitCode,
      receiptFile: exitCode === 0 ? 'child-receipt.json' : null, stdoutMarker, stderrMarker,
    }), 'utf8');
    const invoke = createDefaultInvokeSmoke({ cwd: root, script });
    return {
      root, artifactDir, reportDir, snapshot, gpuPython, argv, script, invoke, stdoutMarker,
      stderrMarker,
      portInput: { index, condition, artifactDir, reportDir, snapshot, gpuPython },
      logPath: path.join(artifactDir, 'logs', `slot-${String(index).padStart(2, '0')}.log`),
    };
  };
  const nonEmptyLines = (text) => text.split('\n').filter((line) => line !== '');

  await test('spawn 1: the real default adapter starts an inert child that creates its report directory exclusively and both streams land in artifactDir/logs', async () => {
    const fixture = await spawnFixture({ label: 'exclusive', condition: 'local-and-wiki', index: 1 });
    const result = await fixture.invoke(fixture.portInput);
    assert.equal(result.exitCode, 0, `the inert child must exit zero (issues: ${JSON.stringify(failureOf(result.issues))})`);
    assert.equal(result.signal, null);
    // The frozen layout: the parent's raw log lives under artifactDir/logs, exactly where the
    // retained slot logPath points. The old defect opened reportDir/logs/slot-NN.log instead,
    // which created reportDir and made the child's exclusive mkdir fail, so the old real log
    // path fails this case on both counts (no log at the frozen path, nonzero child exit).
    assert.equal(existsSync(fixture.logPath), true, 'the raw log is written under artifactDir/logs');
    assert.equal(existsSync(path.join(fixture.reportDir, 'logs')), false,
      'the parent creates no logs directory inside the child-owned report directory');
    assert.deepEqual((await readdir(fixture.artifactDir)).sort(), ['logs'],
      'the artifact parent carries only the raw log directory, never a report directory');
    // Both streams really arrived in the one raw log: the child wrote exactly these two markers
    // and nothing else, so an extra, missing, duplicated or substituted line is a failure.
    const log = await readFile(fixture.logPath, 'utf8');
    assert.deepEqual(nonEmptyLines(log).sort(), [fixture.stdoutMarker, fixture.stderrMarker].sort(),
      'the raw log carries exactly the child\'s own stdout and stderr markers, both streams in one log');
    // The child only reached its markers because its report directory did not exist before it
    // started and because its own non-recursive mkdir succeeded. The parent created neither the
    // report directory nor anything inside it.
    assert.deepEqual(await readdir(fixture.reportDir), ['child-receipt.json'],
      'the report directory holds only what the child itself wrote');
    const receipt = JSON.parse(await readFile(path.join(fixture.reportDir, 'child-receipt.json'), 'utf8'));
    assert.deepEqual(receipt.argv, fixture.argv, 'the child received the fixed smoke argv for the affine family');
    assert.equal(receipt.condition, 'local-and-wiki', 'the fixed condition reached the child environment');
    assert.equal(receipt.snapshot, fixture.snapshot, 'the fixed snapshot path reached the child environment');
    assert.equal(receipt.exclusiveMkdir, true, 'the child created its report directory exclusively');
  });

  await test('spawn 2: a success-looking child marker never masks the real nonzero exit code or truncates the raw log', async () => {
    const fixture = await spawnFixture({ label: 'nonzero', condition: 'facts-only', index: 2, exitCode: 3 });
    const result = await fixture.invoke(fixture.portInput);
    // The real child exit code is the authority; a self-reported success on stdout can never
    // replace it, and no success-shaped field may be minted into the returned port value.
    assert.equal(result.exitCode, 3, 'the real child exit code is preserved verbatim');
    assert.equal(result.signal, null);
    for (const key of ['success', 'fullSuccess', 'passed', 'ok', 'verified']) {
      if (key in result) assert.notEqual(result[key], true, `the port must not report ${key}: true for a nonzero child`);
    }
    assert.equal(existsSync(fixture.logPath), true, 'the raw log of a failed child is still written under artifactDir/logs');
    const log = await readFile(fixture.logPath, 'utf8');
    // The complete raw log survives: the success-looking marker is retained as evidence, not
    // dropped or rewritten, and the real failure marker sits next to it.
    assert.equal(log.includes(fixture.stdoutMarker), true, 'the success-looking stdout marker is retained in full');
    assert.equal(log.includes(fixture.stderrMarker), true, 'the real stderr marker is retained in full');
    assert.deepEqual(nonEmptyLines(log).sort(), [fixture.stdoutMarker, fixture.stderrMarker].sort(),
      'the complete raw log is preserved instead of being replaced by a synthetic receipt');
    // The surviving stdout line is a real success-looking declaration, read back from the
    // retained log rather than from this fixture's own variable: the case is only meaningful if
    // the raw bytes themselves claim success next to the real nonzero exit code.
    const claimed = JSON.parse(nonEmptyLines(log).find((line) => line !== fixture.stderrMarker));
    assert.equal(claimed.success, true, 'the retained stdout marker really declares success');
    assert.equal(claimed.status, 'completed', 'the retained stdout marker really declares a completed status');
    assert.equal(typeof claimed.marker, 'string', 'the retained stdout marker keeps its own identity');
    assert.equal(result.exitCode, 3, 'the declared success still does not replace the real child exit code');
    assert.equal(existsSync(path.join(fixture.reportDir, 'logs')), false,
      'no parent log directory appears inside the child report directory');
    assert.deepEqual(await readdir(fixture.reportDir), [],
      'the nonzero child writes no receipt into its report directory');
    assert.deepEqual((await readdir(fixture.artifactDir)).sort(), ['logs']);
  });

  await test('spawn 3: a pre-existing report directory is never overwritten and the child exclusive mkdir fails nonzero', async () => {
    const fixture = await spawnFixture({ label: 'preexisting', condition: 'local-only', index: 3, preexistingReport: true });
    const sentinel = Buffer.from('pre-existing slot report: these bytes are never overwritten\n', 'utf8');
    await mkdir(fixture.reportDir, { recursive: true });
    await writeFile(path.join(fixture.reportDir, 'sentinel.txt'), sentinel);
    const before = (await readdir(fixture.reportDir)).sort();
    const result = await fixture.invoke(fixture.portInput);
    // The child really attempted its exclusive mkdir against the existing directory, got EEXIST
    // and refused with its own nonzero code; the parent preserves that code.
    assert.equal(result.exitCode, 21, 'the child exclusive mkdir refuses a pre-existing report directory with a nonzero exit');
    assert.equal(existsSync(fixture.logPath), true, 'the refusal is still retained in the raw log under artifactDir/logs');
    const log = await readFile(fixture.logPath, 'utf8');
    assert.equal(log.includes('STUDY-CHILD-EXCLUSIVE-MKDIR-EEXIST'), true,
      'the retained raw log names the real exclusive-mkdir refusal');
    assert.deepEqual((await readdir(fixture.reportDir)).sort(), before,
      'the pre-existing report directory keeps exactly its original entries');
    assert.deepEqual(await readFile(path.join(fixture.reportDir, 'sentinel.txt')), sentinel,
      'the pre-existing sentinel keeps its exact bytes');
    assert.equal(existsSync(path.join(fixture.reportDir, 'logs')), false,
      'the parent never creates its log directory inside the pre-existing report directory');
    assert.deepEqual((await readdir(fixture.artifactDir)).sort(), ['logs'],
      'the parent log still lands under its own artifact parent, not in the child report directory');
  });
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`Experience condition study: ${passed} cases passed, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
