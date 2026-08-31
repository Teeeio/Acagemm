import { createHash } from 'node:crypto';

export const SEMANTIC_SNAPSHOT_SCHEMA = 'operator-studio.semantic-snapshot/v1';
export const SEMANTIC_SNAPSHOT_STATUSES = Object.freeze(['draft', 'needs_review', 'ready_to_freeze', 'frozen', 'superseded']);

const clone = (value) => value == null ? value : structuredClone(value);

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const normalizeText = (value) => String(value ?? '').trim();

const normalizeList = (value) => Array.isArray(value)
  ? value.map((item) => typeof item === 'string' ? item.trim() : clone(item)).filter((item) => item !== '' && item != null)
  : [];

// Object key ordering is the only canonicalization performed here. Array order can
// carry meaning for test cases, benchmark profiles, and source precedence.
export const canonicalizeSemanticValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeSemanticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeSemanticValue(value[key])]));
};

export const canonicalSemanticJson = (value) => JSON.stringify(canonicalizeSemanticValue(value));

const digestPayload = (snapshot) => {
  const normalized = normalizeSemanticSnapshot(snapshot);
  const { digest: _digest, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = normalized;
  return payload;
};

export const semanticSnapshotDigest = (snapshot) => `sha256:${createHash('sha256').update(canonicalSemanticJson(digestPayload(snapshot))).digest('hex')}`;

const defaultSemanticContract = (mission = {}, draft = {}) => ({
  operator: draft.operator || mission.operator || mission.title || null,
  aliases: normalizeList(draft.aliases),
  execution: clone(draft.execution || {}),
  inputs: clone(draft.inputs || []),
  outputs: clone(draft.outputs || []),
  math: clone(draft.math || {}),
  masks: clone(draft.masks || {}),
  cache: clone(draft.cache || {}),
  edgeCases: clone(draft.edgeCases || {}),
  invariants: normalizeList(draft.invariants),
  immutableRules: normalizeList(draft.immutableRules || mission.operatorProfile?.immutableRules),
  profileId: mission.operatorProfile?.id || draft.profileId || null,
  profile: clone(draft.profile || mission.operatorProfile || null),
});

const defaultCorrectnessContract = (mission = {}, draft = {}) => ({
  testSpec: clone(draft.testSpec || mission.testMatrix?.testSpec || null),
  invariants: normalizeList(draft.invariants || mission.operatorProfile?.correctnessRequirements),
  requiredCategories: normalizeList(draft.requiredCategories || mission.testMatrix?.testSpec?.correctness?.requiredCategories),
  uncovered: normalizeList(draft.uncovered),
});

const defaultBenchmarkContract = (mission = {}, draft = {}) => ({
  testSpec: clone(draft.testSpec || mission.testMatrix?.testSpec?.benchmark || null),
  profiles: clone(draft.profiles || mission.testMatrix?.benchmarkProfiles || []),
  primaryProfile: draft.primaryProfile || mission.testMatrix?.testSpec?.benchmark?.primaryProfile || null,
  environments: normalizeList(draft.environments || mission.testMatrix?.environments || mission.hardware),
  metric: draft.metric || mission.metric || null,
});

const missionProjection = (mission = {}) => ({
  id: mission.id || null,
  title: mission.title || null,
  goal: mission.goal || null,
  repository: mission.repository || null,
  hardware: clone(mission.hardware || []),
  metric: mission.metric || null,
});

export const normalizeSemanticSnapshot = (input = {}) => {
  const source = input && typeof input === 'object' ? input : {};
  const mission = source.mission || {};
  const draft = source.semanticDraft || source.semanticContract || {};
  const existing = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : source;
  const version = Number.isInteger(existing.version) && existing.version > 0 ? existing.version : 1;
  const status = SEMANTIC_SNAPSHOT_STATUSES.includes(existing.status) ? existing.status : 'draft';
  return {
    schemaVersion: SEMANTIC_SNAPSHOT_SCHEMA,
    snapshotId: normalizeText(existing.snapshotId || source.snapshotId) || null,
    missionId: normalizeText(existing.missionId || mission.id || source.missionId) || null,
    version,
    status,
    rawIntent: clone(existing.rawIntent || source.rawIntent || { goal: mission.goal || source.goal || '' }),
    semanticContract: {
      ...defaultSemanticContract(mission, draft),
      ...clone(existing.semanticContract || {}),
    },
    correctnessContract: {
      ...defaultCorrectnessContract(mission, draft),
      ...clone(existing.correctnessContract || {}),
    },
    benchmarkContract: {
      ...defaultBenchmarkContract(mission, draft),
      ...clone(existing.benchmarkContract || {}),
    },
    sources: normalizeList(existing.sources || source.sources),
    fieldProvenance: clone(existing.fieldProvenance || source.fieldProvenance || {}),
    conflicts: normalizeList(existing.conflicts || source.conflicts),
    assumptions: normalizeList(existing.assumptions || source.assumptions),
    unknowns: normalizeList(existing.unknowns || source.unknowns),
    userDecisions: normalizeList(existing.userDecisions || source.userDecisions),
    testSpec: clone(existing.testSpec || source.testSpec || mission.testMatrix?.testSpec || null),
    implementation: clone(existing.implementation || mission.implementation || null),
    projection: clone(existing.projection || missionProjection(mission)),
    createdAt: existing.createdAt || null,
    updatedAt: existing.updatedAt || null,
    digest: existing.digest || null,
  };
};

export const createSemanticSnapshot = ({ mission = {}, semanticDraft = {}, snapshot = null } = {}) => {
  const normalized = normalizeSemanticSnapshot({ mission, semanticDraft, snapshot: snapshot || undefined });
  normalized.snapshotId = normalized.snapshotId || `SEM_${Date.now().toString(36).toUpperCase()}`;
  normalized.missionId = normalized.missionId || mission.id || null;
  normalized.createdAt = normalized.createdAt || new Date().toISOString();
  normalized.updatedAt = new Date().toISOString();
  normalized.digest = semanticSnapshotDigest(normalized);
  return normalized;
};

const conflictIsBlocking = (conflict) => {
  if (!conflict || conflict.resolved === true || conflict.status === 'resolved') return false;
  return conflict.blocking !== false && String(conflict.severity || 'blocking').toLowerCase() !== 'warning';
};

const unknownIsBlocking = (unknown) => {
  if (!unknown || unknown.resolved === true || unknown.accepted === true || unknown.status === 'accepted') return false;
  return unknown.blocking !== false;
};

export const semanticSnapshotIssues = (snapshot, { requireReady = false, requireFrozen = false } = {}) => {
  const normalized = normalizeSemanticSnapshot(snapshot);
  const issues = [];
  if (normalized.schemaVersion !== SEMANTIC_SNAPSHOT_SCHEMA) issues.push({ code: 'SEMANTIC_SCHEMA_UNSUPPORTED', detail: normalized.schemaVersion });
  if (!normalized.missionId) issues.push({ code: 'SEMANTIC_MISSION_REQUIRED', detail: 'missionId is required' });
  if (!normalized.semanticContract.operator) issues.push({ code: 'SEMANTIC_OPERATOR_REQUIRED', detail: 'semanticContract.operator is required' });
  const blockingConflicts = normalized.conflicts.filter(conflictIsBlocking);
  if (blockingConflicts.length) issues.push({ code: 'SEMANTIC_CONFLICTS_UNRESOLVED', detail: blockingConflicts });
  const blockingUnknowns = normalized.unknowns.filter(unknownIsBlocking);
  if (blockingUnknowns.length) issues.push({ code: 'SEMANTIC_UNKNOWNS_UNRESOLVED', detail: blockingUnknowns });
  if (normalized.correctnessContract.uncovered?.length) issues.push({ code: 'SEMANTIC_CORRECTNESS_UNCOVERED', detail: normalized.correctnessContract.uncovered });
  if (requireReady && !['ready_to_freeze', 'frozen'].includes(normalized.status)) issues.push({ code: 'SEMANTIC_NOT_READY', detail: normalized.status });
  if (requireFrozen && normalized.status !== 'frozen') issues.push({ code: 'SEMANTIC_NOT_FROZEN', detail: normalized.status });
  const expectedDigest = semanticSnapshotDigest(normalized);
  if (normalized.digest && normalized.digest !== expectedDigest) issues.push({ code: 'SEMANTIC_DIGEST_INVALID', detail: { expected: expectedDigest, actual: normalized.digest } });
  return issues;
};

export const assertSemanticSnapshot = (snapshot, options = {}) => {
  const normalized = normalizeSemanticSnapshot(snapshot);
  const issues = semanticSnapshotIssues(normalized, options);
  if (issues.length) {
    const error = new Error(`Semantic Snapshot 校验失败：${issues.map((issue) => issue.code).join(', ')}`);
    error.code = issues[0].code;
    error.status = 409;
    error.issues = issues;
    throw error;
  }
  return normalized;
};

export const freezeSemanticSnapshot = (snapshot, { now = new Date().toISOString() } = {}) => {
  const normalized = normalizeSemanticSnapshot(snapshot);
  normalized.status = 'ready_to_freeze';
  const issues = semanticSnapshotIssues(normalized, { requireReady: false });
  if (issues.length) {
    const error = new Error(`Semantic Snapshot 不能冻结：${issues.map((issue) => issue.code).join(', ')}`);
    error.code = 'SEMANTIC_FREEZE_BLOCKED';
    error.status = 409;
    error.issues = issues;
    throw error;
  }
  normalized.status = 'frozen';
  normalized.updatedAt = now;
  normalized.createdAt = normalized.createdAt || now;
  normalized.digest = semanticSnapshotDigest(normalized);
  return deepFreeze(normalized);
};

export const semanticSnapshotReady = (snapshot) => semanticSnapshotIssues(snapshot).length === 0;

export const createSemanticTaskBinding = (snapshot, { testSpec = null, oracleDigest = null, baselineDigest = null, ...extra } = {}) => {
  const normalized = assertSemanticSnapshot(snapshot, { requireFrozen: true });
  return {
    semanticSnapshotId: normalized.snapshotId,
    semanticDigest: normalized.digest || semanticSnapshotDigest(normalized),
    testSpecDigest: testSpec ? `sha256:${createHash('sha256').update(canonicalSemanticJson(testSpec)).digest('hex')}` : null,
    oracleDigest: oracleDigest || null,
    baselineDigest: baselineDigest || null,
    ...clone(extra),
  };
};

export const assertSemanticTaskBinding = (binding, snapshot, expected = {}) => {
  const normalized = assertSemanticSnapshot(snapshot, { requireFrozen: true });
  const mismatches = [];
  if (!binding || binding.semanticSnapshotId !== normalized.snapshotId) mismatches.push('semanticSnapshotId');
  if (!binding || binding.semanticDigest !== (normalized.digest || semanticSnapshotDigest(normalized))) mismatches.push('semanticDigest');
  for (const field of ['testSpecDigest', 'oracleDigest', 'baselineDigest']) {
    if (expected[field] != null && (!binding || binding[field] !== expected[field])) mismatches.push(field);
  }
  if (mismatches.length) {
    const error = new Error(`下游任务未绑定同一 Semantic Snapshot：${mismatches.join(', ')}`);
    error.code = 'SEMANTIC_SNAPSHOT_MISMATCH';
    error.status = 409;
    error.mismatches = mismatches;
    throw error;
  }
  return true;
};

export const mergeSemanticField = ({ snapshot, field, value, source, userConfirmed = false } = {}) => {
  const next = normalizeSemanticSnapshot(snapshot);
  const segments = normalizeText(field).split('.').filter(Boolean);
  if (!segments.length) throw new Error('Semantic field path is required.');
  let target = next.semanticContract;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== 'object' || Array.isArray(target[segment])) target[segment] = {};
    target = target[segment];
  }
  const leaf = segments.at(-1);
  const previous = target[leaf];
  if (previous !== undefined && canonicalSemanticJson(previous) !== canonicalSemanticJson(value) && !userConfirmed) {
    next.conflicts.push({ field, values: [{ value: previous, source: next.fieldProvenance?.[field]?.source || 'existing' }, { value: clone(value), source: source || 'unknown' }], severity: 'blocking', resolved: false });
  } else {
    target[leaf] = clone(value);
    next.fieldProvenance[field] = { source: source || 'unknown', userConfirmed };
  }
  next.updatedAt = new Date().toISOString();
  next.digest = semanticSnapshotDigest(next);
  return next;
};

export const resolveSemanticConflict = ({ snapshot, conflictIndex = -1, value, source, decision = 'user-confirmed' } = {}) => {
  const next = normalizeSemanticSnapshot(snapshot);
  const conflict = next.conflicts[conflictIndex];
  if (!conflict) throw new Error(`Semantic conflict ${conflictIndex} does not exist.`);
  if (value !== undefined) {
    const segments = normalizeText(conflict.field).split('.').filter(Boolean);
    if (!segments.length) throw new Error('Semantic conflict field is required.');
    let target = next.semanticContract;
    for (const segment of segments.slice(0, -1)) {
      if (!target[segment] || typeof target[segment] !== 'object' || Array.isArray(target[segment])) target[segment] = {};
      target = target[segment];
    }
    target[segments.at(-1)] = clone(value);
    next.fieldProvenance[conflict.field] = { source: source || 'user', userConfirmed: true };
  }
  next.conflicts[conflictIndex] = { ...conflict, resolved: true, status: 'resolved', decision, resolvedValue: clone(value) };
  next.userDecisions.push({ type: 'semantic-conflict', field: conflict.field, decision, value: clone(value), source: source || 'user' });
  next.updatedAt = new Date().toISOString();
  next.digest = semanticSnapshotDigest(next);
  return next;
};
