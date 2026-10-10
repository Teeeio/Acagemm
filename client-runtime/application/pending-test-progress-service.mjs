import { assertPendingTestAdmission } from '../pending-test-contract.mjs';

// Continue only a previously committed frozen test request. This is a step in
// the production pipeline, not a second scheduler or a generation workflow.
export const createPendingTestProgressService = ({ missionState, benchmarkProjection, executeCommand, journal, registry, persistState }) => {
  const advance = async ({ state }) => {
    let current = state;
    let changed = false;
    const ids = state.missions.filter(mission => {
      const stats = mission.id === state.activeMissionId ? state.iterationStats : mission.iterationStats;
      return stats?.pendingTest && stats?.pendingValidation;
    }).map(mission => mission.id);
    for (const missionId of ids) {
      let view = missionId === current.activeMissionId ? current : missionState.createMissionRuntimeView(current, missionId);
      if (missionId !== current.activeMissionId) {
        const projected = await benchmarkProjection.project({ state: view });
        view = projected.state;
        if (projected.changed) { current = missionState.mergeMissionRuntimeView(current, view); changed = true; }
      }
      if (view.iterationStats?.pendingTest?.status !== 'baseline_complete') continue;
      const manifestDigest = view.iterationStats.pendingValidation.manifestDigest;
      try {
        assertPendingTestAdmission(view, { missionId, manifestDigest });
      } catch (error) {
        view.iterationStats.pendingTest = { ...view.iterationStats.pendingTest, status: 'blocked',
          error: { code: error.code || 'PENDING_TEST_ADMISSION_FAILED', message: error.message } };
        current = missionState.mergeMissionRuntimeView(current, view);
        changed = true;
        continue;
      }
      // The completed baseline is a prerequisite of candidate preparation.
      // Commit it before recording an intent/effect, so restart sees exactly
      // the version and evidence on which this command was admitted.
      current = await persistState(missionState.mergeMissionRuntimeView(current, view));
      view = missionId === current.activeMissionId ? current : missionState.createMissionRuntimeView(current, missionId);
      // Any failure after command preparation is owned by journal recovery;
      // never turn an unknown queue effect into an ordinary blocked submission.
      const result = await executeCommand({ journal, registry, state: view, type: 'start-benchmark',
          body: { purpose: 'candidate', pendingManifestDigest: manifestDigest }, expectedVersion: view.stateVersion,
          saveState: async nextView => {
            current = await persistState(missionState.mergeMissionRuntimeView(current, nextView));
            return missionId === current.activeMissionId ? current : missionState.createMissionRuntimeView(current, missionId);
          } });
      if (result.status === 'conflict') throw Object.assign(new Error('Pending test state changed.'), { code: 'STATE_VERSION_CONFLICT' });
      current = missionState.mergeMissionRuntimeView(current, result.state);
      changed = true;
    }
    return { state: current, changed };
  };
  return Object.freeze({ advance });
};
