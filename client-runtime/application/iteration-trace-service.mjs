import { buildIterationEvaluation, renderIterationEvaluationMarkdown } from '../iteration-evaluation.mjs';

export const createIterationTraceService = ({ readState, traceStore } = {}) => {
  if (typeof readState !== 'function' || typeof traceStore?.query !== 'function') {
    throw new TypeError('Iteration trace service requires read-only state and trace ports.');
  }
  const readMission = async missionId => {
    const state = await readState();
    if (!state.missions?.some((mission) => mission.id === missionId)) {
      throw Object.assign(new Error('Mission 不存在。'), { code: 'MISSION_NOT_FOUND', status: 404 });
    }
    return state;
  };
  const query = async (missionId, options = {}) => {
    const state = await readMission(missionId);
    return traceStore.query(state.iterationTrace, { ...options, missionId });
  };
  const evaluate = async (missionId, { includeRecords = false } = {}) => {
    const state = await readMission(missionId);
    const records = [];
    let cursor = null, coverage;
    do {
      const page = await traceStore.query(state.iterationTrace, { missionId, view: 'latest', limit: 200, cursor });
      records.push(...page.records);
      coverage = page.coverage;
      cursor = page.nextCursor;
      if (records.length > 50000 || (cursor && records.length >= 50000)) {
        throw Object.assign(new Error('Evaluation exceeds 50000 facts; use the paginated trace export.'), { code: 'EVALUATION_TOO_LARGE', status: 413 });
      }
    } while (cursor);
    const source = {
      traceHead: state.iterationTrace?.head || null, stateVersion: state.stateVersion ?? null,
      snapshotAt: state.updatedAt || null, coverage,
    };
    const report = buildIterationEvaluation({ missionId, records, source });
    return includeRecords ? {
      schemaVersion: 'operator-studio.iteration-evaluation-export/v1',
      report, markdown: renderIterationEvaluationMarkdown(report), records,
    } : report;
  };
  return Object.freeze({ query, evaluate });
};
