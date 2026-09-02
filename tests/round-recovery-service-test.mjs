import assert from 'node:assert/strict';
import { createRoundRecoveryService } from '../client-runtime/application/round-recovery-service.mjs';

const checkpoint = { id: 'cp1', stableDigest: 'd1' };
const service = createRoundRecoveryService({ isManagedWorkspaceRuntimeMode: (mode) => mode === 'managed', restoreWorkspaceCheckpoint: async () => ({ restoredAt: 'now' }), captureDiff: async () => ({ digest: 'd1' }) });
const state = { activeMissionId: 'm1', workflowRecovery: { checkpoints: [checkpoint] }, decisionReview: { gate: { passed: false }, candidateId: 'c1' }, benchmark: { candidate: { digest: 'x' } } };
assert.deepEqual(await service.restoreRejectedRound({ state, workspace: '/w', runtimeMode: 'managed' }), { checkpointId: 'cp1', candidateId: 'c1', candidateDigest: 'x', workspaceClean: true, restoredAt: 'now' });
assert.equal(await service.restoreRejectedRound({ state, workspace: '/w', runtimeMode: 'reference-fixture' }), null);
console.log('[round-recovery-service] restore guard and unmanaged no-op contracts passed');
