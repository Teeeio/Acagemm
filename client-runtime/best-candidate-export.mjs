import { canonicalJson, contentDigest } from './execution-package-contract.mjs';
import { assertPendingCandidateBundle } from './pending-candidate-bundle-contract.mjs';
import { validateEvidenceDecision } from './knowledge-state.mjs';

export const BEST_CANDIDATE_EXPORT_SCHEMA = 'operator-studio.best-candidate-export/v1';
export const BEST_CANDIDATE_SOURCE_SCHEMA = 'operator-studio.best-candidate-source/v1';
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const clone = value => structuredClone(value);
const hash = value => contentDigest(canonicalJson(value));
const referenceKeys = ['missionId', 'candidateId', 'patchDigest', 'manifestDigest', 'sourceRunId',
  'roundId', 'baselineDigest', 'semanticDigest', 'testSpecDigest'];
const decisionMatches = (decision, identity) => validateEvidenceDecision(decision).valid
  && decision.binding.candidateId === identity.candidateId
  && decision.binding.candidateDigest === identity.patchDigest
  && decision.binding.runId === identity.testRunId;
const retainable = decision => decision.correctness.passed === true && decision.benchmark.valid === true
  && (decision.adoption.status === 'allowed'
    || (decision.progress?.status === 'improved_current_best' && decision.progress.retainable === true));
const frozenReferenceFor = benchmark => benchmark?.automaticFrozenCandidate ?? null;
const frozenManifestFor = benchmark => benchmark?.pendingManifestDigest ?? frozenReferenceFor(benchmark)?.manifestDigest;
const bestSnapshot = best => {
  const { frozenCandidate: _reference, ...snapshot } = best;
  return clone(snapshot);
};

// Called only after the ordinary receipt -> Gate -> currentBest transition.
// This does not choose a winner or authorize publication; it records the frozen
// source reference of the winner already retained by that transition.
export const bindRetainedBestCandidate = (state, pending, { settledAt } = {}) => {
  const best = state.currentBest;
  const benchmark = state.benchmark;
  const decision = best?.evidenceDecision;
  const identity = { ...Object.fromEntries(referenceKeys.map(key => [key, pending[key]])),
    testRunId: benchmark?.runId, taskId: benchmark?.testTaskId,
    baselineRunId: state.baseline?.evidence?.runId, baselineTaskId: state.baseline?.evidence?.testTaskId };
  if (!best || best.candidateId !== pending.candidateId || best.candidateDigest !== pending.patchDigest
    || best.evidenceRunId !== identity.testRunId || benchmark?.status !== 'complete'
    || benchmark.purpose !== 'candidate' || frozenManifestFor(benchmark) !== pending.manifestDigest
    || benchmark.resourceRelease?.confirmed !== true || state.baseline?.status !== 'complete'
    || !identity.baselineRunId || !identity.baselineTaskId || !decisionMatches(decision, identity)
    || !retainable(decision)) return false;
  if (best.frozenCandidate?.reference?.manifestDigest === pending.manifestDigest
    && best.frozenCandidate.identity?.testRunId === identity.testRunId) return false;
  if (contentDigest(state.baseline.oracleRunPy || state.baseline.materializer?.result?.runPy || '') !== pending.baselineDigest) {
    throw fail('BEST_CANDIDATE_BASELINE_MISMATCH', '已保留候选的独立基线字节与受测冻结副本不一致。');
  }
  const acceptance = { settledAt, retainedAs: best.retainedAs, targetMet: decision.adoption.status === 'allowed',
    best: bestSnapshot(best), evidenceDecision: clone(decision), gate: clone(state.decisionReview?.gate || null),
    baselineEvidence: clone(state.baseline.evidence),
    benchmark: clone(Object.fromEntries(['status', 'purpose', 'runId', 'testTaskId', 'candidate',
      'pendingManifestDigest', 'automaticFrozenCandidate', 'semanticBinding', 'matrix', 'result', 'comparisonBaseline',
      'executionPackage', 'resourceRelease', 'evidenceDecision'].map(key => [key, benchmark[key] ?? null]))) };
  const evidenceDigest = hash({ identity, acceptance });
  state.currentBest = { ...best, frozenCandidate: { schemaVersion: BEST_CANDIDATE_SOURCE_SCHEMA,
    reference: clone(pending), identity, acceptance, evidenceDigest } };
  return true;
};

export const bindAutomaticBestCandidate = state => {
  const reference = frozenReferenceFor(state.benchmark);
  if (!reference) return false;
  return bindRetainedBestCandidate(state, reference, {
    settledAt: state.decisionReview?.resolvedAt || state.benchmark?.completedAt || new Date().toISOString(),
  });
};

const assertSourceBinding = (best, binding, bundle) => {
  if (!binding || binding.schemaVersion !== BEST_CANDIDATE_SOURCE_SCHEMA) {
    throw fail('BEST_CANDIDATE_SOURCE_UNAVAILABLE', '此最佳候选没有可核验的冻结源码工件；不能用当前待测候选代替，请重新完成冻结测试与反馈。');
  }
  const { reference, identity, acceptance, evidenceDigest } = binding;
  if (!best || !reference || !identity || !acceptance || !acceptance.best || !acceptance.benchmark || referenceKeys.some(key => !identity[key] || identity[key] !== reference[key])
    || ['testRunId', 'taskId', 'baselineRunId', 'baselineTaskId'].some(key => typeof identity[key] !== 'string' || !identity[key])
    || !Number.isFinite(Date.parse(acceptance.settledAt))
    || referenceKeys.some(key => identity[key] !== (key === 'manifestDigest' ? bundle.manifestDigest : bundle.manifest[key]))
    || hash({ identity, acceptance }) !== evidenceDigest
    || canonicalJson(bestSnapshot(best)) !== canonicalJson(acceptance.best)) {
    throw fail('BEST_CANDIDATE_IDENTITY_MISMATCH', '最佳候选、冻结源码及验收回执身份不一致。');
  }
  const benchmark = acceptance.benchmark;
  const decision = acceptance.evidenceDecision;
  if (!decisionMatches(decision, identity) || !retainable(decision)
    || canonicalJson(decision) !== canonicalJson(acceptance.best.evidenceDecision)
    || canonicalJson(decision) !== canonicalJson(benchmark.evidenceDecision ?? acceptance.gate?.decision)
    || (decision.binding.semanticDigest && decision.binding.semanticDigest !== identity.semanticDigest)
    || acceptance.best.candidateId !== identity.candidateId || acceptance.best.candidateDigest !== identity.patchDigest
    || acceptance.best.evidenceRunId !== identity.testRunId || benchmark?.status !== 'complete'
    || benchmark.purpose !== 'candidate' || benchmark.runId !== identity.testRunId || benchmark.testTaskId !== identity.taskId
    || frozenManifestFor(benchmark) !== identity.manifestDigest
    || benchmark.candidate?.id !== identity.candidateId || benchmark.candidate?.digest !== identity.patchDigest
    || benchmark.candidate?.sourceRunId !== identity.sourceRunId
    || benchmark.resourceRelease?.confirmed !== true
    || (benchmark.automaticFrozenCandidate && referenceKeys.some(key => benchmark.automaticFrozenCandidate[key] !== identity[key]))
    || benchmark.comparisonBaseline?.runId !== identity.baselineRunId
    || acceptance.baselineEvidence?.runId !== identity.baselineRunId
    || acceptance.baselineEvidence?.testTaskId !== identity.baselineTaskId
    || canonicalJson(benchmark.matrix) !== canonicalJson(bundle.manifest.testMatrix)
    || benchmark.semanticBinding?.semanticDigest !== identity.semanticDigest
    || benchmark.semanticBinding?.testSpecDigest !== identity.testSpecDigest
    || (benchmark.semanticBinding?.baselineDigest && benchmark.semanticBinding.baselineDigest !== identity.baselineDigest)
    || (benchmark.semanticBinding?.oracleDigest && benchmark.semanticBinding.oracleDigest !== identity.baselineDigest)
    || acceptance.targetMet !== (decision.adoption.status === 'allowed')
    || !bundle.manifest.baseline?.metadata?.kind || !bundle.manifest.baseline.metadata.source
    || !bundle.baseline.size) {
    throw fail('BEST_CANDIDATE_EVIDENCE_MISMATCH', '最佳候选的测试、独立基线或冻结验收条件不完整或不匹配。');
  }
};

const replayFor = (bundle, acceptance) => ({
  schemaVersion: 'operator-studio.best-candidate-replay/v1',
  mode: 'offline-integrity-check',
  candidateDirectory: 'sources', entrypoint: 'sources/' + bundle.manifest.entrypoint,
  baselineFile: 'baseline/oracle.py', baselineDigest: bundle.manifest.baselineDigest,
  baselineProvenance: clone(bundle.manifest.baseline.metadata),
  implementation: clone(bundle.manifest.mission.implementation),
  requestedHardware: clone(bundle.manifest.mission.hardware),
  targetProfile: clone(bundle.manifest.mission.targetProfile ?? null),
  observedEnvironment: clone(acceptance.benchmark.result?.environment ?? null),
  executionPackage: clone(acceptance.benchmark.executionPackage ?? null),
  testMatrix: clone(bundle.manifest.testMatrix), testSpec: clone(bundle.manifest.testSpec),
  contract: 'Candidate run(inputs); the separate frozen baseline/oracle.py supplies get_inputs, reference/run, correctness cases and benchmark inputs. Source and baseline namespaces must remain separate.',
  requirements: 'Install the explicitly selected implementation toolchain and matching target hardware environment before an operator rerun. No model access or original Runtime state is needed to check this package.',
  limitation: 'Offline checking verifies identities and bytes only. It does not execute an operator, certify current-device performance, or grant publication authority.',
});

export const createBestCandidateExport = ({ best, bundle }) => {
  assertPendingCandidateBundle(bundle);
  assertSourceBinding(best, best.frozenCandidate, bundle);
  const binding = best.frozenCandidate;
  const document = { schemaVersion: BEST_CANDIDATE_EXPORT_SCHEMA, identity: clone(binding.identity),
    best: bestSnapshot(best), acceptance: clone(binding.acceptance), evidenceDigest: binding.evidenceDigest,
    bundle: clone(bundle), replay: replayFor(bundle, binding.acceptance) };
  assertBestCandidateExport(document);
  return document;
};

// Shared by the read-only API, materializer and hardware-free replay CLI.
// The hashes are local integrity checks, never execution signatures.
export const assertBestCandidateExport = document => {
  if (!document || document.schemaVersion !== BEST_CANDIDATE_EXPORT_SCHEMA) {
    throw fail('BEST_CANDIDATE_EXPORT_INVALID', '不支持的最佳候选导出格式。');
  }
  assertPendingCandidateBundle(document.bundle);
  const binding = { schemaVersion: BEST_CANDIDATE_SOURCE_SCHEMA,
    reference: { ...document.identity }, identity: document.identity,
    acceptance: document.acceptance, evidenceDigest: document.evidenceDigest };
  assertSourceBinding(document.best, binding, document.bundle);
  if (canonicalJson(document.replay) !== canonicalJson(replayFor(document.bundle, document.acceptance))) {
    throw fail('BEST_CANDIDATE_REPLAY_MISMATCH', '重放说明必须与冻结入口、基线和测试契约一致。');
  }
  return document;
};
