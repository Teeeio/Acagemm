import assert from 'node:assert/strict';

export const isHardwareMockTerminalFailure = (snapshot = {}) => {
  const state = snapshot.state || {};
  const mission = snapshot.mission || {};
  const loop = state.iterationStats?.loopStatus;
  return ['failed', 'cancelled', 'needs_human'].includes(loop)
    || ['failed', 'cancelled', 'needs_human'].includes(mission.status);
};

export const isHardwareMockWorkflowCompleted = (snapshot = {}) => {
  const state = snapshot.state || {};
  const mission = snapshot.mission || {};
  return ['completed', 'published'].includes(state.iterationStats?.loopStatus)
    || ['completed', 'published'].includes(mission.status);
};

export const validateHardwareMockSnapshot = ({ snapshot, published, profileId, runtimeId }) => {
  const missionTasks = snapshot.tasks.filter((task) => (task.payload?.missionId || task.missionId) === published.missionId);
  const baselineTasks = missionTasks.filter((task) => task.payload?.purpose === 'baseline');
  const candidateTasks = missionTasks.filter((task) => task.payload?.purpose === 'candidate');
  const completedCandidateTasks = candidateTasks.filter((task) => task.status === 'completed');
  const failedCandidateTasks = candidateTasks.filter((task) => task.status === 'failed');
  assert.equal(baselineTasks.length, 1, `${profileId} must have one baseline task`);
  assert.equal(baselineTasks[0].status, 'completed');
  assert.equal(completedCandidateTasks.length, 3, `${profileId} must have three completed performance rounds`);
  assert.ok(failedCandidateTasks.length <= 12, `${profileId} exceeded bounded correctness repair attempts`);
  assert.ok(missionTasks.every((task) => ['completed', 'failed'].includes(task.status)));
  const evidenceTasks = [baselineTasks[0], ...completedCandidateTasks];
  assert.ok(evidenceTasks.every((task) => task.result?.environment?.source === 'simulation'));
  assert.ok(evidenceTasks.every((task) => task.result?.environment?.liveHardware === false));
  assert.equal(new Set(completedCandidateTasks.map((task) => task.payload?.candidate?.digest)).size, 3);
  assert.equal(snapshot.state.decisionReview?.gate?.publishable, false);
  assert.notEqual(snapshot.state.currentBest?.verified, true);
  assert.ok((snapshot.state.publishedAssets || []).every((asset) => asset.status === 'simulation'));

  const usage = snapshot.state.tokenUsage || {};
  assert.ok(Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0);
  assert.equal(usage.completeness, 'exact');
  const coverage = String(usage.coverage || '').match(/^(\d+)\/(\d+) runs exact$/);
  assert.ok(coverage, 'token coverage must use the exact run coverage format');
  assert.ok(Number(coverage[2]) > 0, 'token coverage must include at least one provider run');
  assert.equal(Number(coverage[1]), Number(coverage[2]), 'every provider run must have exact token usage');
  return {
    profileId,
    missionId: published.missionId,
    runtimeId,
    candidateTasks: completedCandidateTasks.length,
    correctnessRepairTasks: failedCandidateTasks.length,
    best: snapshot.state.currentBest,
    tokenUsage: { totalTokens: usage.totalTokens || 0, completeness: usage.completeness, coverage: usage.coverage },
    evidence: 'simulation',
    publishable: false,
  };
};
