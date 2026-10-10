import { generationTimings, testTimings, elapsedObservation } from './generation-origin.mjs';

// Pure trace projection. These are observed facts, never new Gate verdicts.
export const TRACE_SCHEMA = 'operator-studio.iteration-trace/v1';
export const TRACE_KINDS = Object.freeze(['mission', 'agent-run', 'candidate', 'test', 'decision', 'round', 'runtime-event', 'audit-event']);

export function traceRecord(kind, mission, id, data) {
  return {
    key: JSON.stringify([kind, mission.id, id]), kind, id,
    missionId: mission.id, projectId: mission.projectId || null,
    experimentId: data?.generationOrigin?.experiment?.id || mission.experiment?.id || mission.experimentId || null,
    data: structuredClone(data),
  };
}

// Kept outside the bounded display windows, including across Mission selection.
// The storage commit consumes it only after both trace preparation and snapshot
// replacement succeed. It contains facts, not an instruction to run an effect.
export function enqueueTraceRecord(state, kind, id, data, missionId = state.activeMissionId) {
  const mission = state.missions?.find((item) => item.id === missionId)
    || { id: missionId, projectId: state.activeProjectId || null };
  if (!mission.id || !id) return;
  (state.tracePending ||= []).push(traceRecord(kind, mission, id, data));
}

export function projectTraceRecords(state) {
  const records = [];
  for (const mission of state.missions || []) {
    const add = (kind, id, data) => { if (id) records.push(traceRecord(kind, mission, id, data)); };
    add('mission', mission.id, {
      title: mission.title, goal: mission.goal, objective: mission.objective,
      hardware: mission.hardware, implementation: mission.implementation,
      semanticSnapshot: mission.semanticSnapshot, testMatrix: mission.testMatrix,
      baseline: mission.baseline, executionMode: mission.executionMode,
      iterationStats: mission.iterationStats, missionPaused: mission.missionPaused,
      workflowFailure: mission.workflowFailure, currentBest: mission.currentBest,
      tokenUsage: mission.tokenUsage,
      experiment: mission.experiment || null,
      attemptOrigin: mission.attemptOrigin || null,
    });
    const agent = mission.agent || {};
    add('agent-run', agent.runId, {
      runId: agent.runId, roundId: agent.roundId || null, threadId: agent.threadId || null,
      runtimeKind: agent.runtimeKind || null,
      status: agent.timedOut === true ? 'timed_out' : agent.executionStatus || agent.status,
      workflowStatus: agent.status, timedOut: agent.timedOut === true,
      resourceRelease: agent.resourceRelease || null, providerRetries: agent.providerRetries || null,
      primaryFailure: agent.primaryFailure || null,
      goal: agent.goal, startedAt: agent.startedAt || null, completedAt: agent.generationCompletedAt || agent.completedAt || null,
      modelObservation: agent.modelObservation || null, promptAudit: agent.promptAudit || null,
      generationOrigin: agent.generationOrigin || null,
      parentCandidateId: agent.generationOrigin?.parent?.candidateId || null,
      stageTimings: generationTimings(agent),
      error: agent.error || null, failure: agent.failure || null,
      candidateValidation: agent.candidateValidation || null,
    });
    for (const candidate of mission.candidateEvaluations || []) {
      if (candidate.id) add('candidate', JSON.stringify([candidate.id, candidate.sourceRunId || null, candidate.patchDigest || null]), candidate);
    }
    add('test', mission.benchmark?.runId, { ...mission.benchmark, stageTimings: testTimings(mission.benchmark) });
    const review = mission.decisionReview;
    if (review && review.status !== 'idle') {
      add('decision', review.id || mission.benchmark?.runId || agent.runId, { ...review,
        timing: elapsedObservation(review.requestedAt, review.resolvedAt || review.resolution?.resolvedAt) });
    }
    for (const round of mission.runHistory || []) add('round', round.runId, round);
    for (const event of mission.runtimeEvents || []) add('runtime-event', event.eventId, event);
    for (const event of mission.auditEvents || []) {
      // Legacy display entries have no stable identity. Do not invent event IDs.
      if (event.eventId) add('audit-event', event.eventId, event);
    }
  }
  return records;
}
