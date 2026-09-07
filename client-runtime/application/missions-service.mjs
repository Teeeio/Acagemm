const applicationError = (message, status, code) => {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
};

export const createMissionsService = ({
  loadState,
  persistState,
  ensureMissionWorkspace,
  validateMissionBudgetInput,
  missionState,
} = {}) => {
  if (typeof loadState !== 'function'
    || typeof persistState !== 'function'
    || typeof ensureMissionWorkspace !== 'function'
    || typeof validateMissionBudgetInput !== 'function'
    || typeof missionState?.createMission !== 'function') {
    throw new TypeError('Missions service requires state, workspace, and budget validation dependencies.');
  }

  const list = async () => {
    const state = await loadState();
    return { missions: state.missions, activeMissionId: state.activeMissionId };
  };

  const create = async (input = {}) => {
    const state = await loadState();
    if (!String(input.goal || '').trim()) {
      throw applicationError('请输入一个可执行的优化目标。', 400, 'MISSION_GOAL_REQUIRED');
    }
    const budgetInput = validateMissionBudgetInput(input);
    if (!budgetInput.ok) {
      throw applicationError(
        'missionBudgetMs 必须是正数毫秒；传 null、空值或 0 表示不启用时间限制。',
        400,
        'INVALID_MISSION_BUDGET',
      );
    }
    const nextState = missionState.createMission(state, input);
    const mission = nextState.missions.find((item) => item.id === nextState.activeMissionId);
    await ensureMissionWorkspace(mission.id, mission.repository, {
      projectRoot: mission.projectRoot,
      sourceRoot: mission.sourceRoot,
    });
    return { state: await persistState(nextState) };
  };

  return Object.freeze({ list, create });
};
