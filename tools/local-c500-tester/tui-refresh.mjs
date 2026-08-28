const visibleSnapshot = (snapshot = {}) => ({
  state: snapshot.state || {},
  mission: snapshot.mission || null,
  health: snapshot.health ? { ...snapshot.health, time: undefined } : {},
  tasks: snapshot.tasks || [],
});

export const snapshotFingerprint = (snapshot) => JSON.stringify(visibleSnapshot(snapshot));

export const reconcileTuiSnapshot = (current, next) => {
  const currentVersion = Number(current?.state?.stateVersion || 0);
  const nextVersion = Number(next?.state?.stateVersion || 0);
  const currentMissionId = current?.state?.activeMissionId || current?.mission?.id || null;
  const nextMissionId = next?.state?.activeMissionId || next?.mission?.id || null;
  if ((currentVersion > 0 && nextVersion > 0 && nextVersion < currentVersion)
    || (currentVersion > 0 && nextVersion > 0 && nextVersion === currentVersion && currentMissionId !== nextMissionId)) return current;
  return snapshotFingerprint(current) === snapshotFingerprint(next) ? current : next;
};

export const reconcileOperationSnapshot = (current, result) => {
  const state = result?.state;
  if (!state || typeof state !== 'object') return current;
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || null;
  const previousMissionId = current?.state?.activeMissionId || current?.mission?.id || null;
  const missionChanged = Boolean(previousMissionId && state.activeMissionId && previousMissionId !== state.activeMissionId);
  return { ...(current || {}), state, mission, tasks: missionChanged ? [] : (current?.tasks || []) };
};

export const formatOperationResultMessage = (label, result = {}) => {
  if (label !== 'Resume mission') return `${label}: completed${result?.runId ? ` (${result.runId})` : ''}`;
  const state = result?.state || {};
  const loopStatus = state.iterationStats?.loopStatus || null;
  const reason = state.iterationStats?.loopStatusReason || null;
  if (state.missionPaused === true || ['stopped', 'paused_budget'].includes(loopStatus)) {
    return `Resume mission: still paused${reason ? ` (${reason})` : ''}`;
  }
  if (loopStatus === 'needs_human') return `Resume mission: still blocked${reason ? ` (${reason})` : ''}`;
  if (loopStatus === 'completed' || state.stage === 'published') return 'Resume mission: mission already completed';
  return `Resume mission: ${loopStatus || 'running'}`;
};

export const createLatestRefreshGate = () => {
  let requested = 0;
  return {
    begin() {
      requested += 1;
      return requested;
    },
    isLatest(requestId) {
      return requestId === requested;
    },
  };
};
