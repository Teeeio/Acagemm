import { pendingTestIdentity } from '../pending-test-contract.mjs';
import { assertPendingFeedbackContract, settlePendingFeedback, preparePendingContinuation } from '../pending-feedback.mjs';
import { appendRuntimeEvent } from '../runtime-events.mjs';

export const createPendingFeedbackCommands = ({ runCommand, readTask, readPendingCandidate,
  verifyWorkspace, workspaceForMission, captureDiff, roundExperience, now = () => new Date() }) => {
  for (const method of ['preparePendingCollection', 'writePendingCollection', 'inspectPendingCollection']) {
    if (typeof roundExperience?.[method] !== 'function') throw new TypeError(`Pending feedback requires roundExperience.${method}.`);
  }
  const identity = (state, body) => ({ missionId: state.activeMissionId, manifestDigest: body.manifestDigest });
  const verify = async (state, body) => {
    const pending = pendingTestIdentity(state, identity(state, body));
    const bundle = await readPendingCandidate(pending);
    assertPendingFeedbackContract(state, bundle);
    const workspace = await workspaceForMission(state.activeMissionId);
    const diff = await captureDiff(workspace, { readOnly: true });
    return verifyWorkspace(pending, { workspace, diff });
  };
  const settlementView = (state, payload) => {
    const clone = structuredClone(state);
    settlePendingFeedback(clone, payload.snapshot, payload.workspaceBinding, { nowMs: Date.parse(payload.settledAt) });
    return { state: clone, mission: clone.missions.find(item => item.id === clone.activeMissionId) };
  };
  const preparedSettlement = (state, payload, collection) => {
    const view = settlementView(state, payload);
    return { payload: { ...payload, experienceCollection: collection },
      result: { feedback: { ...view.state.iterationStats.pendingFeedback, experienceCollection: collection } } };
  };
  return Object.freeze({
    'settle-pending-candidate': {
      tracksEffects: true,
      keyFor: (state, body) => `pending-feedback:${state.activeMissionId}:${body.manifestDigest}`,
      isApplied: (state, payload) => state.iterationStats?.pendingFeedback?.manifestDigest === payload?.manifestDigest,
      prepare: async ({ state, body, intent, recordIntent, runEffect }) => {
        const workspaceBinding = await verify(state, body);
        const payload = intent?.feedbackPayload || { manifestDigest: body.manifestDigest,
          snapshot: await readTask(state.benchmark.testTaskId), workspaceBinding, settledAt: now().toISOString() };
        const view = settlementView(state, payload);
        const plan = intent?.experiencePlan || await roundExperience.preparePendingCollection(view);
        await recordIntent({ feedbackPayload: payload, experiencePlan: plan });
        const write = () => roundExperience.writePendingCollection({ ...view, plan });
        const collection = plan.status === 'ready' ? await runEffect(write) : await write();
        return preparedSettlement(state, payload, collection);
      },
      recover: async ({ state, body, intent }) => {
        if (!intent?.feedbackPayload || !intent.experiencePlan) return { status: 'unknown' };
        await verify(state, body);
        const view = settlementView(state, intent.feedbackPayload);
        const observed = await roundExperience.inspectPendingCollection({ ...view, plan: intent.experiencePlan });
        if (observed.status === 'absent') return { status: 'not_started' };
        if (observed.status !== 'recorded') return { status: 'unknown' };
        return { status: 'prepared', prepared: preparedSettlement(state, intent.feedbackPayload, observed.collection) };
      },
      validateApply: async ({ state, payload }) => {
        if (state.iterationStats?.pendingFeedback?.manifestDigest === payload.manifestDigest) return;
        // Recheck after preparation/restart: an old successful read cannot grant
        // ownership over edits made while the command was interrupted.
        await verify(state, payload);
      },
      apply: (state, payload) => {
        if (state.iterationStats?.pendingFeedback?.manifestDigest === payload.manifestDigest) return;
        settlePendingFeedback(state, payload.snapshot, payload.workspaceBinding, { nowMs: Date.parse(payload.settledAt) });
        if (payload.experienceCollection) {
          state.iterationStats.experienceCollection = structuredClone(payload.experienceCollection);
          state.iterationStats.pendingFeedback.experienceCollection = structuredClone(payload.experienceCollection);
          if (payload.experienceCollection.targetMismatch) {
            state.iterationStats.resolvedTargetMismatch = { ...structuredClone(payload.experienceCollection.targetMismatch),
              detectedAt: payload.settledAt };
          }
          appendRuntimeEvent(state, 'pending_candidate.experience_collected', payload.experienceCollection, { kind: 'policy', mode: 'client' });
        }
      },
    },
    'continue-pending-candidate': {
      tracksEffects: true,
      keyFor: (state, body) => `pending-continue:${state.activeMissionId}:${body.manifestDigest}`,
      isApplied: (state, payload) => Boolean(payload?.runId) && (state.agent?.runId === payload.runId
        || state.runHistory?.some(run => run.runId === payload.runId)),
      plan: async ({ state, body, ...context }) => {
        const clone = preparePendingContinuation(state, identity(state, body), { nowMs: now().getTime() });
        return runCommand.plan({ ...context, state: clone, body: {}, admittedContinuation: true });
      },
      prepare: async ({ state, body, ...context }) => {
        await verify(state, body);
        const clone = preparePendingContinuation(state, identity(state, body), { nowMs: now().getTime() });
        const result = await runCommand.prepare({ ...context, state: clone, body: {}, admittedContinuation: true,
          verifyBeforeEffects: () => verify(state, body) });
        return { ...result, payload: { ...result.payload, continuedManifestDigest: body.manifestDigest,
          previousFeedback: structuredClone(state.iterationStats.pendingFeedback) } };
      },
      apply: (state, payload) => {
        pendingTestIdentity(state, { missionId: state.activeMissionId, manifestDigest: payload.continuedManifestDigest });
        runCommand.apply(state, payload);
        if (payload.preparationFailure) return;
        state.iterationStats = { ...state.iterationStats, pendingValidation: null, pendingTest: null, pendingFeedback: null,
          lastPendingContinuation: { ...payload.previousFeedback, nextRunId: payload.runId },
          ...(payload.previousFeedback?.experienceCollection ? { experienceCollection: structuredClone(payload.previousFeedback.experienceCollection) } : {}),
          loopStatus: 'running', loopStatusReason: null };
        appendRuntimeEvent(state, 'pending_candidate.continued', { ...payload.previousFeedback, nextRunId: payload.runId }, { kind: 'policy', mode: 'client' });
      },
    },
  });
};
