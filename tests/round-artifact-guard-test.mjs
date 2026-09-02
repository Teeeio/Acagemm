import assert from 'node:assert/strict';
import { createRoundArtifactGuard } from '../client-runtime/application/round-artifact-guard.mjs';

const guard = createRoundArtifactGuard({ isStrictZeroSourceMission: (mission) => mission.strict === true });
assert.equal(guard.assertReady({ mission: {}, state: {} }), true);
assert.equal(guard.assertReady({ mission: { strict: true }, state: { baseline: { materializer: { result: { runPy: 'run.py' } } } } }), true);
assert.throws(() => guard.assertReady({ mission: { strict: true }, state: {} }), (error) => error.code === 'ITERATION_BASELINE_ARTIFACT_MISSING' && error.status === 409);
console.log('[round-artifact-guard] strict artifact contract passed');
