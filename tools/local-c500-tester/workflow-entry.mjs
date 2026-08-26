const terminalStatuses = new Set(['completed', 'budget_exhausted', 'needs_human', 'failed', 'stopped', 'paused']);

const lastCandidate = (mission = {}) => {
  const candidates = Array.isArray(mission.candidateEvaluations) ? mission.candidateEvaluations : [];
  return candidates.at(-1) || null;
};

export const projectMissionState = ({ mission = {}, summary = {} } = {}) => {
  const candidate = lastCandidate(mission);
  const status = mission.status || summary.status || 'idle';
  const stage = mission.client_stage || mission.stage || summary.client_stage || summary.stage || 'idle';
  const reason = mission.agent?.reason || mission.iterationStats?.loopStatusReason || summary.stop_reason || null;
  return {
    missionId: mission.mission_id || mission.id || summary.mission_id || null,
    title: mission.title || mission.name || summary.title || null,
    goal: mission.goal || summary.goal || null,
    status,
    stage,
    localStage: mission.stage || summary.stage || null,
    operator: {
      id: mission.agent?.operator_id || mission.operator || null,
      name: mission.agent?.operator_name || mission.operator_name || null,
      confidence: mission.agent?.confidence || null,
    },
    source: {
      kind: mission.agent?.source_kind || mission.discovery?.source_kind || null,
      status: mission.agent?.phase || mission.discovery?.status || null,
      reason,
    },
    baseline: {
      status: mission.baseline?.status || summary.baseline?.status || 'missing',
      source: mission.baseline?.source || summary.baseline?.source || null,
      latency_p50_us: mission.baseline?.latency_p50_us || summary.baseline_latency_p50_us || null,
    },
    currentCandidate: candidate ? {
      id: candidate.candidate_id || candidate.id || null,
      digest: candidate.candidate_digest || candidate.patchDigest || candidate.result?.candidate?.digest || null,
      status: candidate.status || null,
    } : null,
    currentBest: mission.current_best || summary.current_best || null,
    budget: {
      used: Number(mission.budget?.tokens_used || summary.budget?.tokens_used || 0),
      limit: mission.budget?.token_limit ?? summary.budget?.token_limit ?? null,
      elapsedMs: Number(mission.elapsed_ms || summary.elapsed_ms || 0),
      timeLimitMs: mission.budget?.time_limit_ms ?? summary.budget?.time_limit_ms ?? null,
    },
    evidence: {
      correctness: summary.correctness || candidate?.result?.correctness || null,
      latency_p50_us: summary.latency_p50_us || candidate?.result?.latency_p50_us || null,
      speedup: summary.speedup || candidate?.result?.speedup || null,
      tracer: summary.test_tools?.mctracer?.status || candidate?.result?.mctracer || null,
      profiler: summary.test_tools?.mcProfiler?.status || candidate?.result?.mcProfiler || null,
      liveHardware: summary.environment?.liveHardware ?? candidate?.result?.environment?.liveHardware ?? null,
    },
    events: mission.recent_events || summary.events || [],
    needsHuman: status === 'needs_human' || Boolean(reason && !terminalStatuses.has(status)),
    needsHumanReason: status === 'needs_human' ? reason : null,
    raw: { mission, summary },
  };
};

export const decideNextLocalAction = (state = {}) => {
  if (state.needsHuman || state.status === 'needs_human') return 'wait_human';
  if (state.status === 'paused') return 'paused';
  if (['stopped', 'failed', 'completed', 'budget_exhausted'].includes(state.status)) return 'terminal';
  if (state.baseline.status !== 'complete') return state.baseline.status === 'running' ? 'poll_baseline' : 'run_baseline';
  if (state.currentCandidate?.status === 'running' || state.currentCandidate?.status === 'scheduled') return 'poll_test';
  return 'generate_candidate';
};

export const createLocalWorkflow = ({ adapter, projectState = projectMissionState } = {}) => {
  if (!adapter) throw new Error('local workflow requires a test adapter');
  return {
    project: projectState,
    nextAction: decideNextLocalAction,
    submitTest: adapter.submitTest,
    pollTest: adapter.pollTest,
    cancelTest: adapter.cancelTest,
  };
};
