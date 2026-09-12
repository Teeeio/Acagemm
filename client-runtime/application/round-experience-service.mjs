import { appendExperience, emptyExperienceStore, experienceError, formatExperienceContext, validateExperienceContext, EXPERIENCE_LIMITS, EXPERIENCE_SELECTION_POLICY_VERSION, EXPERIENCE_SELECTION_SCHEMA_VERSION } from '../experience-contract.mjs';
import { isBackendTargetName } from '../operator-test-evidence.mjs';

const requiredEvidence = ['missionId', 'candidateId', 'runId', 'patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest', 'hardware', 'executionMode', 'outcome'];
const preparingRounds = new WeakMap();
const fail = (code, message, details = {}) => Object.assign(experienceError(code, message, 409), { retryable: false, ...details });
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(value) && !value.includes('..');
const timeoutValue = (value) => {
  if (!Number.isFinite(value) || value <= 0 || value > 120000) throw new TypeError('timeoutMs must be positive, finite, and no greater than 120000');
  return value;
};
const targetValues = (value) => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= 16) break;
  }
  return result;
};
const declaredValues = (value, label) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 8000)) {
    throw experienceError('EXPERIENCE_INVALID', `${label} must be a bounded array of non-empty strings`, 400);
  }
  return targetValues(value);
};
const sameValues = (left, right) => left.length === right.length && left.every((item) => right.includes(item));
// Mission 只固定 operator/tags；hardware 与 architecture 是「本轮实际执行目标」，必须来自同 Mission
// 的 resolvedTarget（执行结果投影），不能拿 backend 名冒充，也不能拿声明值覆盖实际值。
const missionScope = (mission) => ({
  ...((mission.operatorProfile?.operator || mission.operator) ? { operator: mission.operatorProfile?.operator || mission.operator } : {}),
  tags: mission.tags ?? [],
});
const boundTargetFor = (state, mission) => {
  const target = state?.iterationStats?.resolvedTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target) || target.missionId !== mission.id) return null;
  const hardware = targetValues(target.hardware);
  const architecture = targetValues(target.architecture);
  if (!hardware.length || hardware.some(isBackendTargetName) || architecture.some(isBackendTargetName)) {
    throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'The Mission-bound execution target has no valid hardware identity');
  }
  return { hardware, architecture };
};
const rejectBackend = (values, where) => {
  const backend = values.find((item) => isBackendTargetName(item));
  if (backend) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', `Execution backend "${backend}" cannot be used as ${where}; it must not be retrieved as hardware`);
};
// 默认/显式 scope 都不得绕过 Mission 已绑定的执行目标：无解析目标才回退 Mission 明确 hardware
// （backend 名必须显式报错，不能悄悄退化成正常零命中）；显式 scope 与绑定目标冲突同样拒绝。
const queryScope = (state, mission, scope) => {
  const base = missionScope(mission);
  const bound = boundTargetFor(state, mission);
  if (scope === undefined) {
    if (bound) return { ...base, hardware: bound.hardware, ...(bound.architecture.length ? { architecture: bound.architecture } : {}) };
    rejectBackend(targetValues(mission.hardware), 'a hardware target');
    const declared = declaredValues(mission.hardware, 'mission.hardware');
    rejectBackend(declared, 'a hardware target');
    return { ...base, hardware: declared };
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'Explicit experience scope must be a plain object');
  const merged = { ...base, ...scope };
  rejectBackend(targetValues(merged.hardware), 'a hardware target');
  rejectBackend(targetValues(merged.architecture), 'an architecture target');
  const explicitHardware = declaredValues(merged.hardware, 'scope.hardware');
  const explicitArchitecture = declaredValues(merged.architecture, 'scope.architecture');
  if (bound) {
    if (explicitHardware.length && !sameValues(explicitHardware, bound.hardware)) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'Explicit scope hardware conflicts with the Mission-bound execution target');
    if (explicitArchitecture.length && !sameValues(explicitArchitecture, bound.architecture)) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'Explicit scope architecture conflicts with the Mission-bound execution target');
    merged.hardware = bound.hardware;
    if (bound.architecture.length) merged.architecture = bound.architecture;
  }
  return merged;
};
// 执行记录始终保存「实际执行目标」，绝不因查询目标而改写证据。
const recordScope = (mission, evidence) => ({
  ...missionScope(mission),
  hardware: [evidence.hardware],
  ...(evidence.architecture !== undefined ? { architecture: [evidence.architecture] } : {}),
});
const targetMismatch = (bound, evidence) => {
  const issues = [];
  if (bound.hardware.length && !bound.hardware.includes(evidence.hardware)) issues.push({ field: 'hardware', expected: bound.hardware, actual: evidence.hardware });
  if (bound.architecture.length && !bound.architecture.includes(evidence.architecture)) {
    issues.push({ field: 'architecture', expected: bound.architecture, actual: evidence.architecture ?? null });
  }
  return issues.length ? issues : null;
};
const canonicalEvidence = (evidence) => appendExperience(emptyExperienceStore(), {
  projectId: 'validation', title: 'Execution evidence', content: 'Validation only.', author: 'validator', evidence,
}, { id: 'validation', now: '1970-01-01T00:00:00.000Z', source: 'execution' }).result.experience.evidence;

// 选择清单 sidecar 只做审计，不参与 context 校验，也不得改变注入集合。字节一律按
// UTF-8 实测（Buffer.byteLength），不用字符数估算。
const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');
const selectionEvidence = (context, { projectId, missionId, roundId }) => ({
  schemaVersion: EXPERIENCE_SELECTION_SCHEMA_VERSION,
  policyVersion: EXPERIENCE_SELECTION_POLICY_VERSION,
  projectId, missionId, roundId,
  repositoryRevision: context.repositoryRevision,
  contextId: context.contextId,
  scopeDigest: context.scopeDigest,
  itemLimit: EXPERIENCE_LIMITS.contextItems,
  byteLimit: EXPERIENCE_LIMITS.contextBytes,
  contextBytes: utf8Bytes(JSON.stringify(context)),
  renderedBytes: utf8Bytes(formatExperienceContext(context, { projectId, missionId, roundId })),
});
// 只有 retrieve 端口（旧 retrieve-only 注入）时如实标注"未记录排除原因"，绝不编造。
const contextDerivedSelection = (context, identity) => ({
  ...selectionEvidence(context, identity),
  selected: context.items.map((record) => ({ id: record.id, version: record.version, source: record.source, useAs: record.useAs, reason: 'frozen-context' })),
  excluded: [],
  excludedUnauthorized: 0,
  excludedOmitted: 0,
  exclusionReasonsRecorded: false,
  auditSource: 'context-derived',
});
// 内容与选择必须来自同一次读取，包含 asOf 的 contextId 必须完全一致。
const auditSelection = (raw, context, identity) => {
  if (raw == null) return contextDerivedSelection(context, identity);
  const aligned = raw && raw.schemaVersion === EXPERIENCE_SELECTION_SCHEMA_VERSION
    && raw.projectId === identity.projectId && raw.missionId === identity.missionId && raw.roundId === identity.roundId
    && raw.contextId === context.contextId && raw.repositoryRevision === context.repositoryRevision && raw.scopeDigest === context.scopeDigest
    && Array.isArray(raw.selected) && raw.selected.length === context.items.length
    && raw.selected.every((item, index) => item?.id === context.items[index].id && item?.version === context.items[index].version
      && item?.source === context.items[index].source && item?.useAs === context.items[index].useAs);
  if (!aligned) throw fail('ROUND_EXPERIENCE_SELECTION_CONFLICT', 'Experience selection does not match its frozen context');
  if (raw.auditSource === 'context-derived') return { ...structuredClone(raw), ...selectionEvidence(context, identity) };
  return { ...structuredClone(raw), ...selectionEvidence(context, identity), requestedLimit: raw.requestedLimit, exclusionReasonsRecorded: true, auditSource: 'retrieve-with-selection' };
};

export const createRoundExperienceService = ({ experienceService, resolveAccess, verifyObservationEvidence, timers, timeoutMs = 3000 } = {}) => {
  if (typeof experienceService?.retrieve !== 'function' || typeof experienceService?.recordObservation !== 'function') throw new TypeError('experienceService.retrieve and recordObservation are required');
  if (typeof resolveAccess !== 'function') throw new TypeError('resolveAccess is a required trusted synchronous authority port');
  if (typeof verifyObservationEvidence !== 'function') throw new TypeError('verifyObservationEvidence is a required trusted evidence port');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') throw new TypeError('timers.setTimeout and timers.clearTimeout are required');
  timeoutValue(timeoutMs);
  const pending = preparingRounds;
  const accessFor = ({ state, mission }) => {
    if (!state || !mission || !safeId(mission.id) || !safeId(mission.projectId) || state.activeMissionId !== mission.id) throw fail('ROUND_EXPERIENCE_ACCESS_INVALID', 'Experience use requires the active Mission and its owning Project');
    const access = resolveAccess({ state, mission });
    if (!access || typeof access.then === 'function' || access.projectId !== mission.projectId || !Array.isArray(access.allowedProjectIds) || access.allowedProjectIds.length > 100 || access.allowedProjectIds.some((id) => !safeId(id))) throw fail('ROUND_EXPERIENCE_ACCESS_INVALID', 'Trusted project authorization is missing or does not match the Mission');
    return { projectId: access.projectId, allowedProjectIds: [...new Set(access.allowedProjectIds)] };
  };
  const bounded = async (stage, operation, limit, effectUnknown = false, parentSignal) => {
    timeoutValue(limit);
    const controller = new AbortController();
    let timer;
    let rejectDeadline;
    const abort = (error) => { if (!controller.signal.aborted) { controller.abort(error); rejectDeadline(error); } };
    const onParentAbort = () => abort(parentSignal.reason || fail('ROUND_EXPERIENCE_ABORTED', 'Round experience operation was cancelled'));
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject;
      timer = timers.setTimeout(() => {
        const error = Object.assign(fail('ROUND_EXPERIENCE_TIMEOUT', `Round experience ${stage} exceeded its deadline`, { stage, effectUnknown }), { status: 504 });
        abort(error);
      }, limit);
    });
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(controller.signal);
      }), deadline]);
    } finally { timers.clearTimeout(timer); parentSignal?.removeEventListener('abort', onParentAbort); }
  };
  const prepare = async ({ state, mission, roundId, scope, timeoutMs: limit = timeoutMs }) => {
    const access = accessFor({ state, mission });
    if (!safeId(roundId)) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'An explicit admitted roundId is required');
    if (state.iterationStats?.roundBudget && state.iterationStats.roundBudget.roundId !== roundId) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Experience roundId must match the admitted round budget');
    const resolvedScope = queryScope(state, mission, scope);
    const expected = { ...access, missionId: mission.id, roundId, scope: resolvedScope };
    const identity = { projectId: access.projectId, missionId: mission.id, roundId };
    const existing = state.iterationStats?.roundExperience;
    if (existing?.roundId === roundId) {
      if (existing.projectId !== access.projectId || existing.missionId !== mission.id) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'A round context cannot change owning Project or Mission');
      const frozen = validateExperienceContext(existing, expected);
      const existingSelection = state.iterationStats?.roundExperienceSelection;
      if (!existingSelection || existingSelection.roundId !== roundId || existingSelection.missionId !== mission.id
        || existingSelection.projectId !== access.projectId || existingSelection.contextId !== frozen.contextId) {
        state.iterationStats = { ...state.iterationStats, roundExperienceSelection: contextDerivedSelection(frozen, identity) };
      } else {
        auditSelection(existingSelection, frozen, identity);
      }
      return frozen;
    }
    const inflight = pending.get(state);
    if (inflight) {
      if (inflight.roundId !== roundId) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Another round is still retrieving its experience context');
      return validateExperienceContext(await inflight.promise, expected);
    }
    state.iterationStats = { ...(state.iterationStats || {}), roundExperienceStatus: { status: 'preparing', projectId: access.projectId, missionId: mission.id, roundId } };
    const claim = { roundId, promise: null };
    const operation = (async () => {
      try {
        const query = { ...access, missionId: mission.id, roundId, scope: resolvedScope };
        // 一次仓库读取同时取得冻结内容和选注清单；旧 retrieve-only 注入按原端口运行。
        const retrieved = await bounded('retrieve', async (signal) => {
          if (typeof experienceService.retrieveWithSelection === 'function') {
            const audited = await experienceService.retrieveWithSelection(query, { signal });
            if (!audited?.selection) throw fail('ROUND_EXPERIENCE_SELECTION_CONFLICT', 'Audited retrieval returned no selection');
            return { context: audited.context, rawSelection: audited.selection };
          }
          return { context: await experienceService.retrieve(query, { signal }), rawSelection: null };
        }, limit);
        const context = retrieved.context;
        validateExperienceContext(context, expected);
        if (state.activeMissionId !== mission.id || (state.iterationStats.roundBudget && state.iterationStats.roundBudget.roundId !== roundId)) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Mission or round changed while experience retrieval was pending');
        const selection = auditSelection(retrieved.rawSelection, context, identity);
        state.iterationStats = {
          ...state.iterationStats,
          roundExperience: context,
          roundExperienceSelection: selection,
          roundExperienceStatus: { status: 'ready', projectId: access.projectId, missionId: mission.id, roundId, contextId: context.contextId, repositoryRevision: context.repositoryRevision },
        };
        return context;
      } catch (error) {
        if (state.activeMissionId === mission.id && state.iterationStats?.roundExperienceStatus?.roundId === roundId) {
          const failedStats = { ...(state.iterationStats || {}) };
          if (failedStats.roundExperienceSelection?.roundId === roundId) delete failedStats.roundExperienceSelection;
          failedStats.roundExperienceStatus = { status: 'failed', projectId: access.projectId, missionId: mission.id, roundId, error: { code: error.code || 'ROUND_EXPERIENCE_FAILED', message: error.message } };
          state.iterationStats = failedStats;
        }
        throw error;
      } finally { if (pending.get(state) === claim) pending.delete(state); }
    })();
    claim.promise = operation;
    pending.set(state, claim);
    return operation;
  };
  const record = async ({ state, mission, observation, timeoutMs: limit = timeoutMs, signal: parentSignal }) => {
    const access = accessFor({ state, mission });
    const raw = observation?.evidence;
    const missing = requiredEvidence.filter((key) => raw?.[key] == null || raw[key] === '');
    if (missing.length) return { status: 'skipped', code: 'EXPERIENCE_BINDING_MISSING', missing };
    const evidence = canonicalEvidence(raw);
    if (evidence.missionId !== mission.id) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Execution evidence belongs to a different Mission');
    return bounded('record', async (signal) => {
      const proof = await verifyObservationEvidence({ state, mission, observation: { evidence, evidenceRefs: observation.evidenceRefs ?? [] }, signal });
      if (proof?.verified !== true) return { status: 'skipped', code: typeof proof?.code === 'string' ? proof.code : 'EXPERIENCE_EVIDENCE_UNVERIFIED' };
      if (signal.aborted) throw signal.reason;
      const verifiedEvidence = canonicalEvidence(proof.evidence);
      if (JSON.stringify(verifiedEvidence) !== JSON.stringify(evidence)) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Verification receipt does not match the complete execution binding');
      if (proof.summary != null && typeof proof.summary !== 'string') throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Verified observation summary must be text');
      const content = [
        `Bound execution ${evidence.operation}: ${evidence.outcome}; hardware=${evidence.hardware}; mode=${evidence.executionMode}.`,
        `Mission=${evidence.missionId}; Candidate=${evidence.candidateId}; run=${evidence.runId}.`,
        proof.summary || '',
      ].filter(Boolean).join('\n');
      // 查询目标与实际执行目标冲突时保留实际证据并留下可审计 mismatch，绝不把证据改成预期值。
      const declaredArchitecture = targetValues(mission.architecture);
      const declaredHardware = targetValues(mission.hardware).filter((item) => !isBackendTargetName(item));
      const bound = boundTargetFor(state, mission) || (declaredHardware.length || declaredArchitecture.length ? { hardware: declaredHardware, architecture: declaredArchitecture } : null);
      const mismatch = bound ? targetMismatch(bound, evidence) : null;
      if (mismatch) {
        state.iterationStats = {
          ...(state.iterationStats || {}),
          resolvedTargetMismatch: {
            missionId: mission.id, operation: evidence.operation, runId: evidence.runId,
            detectedAt: state.benchmark?.completedAt || new Date().toISOString(), issues: mismatch,
          },
        };
      }
      const result = await experienceService.recordObservation({
        projectId: access.projectId, visibility: 'project', title: `${evidence.operation}: ${evidence.outcome}`,
        content, author: 'Operator Studio execution verifier', confidence: 'medium',
        scope: recordScope(mission, evidence), evidence: verifiedEvidence, evidenceRefs: observation.evidenceRefs ?? [],
      }, { signal });
      if (signal.aborted) throw signal.reason;
      if (!result?.experience || result.experience.verification?.publishable !== false) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Experience repository returned an invalid or publishable observation');
      return { status: result.created ? 'recorded' : 'existing', ...result, ...(mismatch ? { targetMismatch: { missionId: mission.id, runId: evidence.runId, issues: mismatch } } : {}) };
    }, limit, true, parentSignal);
  };
  const collect = async ({ state, mission, observations, timeoutMs: limit = timeoutMs }) => {
    accessFor({ state, mission });
    if (observations === undefined) {
      observations = ['complete', 'failed', 'cancelled'].includes(state.benchmark?.status)
        ? [{ evidence: state.benchmark.result?.experienceEvidence, evidenceRefs: state.benchmark.result?.experienceEvidenceRefs ?? [] }]
        : [];
    }
    if (!Array.isArray(observations) || observations.length > 20) throw fail('ROUND_EXPERIENCE_LIMIT_EXCEEDED', 'One collection may inspect at most 20 observations');
    const result = { status: 'skipped', recorded: 0, existing: 0, skipped: 0, records: [] };
    try {
      // One deadline bounds the whole batch, not a fresh budget for each record.
      await bounded('collect', async (signal) => {
        for (const observation of observations) {
          if (signal.aborted) throw signal.reason;
          const outcome = await record({ state, mission, observation, timeoutMs: limit, signal });
          if (signal.aborted) throw signal.reason;
          result.records.push(outcome); result[outcome.status]++;
        }
      }, limit, true);
      result.status = result.recorded || result.existing ? (result.skipped ? 'mixed' : 'recorded') : 'skipped';
      state.iterationStats = { ...(state.iterationStats || {}), experienceCollection: {
        status: result.status, recorded: result.recorded, existing: result.existing, skipped: result.skipped,
        records: result.records.map((item) => ({ status: item.status, ...(item.code ? { code: item.code } : {}), ...(item.missing ? { missing: item.missing } : {}), ...(item.experience ? { id: item.experience.id, version: item.experience.version, evidenceKey: item.experience.evidenceKey } : {}) })),
      } };
      return result;
    } catch (error) {
      state.iterationStats = { ...(state.iterationStats || {}), experienceCollection: { status: 'failed', recorded: result.recorded, existing: result.existing, skipped: result.skipped, error: { code: error.code || 'ROUND_EXPERIENCE_FAILED', message: error.message, effectUnknown: Boolean(error.effectUnknown) } } };
      throw error;
    }
  };
  return Object.freeze({ prepare, collect, record });
};
