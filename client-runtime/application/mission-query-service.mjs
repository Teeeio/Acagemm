import { createResearchAgentState } from '../mission-state-shapes.mjs';

const notFound = (id) => {
  const error = new Error('Mission 不存在。');
  error.status = 404;
  error.code = 'MISSION_NOT_FOUND';
  error.missionId = id;
  return error;
};

export const createMissionQueryService = ({ loadState, persistState, missionState, researchAgentFactory = createResearchAgentState } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof missionState?.selectMission !== 'function') {
    throw new TypeError('Mission query service requires state dependencies.');
  }
  const select = async (missionId) => {
    const state = await loadState();
    if (!state.missions.some((mission) => mission.id === missionId)) throw notFound(missionId);
    return { state: await persistState(missionState.selectMission(state, missionId)) };
  };
  const events = async (missionId, after = 0) => {
    const state = await loadState();
    const entries = (state.runtimeEvents || []).filter((event) => event.missionId === missionId && event.sequence > after);
    return { missionId, events: entries, nextSequence: entries.at(-1)?.sequence || after };
  };
  const researchNotes = async (missionId) => {
    const state = await loadState();
    if (!state.missions.some((mission) => mission.id === missionId)) throw notFound(missionId);
    if (state.activeMissionId !== missionId) missionState.selectMission(state, missionId);
    return { missionId, notes: state.researchNotes || [], researchAgent: state.researchAgent || researchAgentFactory() };
  };
  return Object.freeze({ select, events, researchNotes });
};
