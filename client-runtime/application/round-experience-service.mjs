import { appendExperience, emptyExperienceStore, experienceError, validateExperienceContext } from '../experience-contract.mjs';

const requiredEvidence = ['missionId', 'candidateId', 'runId', 'patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest', 'hardware', 'executionMode', 'outcome'];
const preparingRounds = new WeakMap();
const fail = (code, message, details = {}) => Object.assign(experienceError(code, message, 409), { retryable: false, ...details });
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(value) && !value.includes('..');
const timeoutValue = (value) => {
  if (!Number.isFinite(value) || value <= 0 || value > 120000) throw new TypeError('timeoutMs must be positive, finite, and no greater than 120000');
  return value;
};
const defaultScope = (mission) => ({ ...((mission.operatorProfile?.operator || mission.operator) ? { operator: mission.operatorProfile?.operator || mission.operator } : {}), hardware: mission.hardware ?? [], tags: mission.tags ?? [] });
const canonicalEvidence = (evidence) => appendExperience(emptyExperienceStore(), {
  projectId: 'validation', title: 'Execution evidence', content: 'Validation only.', author: 'validator', evidence,
}, { id: 'validation', now: '1970-01-01T00:00:00.000Z', source: 'execution' }).result.experience.evidence;

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
  const prepare = async ({ state, mission, roundId, scope = defaultScope(mission), timeoutMs: limit = timeoutMs }) => {
    const access = accessFor({ state, mission });
    if (!safeId(roundId)) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'An explicit admitted roundId is required');
    if (state.iterationStats?.roundBudget && state.iterationStats.roundBudget.roundId !== roundId) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Experience roundId must match the admitted round budget');
    const expected = { ...access, missionId: mission.id, roundId, scope };
    const existing = state.iterationStats?.roundExperience;
    if (existing?.roundId === roundId) {
      if (existing.projectId !== access.projectId || existing.missionId !== mission.id) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'A round context cannot change owning Project or Mission');
      return validateExperienceContext(existing, expected);
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
        const context = await bounded('retrieve', (signal) => experienceService.retrieve({ ...access, missionId: mission.id, roundId, scope }, { signal }), limit);
        validateExperienceContext(context, expected);
        if (state.activeMissionId !== mission.id || (state.iterationStats.roundBudget && state.iterationStats.roundBudget.roundId !== roundId)) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Mission or round changed while experience retrieval was pending');
        state.iterationStats = { ...state.iterationStats, roundExperience: context, roundExperienceStatus: { status: 'ready', projectId: access.projectId, missionId: mission.id, roundId, contextId: context.contextId, repositoryRevision: context.repositoryRevision } };
        return context;
      } catch (error) {
        if (state.activeMissionId === mission.id && state.iterationStats?.roundExperienceStatus?.roundId === roundId) {
          state.iterationStats = { ...(state.iterationStats || {}), roundExperienceStatus: { status: 'failed', projectId: access.projectId, missionId: mission.id, roundId, error: { code: error.code || 'ROUND_EXPERIENCE_FAILED', message: error.message } } };
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
      const result = await experienceService.recordObservation({
        projectId: access.projectId, visibility: 'project', title: `${evidence.operation}: ${evidence.outcome}`,
        content, author: 'Operator Studio execution verifier', confidence: 'medium',
        scope: { ...defaultScope(mission), hardware: [evidence.hardware] }, evidence: verifiedEvidence, evidenceRefs: observation.evidenceRefs ?? [],
      }, { signal });
      if (signal.aborted) throw signal.reason;
      if (!result?.experience || result.experience.verification?.publishable !== false) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Experience repository returned an invalid or publishable observation');
      return { status: result.created ? 'recorded' : 'existing', ...result };
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
