import assert from 'node:assert/strict';
import { createSharedGpuExperienceVerifier, createSharedGpuExperiencePreflight } from '../client-runtime/application/shared-gpu-experience-verifier.mjs';
import { createRoundExperienceService } from '../client-runtime/application/round-experience-service.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { emptyExperienceStore } from '../client-runtime/experience-contract.mjs';

const digest = (char) => 'sha256:' + char.repeat(64);
{
  let current = digest('c'); let calls = 0;
  const preflight = createSharedGpuExperiencePreflight({ environmentId: 'local-shared-gpu',
    environmentResolver: { resolve: async (id, options) => { assert.deepEqual(options, { refresh: true }); calls++; return { id, digest: current }; } } });
  const input = { observation: { environmentDigest: digest('c') }, signal: new AbortController().signal };
  assert.equal((await preflight(input)).environmentDigest, digest('c'));
  current = digest('d');
  await assert.rejects(preflight(input), (error) => error.code === 'PACKAGE_ENVIRONMENT_CHANGED');
  const abort = new AbortController(); abort.abort(Error('cancelled preflight'));
  await assert.rejects(preflight({ ...input, signal: abort.signal }), /cancelled preflight/);
  assert.equal(calls, 2, 'an aborted preflight starts no environment query');
  const lateAbort = new AbortController();
  const slow = createSharedGpuExperiencePreflight({ environmentId: 'local-shared-gpu',
    environmentResolver: { resolve: async (id) => { lateAbort.abort(Error('late cancellation')); return { id, digest: digest('c') }; } } });
  await assert.rejects(slow({ ...input, signal: lateAbort.signal }), /late cancellation/);
  console.log('[shared-gpu-experience-preflight] identity drift and abort fail closed');
}
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
  executionPackageStore: { verifyAdmission: async (request) => { admissionCalls += 1; assert.equal(request.packageDigest, evidence.packageDigest); return { manifest: {}, environment: {}, admission: { preparedArtifactDigest: packageBinding.preparedArtifactDigest } }; } },
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

const queueVerifier = createSharedGpuExperienceVerifier({
  executionPackageStore: { verifyAdmission: async () => ({ manifest: {}, environment: {}, admission: { preparedArtifactDigest: packageBinding.preparedArtifactDigest } }) },
  packageAdapter: { verifyPreparedArtifact: async () => ({ valid: true }) },
  readTask: async (taskId) => ({ taskId, status: 'completed', resourceRelease: { confirmed: true }, result: { experienceEvidence: { ...evidence, patchDigest: `sha256:${'a'.repeat(64)}` } } }),
});
const queuedState = { ...state, benchmark: { ...state.benchmark, testTaskId: 'queue-01' } };
assert.equal((await queueVerifier({ state: queuedState, mission, observation: { evidence } })).verified, true, 'queue receipt may use prefixed digests');
const quarantined = createSharedGpuExperienceVerifier({
  executionPackageStore: { verifyAdmission: async () => ({ manifest: {}, environment: {}, admission: { preparedArtifactDigest: packageBinding.preparedArtifactDigest } }) },
  packageAdapter: { verifyPreparedArtifact: async () => ({ valid: true }) },
  readTask: async (taskId) => ({ taskId, status: 'completed', resourceRelease: { confirmed: false }, result: { experienceEvidence: evidence } }),
});
assert.equal((await quarantined({ state: queuedState, mission, observation: { evidence } })).code, 'EXECUTION_PACKAGE_QUEUE_NOT_TERMINAL');
// --- Real runner key order ---------------------------------------------------------------
// tools/local-shared-gpu-runner.py appends `architecture` after `liveHardware`, while
// production canonicalization (experience-contract normalizedEvidence) writes it after
// `hardware`. Equal values in those two orders must verify through the production
// round.record canonicalization and the trusted verifier; key order is not identity, but
// declared values, omitted fields, unknown extras and bindings still have to match exactly.
const archDigest = (char) => `sha256:${char.repeat(64)}`;
const runnerEvidence = {
  missionId: 'MIS_ARCH', candidateId: 'candidate-arch', runId: 'run-arch',
  patchDigest: archDigest('1'), packageDigest: archDigest('2'), environmentDigest: archDigest('3'), acceptanceDigest: archDigest('4'),
  hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'passed', operation: 'test', liveHardware: true,
  architecture: 'sm86', // appended last, exactly like the real runner receipt
};
const archPackageBinding = {
  packageDigest: runnerEvidence.packageDigest, admissionId: 'admission-arch', preparedArtifactDigest: archDigest('5'),
  environmentDigest: runnerEvidence.environmentDigest, acceptanceDigest: runnerEvidence.acceptanceDigest,
  workspaceId: 'MIS_ARCH', target: { platform: 'nvidia-cuda', device: 'gpu' }, build: {}, adapter: { id: 'python-shared-gpu', version: '1', languages: ['python'] },
};
const archMission = { id: 'MIS_ARCH', projectId: 'PROJ_ARCH', workspaceId: 'MIS_ARCH', hardware: ['nvidia-gpu'], tags: [] };
const archState = () => ({
  activeMissionId: 'MIS_ARCH',
  benchmark: {
    status: 'complete', purpose: 'candidate', testTaskId: 'queue-arch',
    candidate: { id: runnerEvidence.candidateId, digest: runnerEvidence.patchDigest },
    executionPackage: { ...archPackageBinding },
    result: { experienceEvidence: runnerEvidence },
  },
});
const archVerifier = ({ queueEvidence = runnerEvidence } = {}) => createSharedGpuExperienceVerifier({
  executionPackageStore: { verifyAdmission: async () => ({ manifest: {}, environment: {}, admission: { preparedArtifactDigest: archPackageBinding.preparedArtifactDigest } }) },
  packageAdapter: { verifyPreparedArtifact: async ({ preparedArtifactDigest }) => ({ valid: preparedArtifactDigest === archPackageBinding.preparedArtifactDigest }) },
  readTask: async (taskId) => ({ taskId, status: 'completed', resourceRelease: { confirmed: true }, result: { experienceEvidence: queueEvidence } }),
  now: () => 1_000,
});
let archStore = emptyExperienceStore();
let archIds = 0;
const archExperienceService = createExperienceService({
  repository: {
    read: async () => structuredClone(archStore),
    transact: (fn) => { const draft = structuredClone(archStore); const output = fn(draft); if (output.changed) { draft.revision += 1; archStore = draft; } return structuredClone(output.result); },
  },
  now: () => '2026-09-12T00:00:00.000Z',
  createId: () => `arch-experience-${++archIds}`,
});
const archResolveAccess = ({ mission }) => ({ projectId: mission.projectId, allowedProjectIds: [] });
const archTimers = { setTimeout, clearTimeout };
let observedCanonical = null;
const capturingVerifier = (args) => { observedCanonical = args.observation.evidence; return archVerifier()(args); };
const archService = createRoundExperienceService({
  experienceService: archExperienceService, resolveAccess: archResolveAccess,
  verifyObservationEvidence: capturingVerifier, timers: archTimers, timeoutMs: 500,
});
assert.equal(Object.keys(runnerEvidence).at(-1), 'architecture', 'the runner receipt keeps architecture at the tail');
const recorded = await archService.record({ state: archState(), mission: archMission, observation: { evidence: runnerEvidence, evidenceRefs: ['result.json'] } });
assert.equal(recorded.status, 'recorded', 'equal values in runner and canonical key order must record');
assert.equal(recorded.experience.verification.publishable, false);
assert.equal(observedCanonical.architecture, 'sm86');
assert.equal(Object.keys(observedCanonical).indexOf('architecture'), Object.keys(observedCanonical).indexOf('hardware') + 1, 'production canonicalization places architecture after hardware');
assert.notEqual(Object.keys(runnerEvidence).indexOf('architecture'), Object.keys(observedCanonical).indexOf('architecture'));
const archStoreRecord = archStore.records[0];
assert.equal(Object.keys(archStoreRecord.evidence).indexOf('architecture'), Object.keys(archStoreRecord.evidence).indexOf('hardware') + 1);

const trustedVerifier = archVerifier();
assert.equal((await trustedVerifier({ state: archState(), mission: archMission, observation: { evidence: observedCanonical } })).verified, true, 'tail-order persisted evidence equals canonical observation');
const canonicalizeOnly = async (raw) => {
  let captured = null;
  const probe = createRoundExperienceService({
    experienceService: archExperienceService, resolveAccess: archResolveAccess, timers: archTimers, timeoutMs: 500,
    verifyObservationEvidence: async ({ observation }) => { captured = observation.evidence; return { verified: false, code: 'PROBE_ONLY' }; },
  });
  await probe.record({ state: archState(), mission: archMission, observation: { evidence: raw } });
  return captured;
};
const withoutArchitecture = { ...runnerEvidence };
delete withoutArchitecture.architecture;
const canonicalWithoutArchitecture = await canonicalizeOnly(withoutArchitecture);

const conflictingState = archState();
conflictingState.benchmark.result.experienceEvidence = { ...runnerEvidence, architecture: 'sm100' };
assert.equal((await trustedVerifier({ state: conflictingState, mission: archMission, observation: { evidence: observedCanonical } })).code, 'EXECUTION_PACKAGE_EVIDENCE_MISMATCH', 'sm100 and sm86 are not equal');
assert.equal((await trustedVerifier({ state: archState(), mission: archMission, observation: { evidence: canonicalWithoutArchitecture } })).verified, false, 'a declared architecture cannot match an omitted one');
const omittedState = archState();
omittedState.benchmark.result.experienceEvidence = withoutArchitecture;
assert.equal((await trustedVerifier({ state: omittedState, mission: archMission, observation: { evidence: observedCanonical } })).verified, false, 'an omitted architecture cannot match a declared one');
const extraState = archState();
extraState.benchmark.result.experienceEvidence = { ...runnerEvidence, verified: true };
assert.equal((await trustedVerifier({ state: extraState, mission: archMission, observation: { evidence: observedCanonical } })).verified, false, 'unknown extra fields must fail closed');
assert.equal((await trustedVerifier({ state: archState(), mission: archMission, observation: { evidence: { ...observedCanonical, verified: true } } })).verified, false, 'unknown extra observation fields must fail closed');
const digestConflict = await canonicalizeOnly({ ...runnerEvidence, packageDigest: archDigest('9') });
assert.equal((await trustedVerifier({ state: archState(), mission: archMission, observation: { evidence: digestConflict } })).verified, false, 'key order does not relax digest values');
const bindingState = archState();
bindingState.benchmark.executionPackage.packageDigest = archDigest('9');
assert.equal((await trustedVerifier({ state: bindingState, mission: archMission, observation: { evidence: observedCanonical } })).code, 'EXECUTION_PACKAGE_BINDING_MISMATCH', 'a changed binding field still rejects');
assert.equal((await archVerifier({ queueEvidence: { ...runnerEvidence, architecture: 'sm100' } })({ state: archState(), mission: archMission, observation: { evidence: observedCanonical } })).code, 'EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH', 'a queue receipt with a different architecture rejects');
assert.equal(archStore.records.length, 1, 'rejected observations are not recorded');
console.log('[shared-gpu-experience-verifier] admission, artifact, candidate and worker-flag checks passed');
console.log('[shared-gpu-experience-verifier] real runner key order and fail-closed architecture checks passed');
