import { canonicalJson, contentDigest } from './execution-package-contract.mjs';
import { formatExperienceContext } from './experience-contract.mjs';

export const EXPERIMENT_MEMORY_SCHEMA = 'operator-studio.experiment-memory/v1';
export const MEMORY_USE_SCHEMA = 'operator-studio.experiment-memory-use/v1';
const fail = message => { throw Object.assign(new Error(message), { code: 'EXPERIMENT_MEMORY_CONFLICT', status: 409 }); };
const digest = value => { if (!/^[a-f0-9]{64}$/.test(value || '')) fail('Experiment digest is missing or invalid.'); return `sha256:${value}`; };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

export function resolveExperimentMemoryMode(mode, condition) {
  const resolved = mode ?? (condition === 'facts-only' ? 'facts-only-control' : 'fixed-start-learning');
  if (!['fixed-start-learning', 'facts-only-control', 'continuous-chain'].includes(resolved)
    || condition !== (resolved === 'facts-only-control' ? 'facts-only' : 'local-only')) fail('Memory mode and actual retrieval condition disagree.');
  return resolved;
}

// Called only with trusted startup admission + current repository observation.
// The caller owns persistence; client-supplied experiment labels confer no authority.
export function bindMissionExperiment({ state, mission, isolation, repository }) {
  if (!isolation) return mission.experiment;
  const mode = resolveExperimentMemoryMode(isolation.memoryMode, isolation.condition);
  const experiment = mission.experiment;
  if (!experiment?.id || !mission.projectId) fail('A controlled Mission requires an experiment and owning Project.');
  const manifestDigest = digest(isolation.manifestDigest);
  if ((experiment.manifestDigest && experiment.manifestDigest !== manifestDigest)
    || (experiment.condition && experiment.condition !== isolation.condition)) fail('Requested experiment identity conflicts with admitted storage.');
  const previous = (state.missions || []).filter(item => item.id !== mission.id
    && item.experiment?.memory?.storageExperimentId === isolation.experimentId);
  if (mode !== 'continuous-chain' && previous.length) fail('Independent regression requires a new experiment directory for each Mission.');
  if (mode === 'continuous-chain' && previous.some(item => item.projectId !== mission.projectId)) fail('A continuous chain must retain its owning Project authorization.');
  if (!Number.isSafeInteger(repository?.revision) || !Array.isArray(repository?.records)) fail('Current experience store was not observed.');
  const members = previous.map(item => item.experiment.memory.memberIndex);
  if (members.some(value => !Number.isSafeInteger(value) || value < 1) || new Set(members).size !== members.length) fail('Continuous chain membership is inconsistent.');
  const previousMember = previous.sort((a, b) => b.experiment.memory.memberIndex - a.experiment.memory.memberIndex)[0];
  if (!previousMember && (repository.revision !== isolation.initialRepositoryRevision
    || repository.records.length !== isolation.initialRecordCount)) fail('The first Mission must start from the pinned initial store, without pre-run learning.');
  const memory = {
    schemaVersion: EXPERIMENT_MEMORY_SCHEMA, mode, condition: isolation.condition,
    storageExperimentId: isolation.experimentId, manifestDigest,
    initialSnapshotDigest: digest(isolation.snapshotDigest), sourceDigest: digest(isolation.sourceDigest),
    configurationDigest: digest(isolation.configurationDigest),
    initialRepositoryRevision: isolation.initialRepositoryRevision,
    initialRecordCount: isolation.initialRecordCount,
    repositoryRevisionAtCreation: repository.revision, recordCountAtCreation: repository.records.length,
    projectId: mission.projectId, missionId: mission.id,
    memberIndex: (previousMember?.experiment.memory.memberIndex || 0) + 1,
    chainId: mode === 'continuous-chain' ? isolation.experimentId : null,
    previousMissionId: previousMember?.id || null,
    learning: 'append-within-storage-experiment', agentPolicy: isolation.agentPolicy,
  };
  return { ...structuredClone(experiment), manifestDigest, condition: isolation.condition, memory };
}

export function assertMissionExperiment({ mission, isolation }) {
  if (!isolation) {
    if (mission.experiment?.memory) fail('A controlled Mission requires its admitted experiment Runtime.');
    return;
  }
  const memory = mission.experiment?.memory;
  if (!memory || memory.schemaVersion !== EXPERIMENT_MEMORY_SCHEMA || memory.missionId !== mission.id
    || memory.projectId !== mission.projectId || memory.storageExperimentId !== isolation.experimentId
    || memory.manifestDigest !== digest(isolation.manifestDigest)
    || mission.experiment.manifestDigest !== memory.manifestDigest
    || memory.initialSnapshotDigest !== digest(isolation.snapshotDigest)
    || memory.sourceDigest !== digest(isolation.sourceDigest)
    || memory.configurationDigest !== digest(isolation.configurationDigest)
    || memory.condition !== isolation.condition || mission.experiment.condition !== memory.condition
    || memory.mode !== resolveExperimentMemoryMode(isolation.memoryMode, isolation.condition)) fail('Mission does not belong to the admitted experiment memory scope.');
}

// Audits exactly the formatted block included in the actual outgoing prompt.
// This is preparation evidence, not proof of Provider receipt or model benefit.
export function buildExperimentMemoryUse({ mission, roundId, context, selection, prompt, roundFacts, priorRoundRequired = false }) {
  const binding = mission.experiment?.memory;
  if (!binding) return null;
  if (binding.schemaVersion !== EXPERIMENT_MEMORY_SCHEMA || binding.missionId !== mission.id || binding.projectId !== mission.projectId
    || !selection || !context || selection.experienceCondition !== binding.condition
    || selection.projectId !== mission.projectId || selection.missionId !== mission.id || selection.roundId !== roundId
    || selection.contextId !== context.contextId || selection.repositoryRevision !== context.repositoryRevision
    || !Number.isSafeInteger(context.repositoryRevision) || context.repositoryRevision < binding.repositoryRevisionAtCreation) fail('Experience selection is not bound to this experiment/round/store observation.');
  const rendered = formatExperienceContext(context, { projectId: mission.projectId, missionId: mission.id, roundId });
  const selected = context.items.map(({ id, version, source }) => ({ id, version, source }));
  if (!Array.isArray(selection.selected) || !same(selection.selected.map(({ id, version, source }) => ({ id, version, source })), selected)) fail('Audited selected records differ from the prompt context.');
  if (binding.condition === 'facts-only' && selected.length) fail('Facts-only control must not inject optional experience.');
  if (typeof prompt !== 'string' || (rendered && !prompt.includes(rendered))) fail('Actual prompt omits its declared experience context.');
  if (priorRoundRequired && !roundFacts) fail('Prior-round facts cannot be removed by an experience control.');
  if (roundFacts && (roundFacts.target?.missionId !== mission.id || roundFacts.target?.roundId !== roundId
    || !prompt.includes(JSON.stringify(roundFacts, null, 2)))) fail('Actual prompt omits or misbinds required round facts.');
  return {
    schemaVersion: MEMORY_USE_SCHEMA, binding: structuredClone(binding), roundId,
    contextId: context.contextId, repositoryRevision: context.repositoryRevision,
    condition: selection.experienceCondition, selected,
    selectionDigest: contentDigest(canonicalJson(selection)), contextDigest: contentDigest(canonicalJson(context)),
    renderedExperienceDigest: contentDigest(rendered), renderedExperienceBytes: Buffer.byteLength(rendered, 'utf8'),
    query: structuredClone(selection.query ?? context.scope ?? null),
    roundFacts: { required: priorRoundRequired, present: Boolean(roundFacts),
      digest: roundFacts ? contentDigest(canonicalJson(roundFacts)) : null },
    deliveryStage: 'prepared-before-send',
  };
}

export function summarizeExperimentMemory({ experiment, generations }) {
  const binding = experiment?.memory || null;
  const runs = generations.map(run => {
    const memoryUse = run.promptAudit?.memoryUse || null;
    const reasons = [];
    if (!memoryUse) reasons.push('memory_audit_not_recorded');
    else {
      if (!binding || !same(binding, memoryUse.binding)) reasons.push('experiment_binding_mismatch');
      if (memoryUse.schemaVersion !== MEMORY_USE_SCHEMA || memoryUse.deliveryStage !== 'prepared-before-send') reasons.push('unsupported_memory_audit');
      if (run.roundId && memoryUse.roundId !== run.roundId) reasons.push('round_identity_mismatch');
      if (memoryUse.condition !== binding?.condition) reasons.push('retrieval_condition_mismatch');
      if (memoryUse.condition === 'facts-only' && memoryUse.selected?.length) reasons.push('optional_experience_in_control');
      if (memoryUse.roundFacts?.required && !memoryUse.roundFacts?.present) reasons.push('required_feedback_missing');
    }
    return { runId: run.runId, status: reasons.length ? memoryUse ? 'conflict' : 'not_recorded' : 'prepared_audit_consistent',
      reasons, memoryUse: structuredClone(memoryUse) };
  });
  return { binding: structuredClone(binding), mode: binding?.mode || 'not_recorded',
    condition: binding?.condition || null, chainId: binding?.chainId || null,
    independentMemoryScope: binding ? binding.mode !== 'continuous-chain' : null,
    runs, preparedConsistentRuns: runs.filter(run => run.status === 'prepared_audit_consistent').length,
    unknownRuns: runs.filter(run => run.status === 'not_recorded').length,
    conflictingRuns: runs.filter(run => run.status === 'conflict').length,
    limitation: 'Prepared audit consistency does not prove Provider consumption, model benefit or independent-run comparability.' };
}
