import { ensureRoundBudgetStarted } from '../round-budget-contract.mjs';
import { remainingMissionBudgetMs } from '../iteration-loop.mjs';
import { validateExperienceContext } from '../experience-contract.mjs';

export const createAgentRoundService = ({ resetMissionRunState, resetMissionWorkspace, createWorkspaceCheckpoint, startAgentRun, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime, roundExperience, nowMs }) => {
  if (!resetMissionRunState || !resetMissionWorkspace || !createWorkspaceCheckpoint || !startAgentRun || !appendRuntimeEvent || typeof isManagedWorkspaceRuntimeMode !== 'function' || !agentRuntime) throw new TypeError('Agent round service dependencies are required.');
  if (typeof roundExperience?.prepare !== 'function' || typeof roundExperience?.collect !== 'function') throw new TypeError('roundExperience.prepare and collect are required.');
  if (typeof nowMs !== 'function') throw new TypeError('nowMs must be an injected millisecond clock.');
  const startRound = async ({ state, mission, goal, workspace, runtimeMode }) => {
    const ensureBudget = () => {
      const budget = ensureRoundBudgetStarted(state, { nowMs: nowMs() }).roundBudget;
      const remaining = remainingMissionBudgetMs(state, { nowMs: nowMs() });
      if (!Number.isFinite(remaining) || remaining <= 0) throw Object.assign(new Error('Mission budget exhausted before Agent start'), { code: 'ROUND_EXPERIENCE_BUDGET_EXCEEDED', status: 409 });
      return budget;
    };
    const roundBudget = ensureBudget();
    const remaining = () => Math.min(3000, Date.parse(ensureBudget().deadlineAt) - nowMs(), remainingMissionBudgetMs(state, { nowMs: nowMs() }));
    if (roundExperience.preflightCollection) await roundExperience.preflightCollection({ state, mission });
    ensureBudget();
    await roundExperience.collect({ state, mission, timeoutMs: remaining() });
    ensureBudget();
    const experienceContext = await roundExperience.prepare({ state, mission, roundId: roundBudget.roundId, timeoutMs: remaining() });
    // 本轮 prepare 后立即深拷贝选择清单 sidecar，避免后续 reset/Agent effect 改动状态或 runtime 返回
    // 另一个 state 对象时丢失；返回时与本轮 context 一起透传，且不与状态共享可变引用。
    const roundExperienceSelection = structuredClone(state.iterationStats?.roundExperienceSelection ?? null);
    ensureBudget();
    validateExperienceContext(experienceContext, { projectId: mission.projectId, missionId: mission.id, roundId: roundBudget.roundId });
    resetMissionRunState(state, goal, { referenceFixture: runtimeMode === 'reference-fixture' });
    const roundFacts = structuredClone(state.iterationStats?.roundFacts || null);
    if (runtimeMode === 'reference-fixture') await resetMissionWorkspace(state.activeMissionId);
    if (isManagedWorkspaceRuntimeMode(runtimeMode)) {
      const checkpoint = await createWorkspaceCheckpoint(state.activeMissionId, 'agent-run-baseline');
      state.workflowRecovery = { ...(state.workflowRecovery || {}), checkpoints: [...(state.workflowRecovery?.checkpoints || []), checkpoint].slice(-5) };
    }
    ensureBudget();
    const runtimeRun = await agentRuntime.startRun({ state, mission, goal, resumeThreadId: null, workspace, roundId: roundBudget.roundId, experienceContext });
    if (!runtimeRun.handled) {
      startAgentRun(state, goal, { reset: false });
      appendRuntimeEvent(state, 'mission.run_started', { runId: state.agent.runId, goal }, { kind: 'adapter', mode: 'reference-fixture' });
    }
    const result = runtimeRun.state || state;
    result.iterationStats = { ...(result.iterationStats || {}), roundBudget: state.iterationStats.roundBudget, roundExperience: experienceContext, roundExperienceSelection: structuredClone(roundExperienceSelection), roundFacts };
    return result;
  };
  return Object.freeze({ startRound });
};
