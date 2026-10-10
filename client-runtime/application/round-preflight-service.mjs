export const createRoundPreflightService = ({ settleGenerationAttemptBeforeStart, buildRuntimePreflight }) => {
  if (typeof settleGenerationAttemptBeforeStart !== 'function' || typeof buildRuntimePreflight !== 'function') throw new TypeError('Round preflight service dependencies are required.');
  const prepare = async ({ state, goal, retryMode = 'generation' }) => {
    const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
    const settlement = settleGenerationAttemptBeforeStart(state, mission, { retryMode });
    if (settlement.blocked) return { blocked: true, state, mission, preflight: null };
    const preflight = await buildRuntimePreflight(mission);
    if (!preflight.ready) return { blocked: true, state, mission, preflight };
    return { blocked: false, state, mission, preflight };
  };
  return Object.freeze({ prepare });
};
