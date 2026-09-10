import { isExecutionReleased, pendingMissionResources, assertResourcesReleased, resourceReleaseBarrier } from '../cancellation-contract.mjs';

const retainUntrackedResources = (state, current, requestedAt, deadline) => {
  const barrier = resourceReleaseBarrier(state);
  if (!barrier) return [];
  const previous = Array.isArray(barrier.resources) ? barrier.resources : [{ kind: 'unknown', id: 'untracked', reason: barrier.reason }];
  return previous.filter(resource => resource.confirmed !== true
    && !current.some(item => item.kind === resource.kind && item.id === resource.id)).map(resource => ({
    ...resource, kind: resource.kind || 'unknown', id: resource.id || 'untracked', confirmed: false, status: 'unconfirmed',
    blocked: true, quarantined: true,
    reason: 'The recorded execution no longer has a matching Mission resource; release cannot be inferred.',
    requestedAt: resource.requestedAt || requestedAt, deadline: resource.deadline || deadline,
    nextAction: 'Inspect the original execution owner and confirm termination; repeating stop cannot discard unknown resources.',
    error: resource.error || { code: 'MISSION_RESOURCE_IDENTITY_UNAVAILABLE', message: 'The original resource identity is absent from the current Mission snapshots.' },
  }));
};

export const createMissionControlService = ({ loadState, persistState, agentRuntime, operatorTestQueue, appendRuntimeEvent, addAuditEvent, now = () => new Date(), createId = () => Date.now().toString(36), cancellationTimeoutMs = 5_000 } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || !agentRuntime || !operatorTestQueue || typeof appendRuntimeEvent !== 'function' || typeof addAuditEvent !== 'function') {
    throw new TypeError('Mission control service requires state, Agent, test queue, event, and audit dependencies.');
  }

  const cancelRun = async (missionId, runId) => {
    const state = await loadState();
    if (state.activeMissionId !== missionId) {
      const error = new Error('The requested Agent run does not belong to the active Mission.'); error.status = 409; error.code = 'AGENT_MISSION_MISMATCH'; throw error;
    }
    const cancelled = await agentRuntime.cancelRun({ state, runId });
    return { state: await persistState(cancelled.state), result: cancelled.result };
  };

  const addHumanFeedback = async (body = {}) => {
    const state = await loadState();
    const note = String(body.note || '').trim();
    if (note.length < 2) return { statusCode: 400, payload: { error: '人工意见至少需要 2 个字符。', code: 'HUMAN_FEEDBACK_REQUIRED' } };
    assertResourcesReleased(state);
    const feedback = { id: `feedback_${createId()}`, note, submittedAt: now().toISOString(), source: 'local-c500-tui' };
    state.missionPaused = false;
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null, pendingInjection: { noteId: feedback.id, direction: 'human_feedback', briefing: `人工意见：${note}`, value: 'high' } };
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (mission) mission.status = 'running';
    appendRuntimeEvent(state, 'mission.human_feedback_added', feedback, { kind: 'human-feedback', mode: 'client' });
    addAuditEvent(state, '已添加人工意见', note, 'blue', 'UserRound');
    return { statusCode: 202, state: await persistState(state), feedback };
  };

  const releaseResources = async (state, { reason = 'mission_stop' } = {}) => {
    const requestedAt = now().toISOString();
    const deadline = new Date(now().getTime() + cancellationTimeoutMs).toISOString();
    const resources = pendingMissionResources(state);
    const untracked = retainUntrackedResources(state, resources, requestedAt, deadline);
    const results = await Promise.all(resources.map(async ({ kind, id, snapshot }) => {
      let timer;
      const operation = Promise.resolve().then(() => kind === 'test'
        ? operatorTestQueue.cancel(id)
        : agentRuntime.cancelRun({ state: structuredClone(state), runId: id }));
      // Late provider responses cannot mutate state: each Agent receives an isolated
      // snapshot. Timeout means quarantined/unconfirmed, not cancelled.
      const outcome = await new Promise(resolve => {
        timer = setTimeout(() => resolve({ error: { code: 'MISSION_CANCEL_DEADLINE_EXCEEDED', message: 'Cancellation did not acknowledge before its deadline.' } }), cancellationTimeoutMs);
        operation.then(value => { clearTimeout(timer); resolve({ value }); },
          error => { clearTimeout(timer); resolve({ error: { code: error.code || 'MISSION_CANCEL_FAILED', message: error.message } }); });
      });
      const result = kind === 'test' ? outcome.value : outcome.value?.result;
      const confirmed = !outcome.error && isExecutionReleased(result || {});
      // Keep the cause of the operation failure separate from the lifecycle
      // truth of the resource. A timeout/unknown release must not overwrite a
      // provider failure (for example TLS or capacity) and must remain
      // fail-closed even when the caller's cancellation deadline expires.
      const primaryFailure = snapshot.primaryFailure
        || result?.primaryFailure
        || outcome.value?.state?.agent?.primaryFailure
        || outcome.value?.state?.researchAgent?.primaryFailure
        || outcome.value?.state?.baseline?.materializer?.primaryFailure
        || null;
      const releaseUnconfirmed = !confirmed;
      const quarantine = releaseUnconfirmed && (Boolean(outcome.error)
        || ['unconfirmed', 'quarantined', 'blocked'].includes(result?.resourceRelease?.status)
        || result?.resourceRelease?.blocked === true
        || result?.resourceRelease?.quarantined === true);
      const release = {
        kind, id, confirmed, status: confirmed ? 'confirmed' : outcome.error || result?.resourceRelease?.status === 'unconfirmed' ? 'unconfirmed' : 'pending',
        reason: confirmed ? 'Execution has confirmed termination.' : outcome.error?.message || result?.resourceRelease?.reason || 'Cancellation requested; execution resource release is not yet confirmed.',
        requestedAt, deadline,
        // `blocked`/`quarantined` are additive lifecycle markers. `status`
        // remains backward-compatible (`pending`/`unconfirmed`) for existing
        // adapters and fixtures while callers migrate to the explicit fields.
        blocked: quarantine || result?.resourceRelease?.blocked === true,
        quarantined: quarantine || result?.resourceRelease?.quarantined === true,
        primaryFailure,
        nextAction: confirmed ? 'No action required.' : quarantine
          ? 'Resource release is unconfirmed; Mission is quarantined and no retry or workspace mutation is permitted until owner-aware inspection confirms termination.'
          : 'Inspect or retry cancellation. Resume and workspace changes remain blocked until release is confirmed.',
        ...(outcome.error || result?.resourceRelease?.code ? {
          releaseFailure: outcome.error || { code: result.resourceRelease.code, message: result.resourceRelease.reason },
        } : {}),
        ...(outcome.error ? { error: outcome.error } : result?.resourceRelease?.code ? { error: { code: result.resourceRelease.code, message: result.resourceRelease.reason } } : {}),
      };
      const updated = kind === 'agent' ? outcome.value?.state?.agent
        : kind === 'research' ? outcome.value?.state?.researchAgent
          : kind === 'materializer' ? outcome.value?.state?.baseline?.materializer : null;
      const next = { ...snapshot, ...(updated || {}), resourceRelease: release,
        ...(kind !== 'test' ? { status: confirmed ? result.status : 'cancel_requested', currentAction: null } : { cancelRequested: true }) };
      return { kind, next, release };
    }));
    for (const { kind, next } of results) {
      if (kind === 'agent') state.agent = next;
      else if (kind === 'research') state.researchAgent = next;
      else if (kind === 'materializer') state.baseline = { ...state.baseline, materializer: next };
      else state.benchmark = next;
    }
    const releases = [...results.map(item => item.release), ...untracked];
    const confirmed = releases.every(resource => resource.confirmed);
    const quarantined = !confirmed && releases.some(resource => resource.quarantined === true || resource.blocked === true);
    const primaryFailure = releases.find(resource => resource.primaryFailure)?.primaryFailure || null;
    const summary = { confirmed, status: confirmed ? 'confirmed' : releases.some(resource => resource.status === 'unconfirmed') ? 'unconfirmed' : 'pending',
      blocked: quarantined, quarantined, primaryFailure,
      reason, requestedAt, deadline, nextAction: confirmed ? 'All active execution resources have been released.' : quarantined
        ? 'Mission is quarantined because resource release is unconfirmed; inspect the original owner before any retry or workspace mutation.'
        : 'Inspect pending resources or retry cancellation before resuming.',
      resources: releases };
    state.workflowRecovery = { ...state.workflowRecovery, resourceRelease: summary };
    return summary;
  };

  const stopMission = async () => {
    let state = await loadState();
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (!mission) return { statusCode: 404, payload: { error: '当前没有可停止的 Mission。', code: 'MISSION_NOT_FOUND' } };
    state.missionPaused = true;
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'stopped', loopStatusReason: 'stopped_by_tester', stoppedAt: now().toISOString() };
    mission.status = 'stopped';
    const requestedAt = now().toISOString();
    const deadline = new Date(now().getTime() + cancellationTimeoutMs).toISOString();
    const currentResources = pendingMissionResources(state);
    const untracked = retainUntrackedResources(state, currentResources, requestedAt, deadline);
    state.workflowRecovery = { ...state.workflowRecovery, resourceRelease: {
      confirmed: false, status: 'pending', reason: 'mission_stop', requestedAt, deadline,
      nextAction: 'Cancellation is being dispatched; resources must confirm release before resume.',
      resources: [...currentResources.map(({ kind, id }) => ({ kind, id, confirmed: false, status: 'pending',
        reason: 'Cancellation is awaiting dispatch.', requestedAt, deadline, nextAction: 'Await cancellation acknowledgement and resource release.' })), ...untracked],
    } };
    // Durable stop intent precedes provider/queue cancellation.
    state = await persistState(state);
    const resourceRelease = await releaseResources(state, { reason: 'mission_stop' });
    appendRuntimeEvent(state, 'mission.stopped', { missionId: state.activeMissionId, source: 'local-c500-tui', resourceRelease }, { kind: 'mission', mode: 'client' });
    addAuditEvent(state, resourceRelease.confirmed ? 'Mission 已停止' : 'Mission 已停止推进，等待资源释放', state.activeMissionId + ' · ' + resourceRelease.status, 'warning', 'Square');
    return { statusCode: resourceRelease.confirmed ? 200 : 202, state: await persistState(state), resourceRelease };
  };

  return Object.freeze({ cancelRun, addHumanFeedback, stopMission, releaseResources });
};
