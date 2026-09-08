import assert from 'node:assert/strict';
import { createSharedGpuExperienceVerifier } from '../client-runtime/application/shared-gpu-experience-verifier.mjs';

const digest = (char) => 'sha256:' + char.repeat(64);
const evidence = {
  missionId: 'MIS_VERIFIER', candidateId: 'candidate-01', runId: 'run-01',
  patchDigest: digest('a'), packageDigest: digest('b'), environmentDigest: digest('c'), acceptanceDigest: digest('d'),
  hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'passed', operation: 'test', liveHardware: true,
};
const packageBinding = {
  packageDigest: evidence.packageDigest, admissionId: 'admission-01', preparedArtifactDigest: digest('e'),
  environmentDigest: evidence.environmentDigest, acceptanceDigest: evidence.acceptanceDigest,
  workspaceId: 'MIS_VERIFIER', target: { platform: 'nvidia-cuda', device: 'gpu' }, build: {}, adapter: { id: 'python-shared-gpu', version: '1', languages: ['python'] },
};
let admissionCalls = 0;
const verifier = createSharedGpuExperienceVerifier({
  executionPackageStore: { verifyAdmission: async (request) => { admissionCalls += 1; assert.equal(request.packageDigest, evidence.packageDigest); return { manifest: {}, environment: {} }; } },
  packageAdapter: { verifyPreparedArtifact: async ({ preparedArtifactDigest }) => ({ valid: preparedArtifactDigest === packageBinding.preparedArtifactDigest }) },
  now: () => 1_000,
});
const state = { activeMissionId: 'MIS_VERIFIER', benchmark: { status: 'complete', purpose: 'candidate', candidate: { id: evidence.candidateId, digest: evidence.patchDigest }, executionPackage: packageBinding, result: { experienceEvidence: evidence } } };
const mission = { id: 'MIS_VERIFIER', workspaceId: 'MIS_VERIFIER' };
assert.deepEqual(await verifier({ state, mission, observation: { evidence } }), { verified: true, evidence, summary: 'Trusted shared-GPU package admission admission-01 and prepared artifact were revalidated; development evidence remains non-publishable.' });
assert.equal(admissionCalls, 1);
assert.equal((await verifier({ state, mission, observation: { evidence: { ...evidence, candidateId: 'other' } } })).verified, false);
const workerClaim = { ...state, benchmark: { ...state.benchmark, result: { experienceEvidence: { ...evidence, verified: true } } } };
assert.equal((await verifier({ state: workerClaim, mission, observation: { evidence } })).verified, false, 'worker-provided flags cannot authorize evidence');
console.log('[shared-gpu-experience-verifier] admission, artifact, candidate and worker-flag checks passed');
