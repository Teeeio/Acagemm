const visibleSnapshot = (snapshot = {}) => ({
  state: snapshot.state || {},
  mission: snapshot.mission || null,
  health: snapshot.health ? { ...snapshot.health, time: undefined } : {},
  tasks: snapshot.tasks || [],
});

export const snapshotFingerprint = (snapshot) => JSON.stringify(visibleSnapshot(snapshot));

export const reconcileTuiSnapshot = (current, next) => (
  snapshotFingerprint(current) === snapshotFingerprint(next) ? current : next
);

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
