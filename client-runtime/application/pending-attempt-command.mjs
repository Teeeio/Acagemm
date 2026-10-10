import { pendingTestIdentity } from '../pending-test-contract.mjs';
import { preparePendingAttempt, applyPendingAttempt } from '../pending-attempt.mjs';

export const createPendingAttemptCommands = ({ missionState, readPendingCandidate, readTask, workspace, now = () => new Date() }) => ({
  'new-pending-attempt': {
    tracksEffects: true,
    keyFor: (state, body) => `pending-attempt:${state.activeMissionId}:${body.manifestDigest}`,
    isApplied: (state, payload) => state.missions.some(m => m.id === payload?.mission?.id
      && m.attemptOrigin?.manifestDigest === payload?.origin?.manifestDigest),
    plan: async ({ state, body, effectId }) => {
      const pending = pendingTestIdentity(state, { missionId: state.activeMissionId, manifestDigest: body.manifestDigest });
      const bundle = await readPendingCandidate(pending);
      const snapshot = state.benchmark?.pendingManifestDigest === pending.manifestDigest && state.benchmark.testTaskId
        ? await readTask(state.benchmark.testTaskId) : null;
      return preparePendingAttempt(state, bundle, snapshot, { missionState,
        missionId: `MIS_ATTEMPT_${effectId.slice(7).toUpperCase()}`, nowMs: now().getTime() });
    },
    prepare: async ({ intent, runEffect }) => {
      const receipt = await runEffect(() => workspace.prepare(intent));
      return { payload: { ...intent, workspaceReceipt: receipt }, result: { missionId: intent.mission.id, origin: intent.origin, started: false } };
    },
    recover: async ({ intent }) => {
      const receipt = await workspace.inspect(intent);
      return receipt ? { status: 'prepared', prepared: { payload: { ...intent, workspaceReceipt: receipt },
        result: { missionId: intent.mission.id, origin: intent.origin, started: false } } } : { status: 'not_started' };
    },
    validateApply: async ({ payload }) => {
      const receipt = await workspace.inspect(payload);
      if (!receipt || receipt.head !== payload.workspaceReceipt.head) throw Object.assign(new Error('新任务工作区准备结果已改变。'), { code: 'PENDING_ATTEMPT_WORKSPACE_CHANGED', status: 409 });
    },
    apply: (state, payload) => applyPendingAttempt(state, payload, missionState),
  },
});
