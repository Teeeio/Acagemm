// Provider-neutral cancellation truth and workflow barriers. No effects.
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const isExecutionReleased = (snapshot = {}) => TERMINAL.has(snapshot.status)
  && snapshot.resourceRelease?.confirmed !== false;

export const pendingMissionResources = (state = {}) => [
  { kind: 'agent', id: state.agent?.runId, snapshot: state.agent },
  { kind: 'research', id: state.researchAgent?.runId, snapshot: state.researchAgent },
  { kind: 'materializer', id: state.baseline?.materializer?.runId, snapshot: state.baseline?.materializer },
  { kind: 'test', id: state.benchmark?.testTaskId, snapshot: state.benchmark },
].filter(({ id, snapshot }) => id && (
  ['queued', 'waiting', 'running', 'executing', 'awaiting_action', 'awaiting_approval', 'cancel_requested'].includes(snapshot?.status)
  || snapshot?.resourceRelease?.confirmed === false
));


const snapshotForResource = (state, { kind, id }) => {
  const snapshot = kind === 'agent' ? state.agent : kind === 'research' ? state.researchAgent
    : kind === 'materializer' ? state.baseline?.materializer : kind === 'test' ? state.benchmark : null;
  return snapshot && (kind === 'test' ? snapshot.testTaskId : snapshot.runId) === id ? snapshot : null;
};

const projectReleaseSummary = (state = {}) => {
  const previous = state.workflowRecovery?.resourceRelease;
  if (!previous || !Array.isArray(previous.resources)) return previous || null;
  const resources = previous.resources.map(resource => {
    const snapshot = snapshotForResource(state, resource);
    const released = snapshot && (snapshot.resourceRelease?.confirmed === true
      || (!snapshot.resourceRelease && (isExecutionReleased(snapshot) || snapshot.status === 'complete')));
    if (!released) return resource;
    return { ...resource, ...(snapshot.resourceRelease || {}), kind: resource.kind, id: resource.id,
      confirmed: true, status: 'confirmed', reason: 'Execution resource release is confirmed.',
      nextAction: 'No action required.', error: null };
  });
  const confirmed = resources.every(resource => resource.confirmed === true);
  return { ...previous, resources, confirmed,
    status: confirmed ? 'confirmed' : resources.some(resource => resource.status === 'unconfirmed') ? 'unconfirmed' : 'pending',
    nextAction: confirmed ? 'All recorded execution resources have been released.' : previous.nextAction };
};

// Explicit advancement can persist this in-memory projection. Queries use the
// same calculation through resourceReleaseBarrier without mutating their input.
export const reconcileResourceRelease = (state = {}) => {
  const previous = state.workflowRecovery?.resourceRelease;
  const projected = projectReleaseSummary(state);
  const changed = Boolean(previous && JSON.stringify(previous) !== JSON.stringify(projected));
  if (changed) state.workflowRecovery = { ...state.workflowRecovery, resourceRelease: projected };
  return { state, changed };
};

export const resourceReleaseBarrier = (state = {}) => {
  const release = projectReleaseSummary(state);
  if (release && (release.confirmed === false || (release.confirmed !== true && release.status !== 'confirmed'))) return release;
  const resources = pendingMissionResources(state).filter(({ snapshot }) =>
    snapshot?.status === 'cancel_requested' || (snapshot?.resourceRelease?.confirmed === false && snapshot?.resourceRelease?.status !== 'active') || ['pending', 'unconfirmed'].includes(snapshot?.resourceRelease?.status));
  if (!resources.length) return null;
  return {
    confirmed: false, status: resources.some(({ snapshot }) => snapshot?.resourceRelease?.status === 'unconfirmed') ? 'unconfirmed' : 'pending',
    reason: 'Waiting for active execution resources to stop before another mutation.',
    nextAction: 'Inspect or retry cancellation; do not start another run or change its workspace.',
    resources: resources.map(({ kind, id, snapshot }) => ({ ...snapshot.resourceRelease, kind, id })),
  };
};

export const assertResourcesReleased = (state = {}) => {
  const barrier = resourceReleaseBarrier(state);
  if (barrier) throw Object.assign(new Error(barrier.reason || 'Execution resources have not been released.'), {
    code: 'MISSION_RESOURCE_RELEASE_PENDING', status: 409, retryable: false, details: barrier,
  });
};
