const OBJECTIVE_MODES = new Set(['smoke', 'threshold', 'maximize']);

const objectiveTextFor = (mission = {}, overrides = {}) => `${overrides.goal || mission.goal || ''} ${overrides.title || mission.title || ''} ${overrides.metric || mission.metric || ''}`.toLowerCase();

export const inferMissionObjectiveMode = (mission = {}, overrides = {}) => {
  const explicit = String(overrides.mode || mission.objective?.mode || '').toLowerCase();
  if (OBJECTIVE_MODES.has(explicit)) return explicit;
  const text = objectiveTextFor(mission, overrides);
  if (/不设.*上限|越.*好|maximi[sz]e|最大化|持续优化|加速比.*越|speedup\s*maximi[sz]e/.test(text)) return 'maximize';
  if (/smoke|冒烟|闭环验证|runner\s*测试|runner\s*验证|接入测试/.test(text)) return 'smoke';
  if (/(?:<|<=|≤|低于|不高于|控制在)\s*\d+(?:\.\d+)?\s*(?:μs|us|ms)?/i.test(text)) return 'threshold';
  return 'threshold';
};

export const normalizeMissionObjective = (objective = {}, mission = {}) => {
  const mode = inferMissionObjectiveMode(mission, objective || {});
  const metric = objective?.metric || mission.metric || 'latency_p50';
  const direction = objective?.direction || (String(metric).toLowerCase().includes('throughput') ? 'maximize' : 'minimize');
  const completionPolicy = objective?.completionPolicy || objective?.completion || (mode === 'maximize' ? 'budget_or_plateau' : 'gate');
  return {
    mode,
    metric,
    direction,
    completionPolicy,
    ...(Number.isFinite(Number(objective?.targetRelativeImprovement))
      ? { targetRelativeImprovement: Number(objective.targetRelativeImprovement) }
      : {}),
    inferred: !objective?.mode,
  };
};

export const isMaximizeMission = (mission = {}) => normalizeMissionObjective(mission.objective || {}, mission).mode === 'maximize';
