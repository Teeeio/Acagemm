import { createSemanticSnapshot, freezeSemanticSnapshot } from '../semantic-snapshot.mjs';

const notFound = () => {
  const error = new Error('Mission 不存在。');
  error.status = 404;
  error.code = 'MISSION_NOT_FOUND';
  return error;
};

export const createSemanticService = ({ loadState, persistState, guardMutation = () => {}, appendRuntimeEvent = () => {}, addAuditEvent = () => {}, semantic = { createSemanticSnapshot, freezeSemanticSnapshot } } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function') throw new TypeError('Semantic service requires state dependencies.');
  const freeze = async (missionId, input = {}) => {
    const state = await loadState();
    guardMutation(state);
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission) throw notFound();
    const draft = semantic.createSemanticSnapshot({ mission, semanticDraft: input.semanticDraft || {}, snapshot: input.snapshot || mission.semanticSnapshot || null });
    const frozen = semantic.freezeSemanticSnapshot(draft);
    mission.semanticSnapshot = frozen;
    mission.status = mission.status === 'ready' ? 'ready' : mission.status;
    mission.updatedLabel = '语义已冻结';
    if (state.activeMissionId === missionId) state.semanticSnapshot = structuredClone(frozen);
    appendRuntimeEvent(state, 'semantic.snapshot_frozen', { missionId, snapshotId: frozen.snapshotId, semanticDigest: frozen.digest, version: frozen.version }, { kind: 'semantic', mode: 'client' });
    addAuditEvent(state, '语义快照已冻结', `${mission.title || missionId} · ${frozen.digest}`, 'green', 'LockKeyhole');
    return { snapshot: frozen, state: await persistState(state) };
  };
  return Object.freeze({ freeze });
};
