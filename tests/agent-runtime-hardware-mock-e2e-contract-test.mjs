import assert from 'node:assert/strict';
import {
  isHardwareMockTerminalFailure,
  isHardwareMockWorkflowCompleted,
  validateHardwareMockSnapshot,
} from '../scripts/hardware-mock-e2e-contract.mjs';

const missionId = 'MIS_HARDWARE_MOCK';
const task = ({ purpose, status = 'completed', candidate, digest, liveHardware = false }) => ({
  taskId: `task-${purpose}-${candidate}`,
  status,
  payload: { missionId, purpose, candidate: { id: candidate, digest } },
  result: status === 'completed' ? { environment: { source: 'simulation', liveHardware } } : null,
  error: status === 'failed' ? { code: 'LOCAL_C500_SCENARIO_ARTIFACT_INVALID' } : null,
});
const makeSnapshot = () => ({
  mission: { id: missionId, status: 'completed' },
  state: {
    iterationStats: { loopStatus: 'completed', loopStatusReason: 'fixed_rounds_complete' },
    decisionReview: { gate: { publishable: false } },
    currentBest: { candidateId: null, verified: false },
    publishedAssets: [],
    tokenUsage: { totalTokens: 12345, completeness: 'exact', coverage: '4/4 runs exact' },
  },
  tasks: [
    task({ purpose: 'baseline', candidate: 'baseline', digest: 'sha256:baseline' }),
    task({ purpose: 'candidate', status: 'failed', candidate: 'candidate-01', digest: 'sha256:rejected' }),
    task({ purpose: 'candidate', candidate: 'candidate-01', digest: 'sha256:one' }),
    task({ purpose: 'candidate', candidate: 'candidate-02', digest: 'sha256:two' }),
    task({ purpose: 'candidate', candidate: 'candidate-03', digest: 'sha256:three' }),
  ],
});
const validate = (snapshot) => validateHardwareMockSnapshot({
  snapshot,
  published: { missionId },
  profileId: 'paged-mqa-logits-triton-v01',
  runtimeId: 'codex-cli',
});

const snapshot = makeSnapshot();
assert.equal(isHardwareMockWorkflowCompleted(snapshot), true);
assert.equal(isHardwareMockTerminalFailure(snapshot), false);
assert.deepEqual(validate(snapshot), {
  profileId: 'paged-mqa-logits-triton-v01',
  missionId,
  runtimeId: 'codex-cli',
  candidateTasks: 3,
  correctnessRepairTasks: 1,
  best: { candidateId: null, verified: false },
  tokenUsage: { totalTokens: 12345, completeness: 'exact', coverage: '4/4 runs exact' },
  evidence: 'simulation',
  publishable: false,
});

const expectReject = (mutate) => {
  const candidate = structuredClone(makeSnapshot());
  mutate(candidate);
  assert.throws(() => validate(candidate), assert.AssertionError);
};
expectReject((value) => { value.tasks.pop(); });
expectReject((value) => { value.tasks.at(-1).payload.candidate.digest = 'sha256:two'; });
expectReject((value) => { value.tasks.at(-1).result.environment.liveHardware = true; });
expectReject((value) => { value.state.currentBest.verified = true; });
expectReject((value) => { value.state.tokenUsage.coverage = '3/4 runs exact'; });
expectReject((value) => { value.state.decisionReview.gate.publishable = true; });

const blocked = makeSnapshot();
blocked.state.iterationStats = { loopStatus: 'needs_human', loopStatusReason: 'candidate_generation_failed' };
blocked.mission.status = 'needs_human';
assert.equal(isHardwareMockWorkflowCompleted(blocked), false);
assert.equal(isHardwareMockTerminalFailure(blocked), true);

console.log('[agent-runtime-hardware-mock-e2e-contract] completion, repair, evidence and exact-token guards passed');
