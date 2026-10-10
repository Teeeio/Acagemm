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
    ...(Number.isFinite(objective?.targetLatencyUs) && objective.targetLatencyUs > 0 ? { targetLatencyUs: objective.targetLatencyUs } : {}),
  };
};

export const isMaximizeMission = (mission = {}) => normalizeMissionObjective(mission.objective || {}, mission).mode === 'maximize';

// Performance targets written in the goal text. The Accept Gate grades with these,
// and the create form reads the same functions to show what a goal will mean.
export const parsePerformanceThreshold = (mission = {}) => {
  if (Number.isFinite(mission.objective?.targetLatencyUs) && mission.objective.targetLatencyUs > 0) return mission.objective.targetLatencyUs;
  const text = `${mission.goal || ''} ${mission.metric || ''}`;
  const match = text.match(/(?:<=|<|≤|低于|不高于|控制在)\s*(\d+(?:\.\d+)?)\s*(μs|µs|us|ms)\b/i)
    || text.match(/(?:<|<=|≤)\s*(\d+(?:\.\d+)?)(?![\d.]|\s*%)/i);
  return match ? Number(match[1]) * (match[2]?.toLowerCase() === 'ms' ? 1000 : 1) : null;
};

export const parseRelativeImprovementTarget = (mission = {}) => {
  const explicit = Number(mission.objective?.targetRelativeImprovement);
  if (Number.isFinite(explicit) && explicit > 0) return explicit > 1 ? explicit / 100 : explicit;
  const text = `${mission.goal || ''} ${mission.metric || ''}`;
  const match = text.match(/(?:相对\s*(?:baseline|基线)\s*)?(?:至少\s*)?(?:提升|改善|改进|improv(?:e|ement)?)\s*(?:至少\s*)?(\d+(?:\.\d+)?)\s*%/i)
    || text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:以上|或以上|的)?\s*(?:提升|改善|改进|improv(?:e|ement)?)/i);
  return match ? Number(match[1]) / 100 : null;
};

export const describeMissionGoal = (mission = {}) => ({
  mode: normalizeMissionObjective(mission.objective || {}, mission).mode,
  absoluteThreshold: parsePerformanceThreshold(mission),
  relativeTarget: parseRelativeImprovementTarget(mission),
});
