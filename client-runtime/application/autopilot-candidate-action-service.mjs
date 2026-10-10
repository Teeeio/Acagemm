import { assertResourcesReleased } from '../cancellation-contract.mjs';
import { PatchPolicyCheckError } from './candidate-commands.mjs';

export const createAutopilotCandidateActionService = ({ executeCommand, journal, saveState, registry }) => {
  const applyCandidate = async ({ state, candidateId }) => {
    try {
      const result = await executeCommand({ journal, saveState, registry, state, type: 'apply-patch', body: { candidate: candidateId }, expectedVersion: state.stateVersion });
      return result.state || state;
    } catch (error) {
      if (!(error instanceof PatchPolicyCheckError)) throw error;
      // Return the observed completion together with its policy outcome so the
      // lifecycle commits both. Throwing here loses the projection and retries
      // the same rejected candidate on every automatic tick.
      const candidate = state.candidateEvaluations?.find((item) => item.id === candidateId);
      state.missionPaused = true;
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'patch_policy_rejected' };
      const mission = state.missions?.find((item) => item.id === state.activeMissionId);
      if (mission) mission.status = 'needs_human';
      state.agent = {
        ...state.agent,
        status: 'needs_human',
        phase: '候选策略检查未通过，等待人工介入',
        patchPolicyRejection: {
          code: error.code, message: error.message,
          missionId: state.activeMissionId, candidateId,
          sourceRunId: state.agent?.runId || null,
          patchDigest: candidate?.patchDigest || null,
          checks: structuredClone(error.details),
        },
      };
      return state;
    }
  };
  const resumeCandidate = async ({ state, mission, startMainRound }) => {
    const admission = state.agent?.candidateValidation;
    const recovery = admission?.passed === false ? `\n【前次准入失败】${admission.code || 'CANDIDATE_ADMISSION_FAILED'}: ${admission.detail || 'Inspect the complete Workspace Diff.'}\nRemove temporary probe files that are not deliverables, or declare every real changed dependency. Do not weaken admission or change the frozen oracle/matrix/budget.` : '';
    const goal = `${mission.goal || state.agent?.goal || ''}\n【系统恢复】同 runner / 同 shape baseline 已完成，请生成一个有真实工作区 Diff 的 run.py 优化候选。${recovery}`;
    assertResourcesReleased(state);
    if (state.candidateEvaluations?.some(candidate => candidate.patchDigest)) {
      throw Object.assign(new Error('A verified candidate must be tested before generating another candidate.'), { code: 'CANDIDATE_PENDING_BEFORE_RESUME', status: 409 });
    }
    // awaiting_action here is a client baseline action, not an executing Agent.
    // Keep the previous run identity for normal round archival and source facts.
    const next = { ...state, agent: { ...state.agent, status: 'completed' } };
    return startMainRound({ state: next, goal });
  };
  return Object.freeze({ applyCandidate, resumeCandidate });
};
