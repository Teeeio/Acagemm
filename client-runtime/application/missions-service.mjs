import { randomUUID } from 'node:crypto';

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
  bindExperiment,
} = {}) => {
  if (bindExperiment !== undefined && typeof bindExperiment !== 'function') throw new TypeError('bindExperiment must be a function when provided.');
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
    const state = structuredClone(await loadState());
    if (input.draftId) {
      if (!Number.isSafeInteger(input.draftRevision)) throw applicationError('提交草稿必须提供当前版本。', 409, 'MISSION_DRAFT_CONFLICT');
      requireDraft(state, input.draftId, input.draftRevision);
    }
    if (!String(input.goal || '').trim()) {
      throw applicationError('请输入一个可执行的优化目标。', 400, 'MISSION_GOAL_REQUIRED');
    }
    if (input.missionPaused !== undefined && typeof input.missionPaused !== 'boolean') {
      throw applicationError('missionPaused 必须为布尔值。', 400, 'INVALID_MISSION_PAUSED');
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
    if (bindExperiment) mission.experiment = await bindExperiment({ state: nextState, mission });
    await ensureMissionWorkspace(mission.id, mission.repository, {
      projectRoot: mission.projectRoot,
      sourceRoot: mission.sourceRoot,
    });
    if (input.draftId) nextState.missionDrafts = (nextState.missionDrafts || []).filter((item) => item.id !== input.draftId);
    return { state: await persistState(nextState) };
  };

  const requireDraft = (state, id, revision) => {
    const draft = (state.missionDrafts || []).find((item) => item.id === id);
    if (!draft) throw applicationError('待配置任务不存在，可能已完成配置。请刷新任务列表。', 404, 'MISSION_DRAFT_NOT_FOUND');
    if (revision !== undefined && revision !== draft.revision) throw applicationError('草稿已在其他窗口更新，请重新打开后编辑。', 409, 'MISSION_DRAFT_CONFLICT');
    return draft;
  };
  const getDraft = async (id) => ({ draft: requireDraft(await loadState(), id) });
  const saveDraft = async (input = {}) => {
    const form = input.form;
    if (!form || typeof form !== 'object' || Array.isArray(form)
      || form.mode !== 'generic' || form.inputMode !== 'form' || form.sourceMode !== 'managed'
      || typeof form.operator !== 'string' || !form.operator.trim()
      || typeof form.goal !== 'string' || !form.goal.trim()
      || Buffer.byteLength(JSON.stringify(form), 'utf8') > 128 * 1024) {
      throw applicationError('请填写算子名称与开发目标；草稿配置限 128 KiB。', 400, 'MISSION_DRAFT_INVALID');
    }
    const state = structuredClone(await loadState());
    if (input.id && !Number.isSafeInteger(input.revision)) throw applicationError('更新草稿必须提供当前版本。', 409, 'MISSION_DRAFT_CONFLICT');
    const previous = input.id ? requireDraft(state, input.id, input.revision) : null;
    const now = new Date().toISOString();
    const draft = { id: previous?.id || `DRAFT_${randomUUID()}`, revision: (previous?.revision || 0) + 1,
      createdAt: previous?.createdAt || now, updatedAt: now, form: structuredClone(form) };
    state.missionDrafts = [draft, ...(state.missionDrafts || []).filter((item) => item.id !== draft.id)];
    return { draft, state: await persistState(state) };
  };

  return Object.freeze({ list, create, getDraft, saveDraft });
};
