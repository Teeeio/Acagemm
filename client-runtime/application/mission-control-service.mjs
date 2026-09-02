export const createMissionControlService = ({ loadState, persistState, agentRuntime, operatorTestQueue, appendRuntimeEvent, addAuditEvent, now = () => new Date(), createId = () => Date.now().toString(36) } = {}) => {
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
    const feedback = { id: `feedback_${createId()}`, note, submittedAt: now().toISOString(), source: 'local-c500-tui' };
    state.missionPaused = false;
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null, pendingInjection: { noteId: feedback.id, direction: 'human_feedback', briefing: `人工意见：${note}`, value: 'high' } };
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (mission) mission.status = 'running';
    appendRuntimeEvent(state, 'mission.human_feedback_added', feedback, { kind: 'human-feedback', mode: 'client' });
    addAuditEvent(state, '已添加人工意见', note, 'blue', 'UserRound');
    return { statusCode: 202, state: await persistState(state), feedback };
  };

  const stopMission = async () => {
    const state = await loadState();
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (!mission) return { statusCode: 404, payload: { error: '当前没有可停止的 Mission。', code: 'MISSION_NOT_FOUND' } };
    if (state.benchmark?.status === 'running' && state.benchmark?.testTaskId) await operatorTestQueue.cancel(state.benchmark.testTaskId).catch(() => null);
    if (state.agent?.runId && ['running', 'executing', 'awaiting_action', 'cancel_requested'].includes(state.agent.status)) {
      const cancelled = await agentRuntime.cancelRun({ state, runId: state.agent.runId }).catch(() => null);
      if (cancelled?.state) Object.assign(state, cancelled.state);
    }
    state.missionPaused = true;
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'stopped', loopStatusReason: 'stopped_by_tester', stoppedAt: now().toISOString() };
    const activeMission = state.missions?.find((item) => item.id === state.activeMissionId) || mission;
    activeMission.status = 'stopped';
    appendRuntimeEvent(state, 'mission.stopped', { missionId: activeMission.id, source: 'local-c500-tui' }, { kind: 'mission', mode: 'client' });
    addAuditEvent(state, 'Mission 已停止', `${activeMission.id} · 测试人员停止`, 'warning', 'Square');
    return { statusCode: 200, state: await persistState(state) };
  };

  return Object.freeze({ cancelRun, addHumanFeedback, stopMission });
};
