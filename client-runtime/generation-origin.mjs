import { randomUUID } from 'node:crypto';
import { normalizeMissionTargetProfile } from './mission-target-profile.mjs';
import { canonicalJson, contentDigest } from './execution-package-contract.mjs';

export const GENERATION_ORIGIN_SCHEMA = 'operator-studio.generation-origin/v1';
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const reject = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };

// Creation-only metadata. Legacy Missions remain explicitly unattributed.
export function createExperimentIdentity(input = undefined) {
  const value = input === undefined ? {} : input;
  const fail = () => { throw Object.assign(new Error('Invalid experiment identity.'), { code: 'INVALID_EXPERIMENT_IDENTITY', status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !['id', 'batchId', 'taskId', 'replicate', 'condition', 'manifestDigest'].includes(key))) fail();
  for (const key of ['id', 'batchId', 'taskId', 'condition']) if (value[key] !== undefined && !identity(value[key])) fail();
  if (value.replicate !== undefined && (!Number.isSafeInteger(value.replicate) || value.replicate < 1)) fail();
  if (value.manifestDigest !== undefined && (typeof value.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest))) fail();
  return {
    id: value.id || `experiment_${randomUUID()}`,
    batchId: value.batchId || null, taskId: value.taskId || null,
    replicate: value.replicate ?? null, condition: value.condition || null,
    manifestDigest: value.manifestDigest || null,
  };
}

export function captureGenerationOrigin({ state, mission, checkpoint = null, goal, capturedAt }) {
  if (checkpoint?.missionId && checkpoint.missionId !== mission.id) {
    reject('GENERATION_ORIGIN_CONFLICT', 'Generation checkpoint belongs to another Mission.');
  }
  const best = state.currentBest || {};
  const observed = checkpoint?.missionId === mission.id && typeof checkpoint?.stableDigest === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(checkpoint.stableDigest);
  const bound = observed && best.candidateId && best.candidateDigest === checkpoint.stableDigest;
  const conditions = JSON.parse(JSON.stringify({
    ...(mission.targetProfile != null ? { targetProfile: normalizeMissionTargetProfile(mission.targetProfile, mission.hardware) } : {}),
    semanticDigest: mission.semanticSnapshot?.digest || null,
    testMatrix: state.testMatrix || mission.testMatrix || null,
    implementation: mission.implementation || null, goal: goal || mission.goal || null,
  }));
  return {
    schemaVersion: GENERATION_ORIGIN_SCHEMA,
    missionId: mission.id, projectId: mission.projectId || null,
    experiment: structuredClone(mission.experiment || null),
    attemptOrigin: structuredClone(mission.attemptOrigin || null),
    roundId: state.iterationStats?.roundBudget?.roundId || null,
    capturedAt, conditions, conditionsDigest: contentDigest(canonicalJson(conditions)),
    workspace: observed ? { checkpointId: checkpoint.id || null, digest: checkpoint.stableDigest, capturedAt: checkpoint.createdAt || null } : null,
    parent: {
      status: bound ? 'bound_current_best' : observed ? 'workspace_unattributed' : 'not_observed',
      candidateId: bound ? best.candidateId : null,
      candidateDigest: bound ? best.candidateDigest : null,
      sourceRunId: bound ? best.sourceRunId || null : null,
    },
  };
}

// Replays reuse the first frozen identity, but a changed start workspace or
// contract cannot silently borrow that identity for a different generation.
export function freezeGenerationOrigin(previous, observed) {
  if (previous === undefined) return structuredClone(observed);
  if (!previous || previous.schemaVersion !== GENERATION_ORIGIN_SCHEMA
    || previous.missionId !== observed.missionId || previous.projectId !== observed.projectId
    || previous.roundId !== observed.roundId || previous.conditionsDigest !== observed.conditionsDigest
    || canonicalJson(previous.experiment) !== canonicalJson(observed.experiment)
    || canonicalJson(previous.attemptOrigin ?? null) !== canonicalJson(observed.attemptOrigin ?? null)
    || (previous.workspace?.digest || null) !== (observed.workspace?.digest || null)) {
    reject('GENERATION_ORIGIN_CONFLICT', 'Generation origin changed after admission.');
  }
  return structuredClone(previous);
}

export function elapsedObservation(startedAt, completedAt) {
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  const end = typeof completedAt === 'string' ? Date.parse(completedAt) : NaN;
  const valid = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  return {
    startedAt: Number.isFinite(start) ? startedAt : null,
    completedAt: Number.isFinite(end) ? completedAt : null,
    durationMs: valid ? end - start : null,
    status: valid ? 'observed' : Number.isFinite(start) && Number.isFinite(end) ? 'clock_conflict' : 'not_observed',
  };
}

export function generationTimings(agent = {}) {
  return {
    preparation: elapsedObservation(agent.preparationStartedAt, agent.preparationCompletedAt),
    generation: elapsedObservation(agent.startedAt, agent.generationCompletedAt),
  };
}

export function testTimings(benchmark = {}) {
  return {
    queue: elapsedObservation(benchmark.submittedAt, benchmark.submissionStartedAt),
    dispatch: elapsedObservation(benchmark.submissionStartedAt, benchmark.executionStartedAt),
    test: elapsedObservation(benchmark.executionStartedAt, benchmark.completedAt),
  };
}
