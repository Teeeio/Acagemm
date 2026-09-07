import { ensureRoundBudgetStarted } from '../round-budget-contract.mjs';
import { validateExperienceContext } from '../experience-contract.mjs';

export const createAgentRoundService = ({ resetMissionRunState, resetMissionWorkspace, createWorkspaceCheckpoint, startAgentRun, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime, roundExperience, nowMs }) => {
  if (!resetMissionRunState || !resetMissionWorkspace || !createWorkspaceCheckpoint || !startAgentRun || !appendRuntimeEvent || typeof isManagedWorkspaceRuntimeMode !== 'function' || !agentRuntime) throw new TypeError('Agent round service dependencies are required.');
  if (typeof roundExperience?.prepare !== 'function' || typeof roundExperience?.collect !== 'function') throw new TypeError('roundExperience.prepare and collect are required.');
  if (typeof nowMs !== 'function') throw new TypeError('nowMs must be an injected millisecond clock.');
  const startRound = async ({ state, mission, goal, workspace, runtimeMode }) => {
    const ensureBudget = () => ensureRoundBudgetStarted(state, { nowMs: nowMs() }).roundBudget;
    const roundBudget = ensureBudget();
    const remaining = () => Math.min(3000, Math.max(1, Date.parse(ensureBudget().deadlineAt) - nowMs()));
    await roundExperience.collect({ state, mission, timeoutMs: remaining() });
    ensureBudget();
    const experienceContext = await roundExperience.prepare({ state, mission, roundId: roundBudget.roundId, timeoutMs: remaining() });
    ensureBudget();
    validateExperienceContext(experienceContext, { projectId: mission.projectId, missionId: mission.id, roundId: roundBudget.roundId });
    resetMissionRunState(state, goal, { referenceFixture: runtimeMode === 'reference-fixture' });
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
    result.iterationStats = { ...(result.iterationStats || {}), roundBudget: state.iterationStats.roundBudget, roundExperience: experienceContext };
    return result;
  };
  return Object.freeze({ startRound });
};
