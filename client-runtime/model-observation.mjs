// Frozen response-model observation contract (docs/development/MODEL_OBSERVATION_ACCEPTANCE.md).
//
// Pure, I/O-free. This module is the single validation authority for the DTO:
// `observeClaudeModel` derives it from raw Claude stream metadata,
// `bindModelObservation` re-validates and deep-detaches it against an exact run
// identity, and `summarizeModelObservations` aggregates only comparable per-run
// evidence. Nothing here reads the environment, files, network or time.
//
// The responding model is provider-reported `assistant.message.model`. Labels in
// system.init (`configuredModels`) and result.modelUsage (`usageModels`) are
// retained as diagnostics only; they never establish an observation.

export const MODEL_OBSERVATION_SCHEMA_VERSION = 'operator-studio.model-observation/v1';
export const MODEL_OBSERVATION_PROVIDER = 'claude-code';
export const MODEL_OBSERVATION_SOURCE = 'assistant.message.model';

const DTO_KEYS = Object.freeze([
  'configuredModels', 'missionId', 'model', 'models', 'observations', 'provider',
  'reasons', 'runId', 'schemaVersion', 'sessionId', 'source', 'status', 'usageModels',
]);
const OBSERVATION_KEYS = Object.freeze(['eventIndex', 'model', 'sessionId']);
const STATUS_VALUES = Object.freeze(['observed', 'unknown', 'conflict']);
// case-insensitive sentinels that are never a real responding-model label
const SENTINEL_MODELS = new Set(['unknown', 'null', 'undefined', '<synthetic>']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonBlankString = (value) => typeof value === 'string' && value.trim().length > 0;
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
// Identity strings are never trimmed or otherwise normalized: only their exact
// bytes identify a run. `' s '` and `'s'` are different sessions.
const identityString = (value) => (typeof value === 'string' ? value : '');
const isModelLabel = (value) => {
  const model = trimmed(value);
  return model.length > 0 && !SENTINEL_MODELS.has(model.toLowerCase());
};
// Arrays of model strings are trimmed, unique and sorted by construction.
const normalizeModelList = (values = []) => {
  const unique = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (isModelLabel(value)) unique.add(trimmed(value));
  }
  return [...unique].sort();
};
const isNormalizedModelList = (values) => Array.isArray(values)
  && values.every((value) => typeof value === 'string' && value === trimmed(value) && isModelLabel(value))
  && new Set(values).size === values.length
  && values.every((value, index) => index === 0 || values[index - 1] < value);
const hasExactKeys = (value, keys) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

const buildDto = ({ runId, missionId, sessionId, status, model, source, models, configuredModels, usageModels, observations, reasons }) => ({
  schemaVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
  provider: MODEL_OBSERVATION_PROVIDER,
  runId,
  missionId,
  sessionId,
  status,
  model,
  source,
  models,
  configuredModels,
  usageModels,
  observations,
  reasons,
});

const readModelUsageKeys = (event) => {
  const usage = event?.modelUsage;
  if (!isPlainObject(usage)) return [];
  return Object.keys(usage);
};

/**
 * Derive the frozen DTO from raw Claude stream events. Only response metadata is
 * read; text, thinking and tool payloads are never copied.
 */
export const observeClaudeModel = ({ runId, missionId, sessionId, events = [] } = {}) => {
  const runKey = identityString(runId);
  const missionKey = identityString(missionId);
  const identitySession = identityString(sessionId);
  // All three identities must be nonblank and are compared by exact bytes; a run
  // with a blank identity can never be `observed` (it could not be bound later).
  const identityComplete = isNonBlankString(runKey)
    && isNonBlankString(missionKey)
    && isNonBlankString(identitySession);
  const eventList = Array.isArray(events) ? events : [];

  const configured = [];
  const usage = [];
  const observations = [];
  const concreteModels = new Set();
  const reasons = [];
  let assistantCount = 0;
  let invalidResponseCount = 0;
  let missingSessionCount = 0;
  let foreignSessionCount = 0;

  for (const [eventIndex, event] of eventList.entries()) {
    if (!isPlainObject(event)) continue;
    if (event.type === 'system' && event.subtype === 'init') {
      if (isModelLabel(event.model)) configured.push(event.model);
      continue;
    }
    if (event.type === 'result') {
      usage.push(...readModelUsageKeys(event));
      continue;
    }
    if (event.type !== 'assistant') continue;
    assistantCount += 1;
    const eventSession = event.session_id;
    if (!isNonBlankString(eventSession)) { missingSessionCount += 1; continue; }
    // Exact byte comparison: a session is never normalized into another identity.
    if (!identityComplete || eventSession !== identitySession) { foreignSessionCount += 1; continue; }
    const model = trimmed(event?.message?.model);
    if (!isModelLabel(model)) { invalidResponseCount += 1; continue; }
    concreteModels.add(model);
    observations.push({ eventIndex, sessionId: eventSession, model });
  }

  const models = [...concreteModels].sort();
  const configuredModels = normalizeModelList(configured);
  const usageModels = normalizeModelList(usage);

  if (models.length > 1) {
    reasons.push('multiple concrete response models in the same run stream');
    return buildDto({
      runId: runKey, missionId: missionKey, sessionId: identitySession,
      status: 'conflict', model: null, source: null,
      models, configuredModels, usageModels, observations, reasons,
    });
  }
  if (!identityComplete) {
    // A blank identity can never bind, so it can never be observed; the raw
    // (never trimmed) identity bytes are still reported back to the caller.
    reasons.push('run identity (runId/missionId/sessionId) must be nonblank');
    return buildDto({
      runId: runKey, missionId: missionKey, sessionId: identitySession,
      status: 'unknown', model: null, source: null,
      models: [], configuredModels, usageModels, observations: [], reasons,
    });
  }
  if (assistantCount === 0) {
    reasons.push('no assistant response metadata in the run stream');
    return buildDto({
      runId: runKey, missionId: missionKey, sessionId: identitySession,
      status: 'unknown', model: null, source: null,
      models: [], configuredModels, usageModels, observations: [], reasons,
    });
  }
  if (missingSessionCount + foreignSessionCount + invalidResponseCount > 0) {
    if (missingSessionCount > 0) reasons.push(`${missingSessionCount} assistant response(s) had no session_id`);
    if (foreignSessionCount > 0) reasons.push(`${foreignSessionCount} assistant response(s) came from a foreign session`);
    if (invalidResponseCount > 0) reasons.push(`${invalidResponseCount} assistant response(s) had no valid model metadata`);
    return buildDto({
      runId: runKey, missionId: missionKey, sessionId: identitySession,
      status: 'unknown', model: null, source: null,
      models: [], configuredModels, usageModels, observations: [], reasons,
    });
  }
  const model = models[0];
  return buildDto({
    runId: runKey, missionId: missionKey, sessionId: identitySession,
    status: 'observed', model, source: MODEL_OBSERVATION_SOURCE,
    models: [model], configuredModels, usageModels, observations, reasons: [],
  });
};

const validateObservation = (observation, sessionId) => isPlainObject(observation)
  && hasExactKeys(observation, OBSERVATION_KEYS)
  && Number.isInteger(observation.eventIndex) && observation.eventIndex >= 0
  && isNonBlankString(observation.sessionId) && observation.sessionId === sessionId
  && isModelLabel(observation.model) && observation.model === trimmed(observation.model);

// A verdict reason must be an explicit nonblank explanation, never an empty
// placeholder; unknown/conflict are only meaningful with one.
const isReasonList = (values) => Array.isArray(values) && values.every((value) => isNonBlankString(value));
// `models` is exactly the model set backed by observations: no unbacked model may
// be claimed and no observed model may be hidden from the visible set.
const sameModelSet = (models, observations) => {
  const observed = new Set(observations.map((item) => item.model));
  return models.length === observed.size && models.every((model) => observed.has(model));
};

const validateModelObservationShape = (value) => {
  if (!isPlainObject(value) || !hasExactKeys(value, DTO_KEYS)) return false;
  if (value.schemaVersion !== MODEL_OBSERVATION_SCHEMA_VERSION) return false;
  if (value.provider !== MODEL_OBSERVATION_PROVIDER) return false;
  if (!isNonBlankString(value.runId) || !isNonBlankString(value.missionId) || !isNonBlankString(value.sessionId)) return false;
  if (!STATUS_VALUES.includes(value.status)) return false;
  if (value.model !== null && !(isModelLabel(value.model) && value.model === trimmed(value.model))) return false;
  if (value.source !== null && value.source !== MODEL_OBSERVATION_SOURCE) return false;
  if (!isNormalizedModelList(value.models)) return false;
  if (!isNormalizedModelList(value.configuredModels)) return false;
  if (!isNormalizedModelList(value.usageModels)) return false;
  if (!isReasonList(value.reasons)) return false;
  if (!Array.isArray(value.observations) || !value.observations.every((item) => validateObservation(item, value.sessionId))) return false;
  // Each observation must occupy a distinct position in the captured metadata
  // sequence, and the visible model set must equal the observed one exactly.
  if (new Set(value.observations.map((item) => item.eventIndex)).size !== value.observations.length) return false;
  if (!sameModelSet(value.models, value.observations)) return false;

  if (value.status === 'observed') {
    if (!isModelLabel(value.model) || value.source !== MODEL_OBSERVATION_SOURCE) return false;
    if (value.models.length !== 1 || value.models[0] !== value.model) return false;
    if (value.observations.length === 0) return false;
    // An observed verdict with a retained completeness/error reason is not valid.
    if (value.reasons.length !== 0) return false;
    return value.observations.every((item) => item.model === value.model);
  }
  if (value.status === 'unknown') {
    if (value.model !== null || value.source !== null) return false;
    if (value.models.length !== 0 || value.observations.length !== 0) return false;
    return value.reasons.length > 0;
  }
  // conflict: model/source cleared, several evidence-backed concrete models
  if (value.model !== null || value.source !== null) return false;
  if (value.models.length < 2 || value.observations.length === 0) return false;
  return value.reasons.length > 0;
};

const validateBinding = (binding) => isPlainObject(binding)
  && isNonBlankString(binding.provider)
  && isNonBlankString(binding.runId)
  && isNonBlankString(binding.missionId)
  && isNonBlankString(binding.sessionId);

const deepDetach = (value) => JSON.parse(JSON.stringify(value));

/**
 * Bind a DTO to one exact run identity. Returns a deep detached valid DTO or null.
 * Shape and internal consistency are validated, not just schema/status strings.
 */
export const bindModelObservation = (value, binding) => {
  if (!validateBinding(binding)) return null;
  if (!validateModelObservationShape(value)) return null;
  if (value.provider !== binding.provider) return null;
  if (value.runId !== binding.runId) return null;
  if (value.missionId !== binding.missionId) return null;
  if (value.sessionId !== binding.sessionId) return null;
  return deepDetach(value);
};

// Stable, field-semantic canonical form for duplicate detection. Object key order
// must never turn one valid DTO into a "contradiction"; arrays are already
// normalized (or, for observations, ordered by the captured event index).
const canonicalObservationDto = (dto) => JSON.stringify([
  dto.schemaVersion, dto.provider, dto.runId, dto.missionId, dto.sessionId,
  dto.status, dto.model, dto.source, dto.models, dto.configuredModels,
  dto.usageModels,
  dto.observations.map((item) => [item.eventIndex, item.sessionId, item.model]),
  dto.reasons,
]);

const bindingKey = (binding) => `${binding.provider} ${binding.missionId} ${binding.runId}`;

/**
 * Summarize only comparable per-run evidence. Missing, malformed, foreign or
 * conflicting evidence keeps the status unknown/conflict; it never blocks the
 * surrounding workflow and never upgrades a run to observed.
 */
export const summarizeModelObservations = (observations = [], { requiredRuns = [] } = {}) => {
  const reasons = [];
  const summary = {
    schemaVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
    status: 'unknown',
    model: null,
    modelSource: 'unknown',
    models: [],
    requiredRunCount: 0,
    observedRunCount: 0,
    reasons,
  };
  if (!Array.isArray(observations)) {
    reasons.push('model observation evidence is not an array');
    return summary;
  }
  if (!Array.isArray(requiredRuns)) {
    reasons.push('required run identities are not an array');
    return summary;
  }

  const required = [];
  const seen = new Set();
  let malformedRequired = false;
  for (const run of requiredRuns) {
    if (!validateBinding(run)) { malformedRequired = true; continue; }
    const key = bindingKey(run);
    if (seen.has(key)) { malformedRequired = true; continue; }
    seen.add(key);
    required.push({ provider: run.provider, runId: run.runId, missionId: run.missionId, sessionId: run.sessionId });
  }
  summary.requiredRunCount = required.length;
  if (malformedRequired) reasons.push('required run identities must be nonblank and unique by provider/mission/run');
  if (required.length === 0) {
    reasons.push('no required run identity is available for comparison');
    return summary;
  }

  const perRun = new Map(required.map((run) => [bindingKey(run), []]));
  let foreignEvidence = false;
  for (const candidate of observations) {
    const match = required.find((run) => bindModelObservation(candidate, run));
    if (!match) { foreignEvidence = true; continue; }
    perRun.get(bindingKey(match)).push(bindModelObservation(candidate, match));
  }

  let observedRunCount = 0;
  let incomplete = malformedRequired;
  let conflict = false;
  const modelsAcross = new Set();
  for (const run of required) {
    const distinct = [];
    for (const dto of perRun.get(bindingKey(run))) {
      const serialized = canonicalObservationDto(dto);
      if (!distinct.some((existing) => canonicalObservationDto(existing) === serialized)) distinct.push(dto);
    }
    if (distinct.length === 0) { incomplete = true; continue; }
    if (distinct.length > 1) {
      conflict = true;
      reasons.push(`contradictory duplicate observations for run ${run.runId}`);
      continue;
    }
    const dto = distinct[0];
    if (dto.status === 'observed') {
      observedRunCount += 1;
      modelsAcross.add(dto.model);
      continue;
    }
    if (dto.status === 'conflict') {
      conflict = true;
      for (const model of dto.models) modelsAcross.add(model);
      reasons.push(`conflicting response models for run ${run.runId}`);
      continue;
    }
    incomplete = true;
  }
  summary.observedRunCount = observedRunCount;
  summary.models = [...modelsAcross].sort();

  if (conflict || modelsAcross.size > 1) {
    summary.status = 'conflict';
    summary.model = null;
    summary.modelSource = 'unknown';
    if (!reasons.length) reasons.push('different concrete response models across required runs');
    return summary;
  }
  if (foreignEvidence || incomplete || observedRunCount < required.length) {
    summary.status = 'unknown';
    if (foreignEvidence) reasons.push('observation evidence does not match any required run identity');
    if (observedRunCount < required.length) reasons.push(`${required.length - observedRunCount} required run(s) have no valid observed response model`);
    return summary;
  }
  const [model] = summary.models;
  summary.status = 'observed';
  summary.model = model;
  summary.modelSource = 'observed';
  summary.models = [model];
  return summary;
};
