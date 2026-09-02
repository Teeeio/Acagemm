export const createAutopilotCandidateActionService = ({ executeCommand, journal, saveState, registry }) => {
  const applyCandidate = async ({ state, candidateId }) => {
    const result = await executeCommand({ journal, saveState, registry, state, type: 'apply-patch', body: { candidate: candidateId }, expectedVersion: state.stateVersion });
    return result.state || state;
  };
  const resumeCandidate = async ({ state, mission, startMainRound }) => {
    const goal = `${mission.goal || state.agent?.goal || ''}\n【系统恢复】同 runner / 同 shape baseline 已完成，请生成一个有真实工作区 Diff 的 run.py 优化候选。`;
    return startMainRound({ state, goal });
  };
  return Object.freeze({ applyCandidate, resumeCandidate });
};
