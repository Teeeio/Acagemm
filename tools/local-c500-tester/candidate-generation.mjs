import path from 'node:path';
import { buildCandidateContext, createCandidateAgent } from './candidate-agent.mjs';
import { admitCandidateDiff, createWorkspaceCheckpoint } from './candidate-admission.mjs';

export const generateMissionCandidate = async ({
  mission = {},
  workspaceRoot,
  checkpointRoot = path.join(workspaceRoot, '..', 'checkpoints', `round-${mission.round || Date.now()}`),
  baseline = null,
  sourceEvidence = [],
  failureRecords = [],
  profiler = null,
  tracer = null,
  humanNotes = [],
  currentBest = null,
  previousDigests = [],
  agent = {},
} = {}) => {
  await createWorkspaceCheckpoint({ workspaceRoot, checkpointRoot });
  const context = buildCandidateContext({ mission, workspaceRoot, baseline, sourceEvidence, failureRecords, profiler, tracer, humanNotes, currentBest });
  const runner = createCandidateAgent(agent);
  const output = await runner.generateCandidate(context);
  if (output.status === 'no_candidate') return { ...output, context, admission: { admitted: false, reason: 'no_candidate_reported', manifest: null } };
  if (output.status !== 'candidate_ready') return { ...output, context, admission: { admitted: false, reason: output.reason || 'candidate_agent_failed', manifest: null } };
  const admission = await admitCandidateDiff({ workspaceRoot, checkpointRoot, previousDigests });
  if (!admission.admitted) return { ...output, status: 'no_candidate', context, admission };
  return { ...output, context, admission };
};
