import { assertResourcesReleased } from '../cancellation-contract.mjs';

export const createRuntimeStateService = ({ loadState, persistState, resumeMissionState, normalizeMissionBudgetMs } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof resumeMissionState !== 'function' || typeof normalizeMissionBudgetMs !== 'function') {
    throw new TypeError('Runtime state service requires state, resume, and budget dependencies.');
  }
  const hasBudgetInput = (input) => Boolean(input && typeof input === 'object' && !Array.isArray(input) && ['missionBudgetMs', 'timeBudgetMs', 'missionBudgetHours', 'timeBudgetHours'].some((key) => Object.hasOwn(input, key)));
  const rawBudget = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    if (Object.hasOwn(input, 'missionBudgetMs')) return input.missionBudgetMs;
    if (Object.hasOwn(input, 'timeBudgetMs')) return input.timeBudgetMs;
    if (Object.hasOwn(input, 'missionBudgetHours')) return Number(input.missionBudgetHours) * 60 * 60 * 1000;
    if (Object.hasOwn(input, 'timeBudgetHours')) return Number(input.timeBudgetHours) * 60 * 60 * 1000;
    return null;
  };
  const validateBudget = (input) => {
    const raw = rawBudget(input);
    if ((!hasBudgetInput(input) && input && typeof input === 'object' && !Array.isArray(input)) || raw === null || raw === undefined || raw === '' || raw === false || Number(raw) === 0) return { ok: true, value: null };
    const normalized = normalizeMissionBudgetMs(input);
    return normalized ? { ok: true, value: normalized } : { ok: false, value: null };
  };
  const patch = async (body = {}) => {
    const state = await loadState();
    if (body.testMatrix && (!Array.isArray(body.testMatrix.environments) || !body.testMatrix.environments.length || !Array.isArray(body.testMatrix.stages) || !body.testMatrix.stages.length)) {
      return { statusCode: 400, payload: { error: '测试矩阵至少需要一个环境和一个验证阶段。' } };
    }
    if (hasBudgetInput(body)) {
      const budget = validateBudget(body);
      if (!budget.ok) return { statusCode: 400, payload: { error: 'missionBudgetMs 必须是正数毫秒；传 null、空值或 0 表示不启用时间限制。', code: 'INVALID_MISSION_BUDGET' } };
      state.missionBudgetMs = budget.value;
      if (!budget.value) state.missionBudgetStartedAt = null;
    }
    for (const key of ['testMatrix', 'workspace', 'unreadCount']) if (Object.hasOwn(body, key)) state[key] = body[key];
    if (body.missionPaused === true) state.missionPaused = true;
    if (body.missionPaused === false) {
      assertResourcesReleased(state);
      resumeMissionState(state, { source: 'local-c500-tui' });
    }
    return { statusCode: 200, payload: { state: await persistState(state) } };
  };
  return Object.freeze({ patch });
};
