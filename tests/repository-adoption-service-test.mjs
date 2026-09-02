import assert from 'node:assert/strict';
import { createRepositoryAdoptionService } from '../client-runtime/application/repository-adoption-service.mjs';
const state = { activeMissionId: 'm', missions: [{ id: 'm', projectRoot: '/p', repository: 'repo' }], agent: { runtimeKind: 'managed' }, stage: 'evidence', benchmark: { status: 'complete' }, decisionReview: { status: 'auto_ready', gate: { passed: true } }, appliedCandidateId: 'c', candidateEvaluations: [{ id: 'c', artifacts: { patch: '/a' } }] };
const service = createRepositoryAdoptionService({ isManagedWorkspaceRuntimeMode: () => true, adoptPatch: async () => ({ commit: 'abc' }), runAutomaticAdoption: () => {}, runKnowledgeMaintenance: () => {}, appendRuntimeEvent: () => {} });
assert.equal((await service.adopt({ state })).changed, true);
assert.equal(state.workflowRecovery.repositoryAdoption.commit, 'abc');
console.log('[repository-adoption-service] eligibility and adoption contract passed');
