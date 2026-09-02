import assert from 'node:assert/strict';
import { selectAutopilotCandidate } from '../client-runtime/application/autopilot-candidate-service.mjs';
assert.equal(selectAutopilotCandidate({ candidateEvaluations: [{ id: 'first' }, { id: 'eligible', classification: 'eligible' }, { id: 'patched', patchDigest: 'd' }] }).id, 'patched');
assert.equal(selectAutopilotCandidate({ candidateEvaluations: [{ id: 'eligible', classification: 'eligible' }] }).id, 'eligible');
assert.equal(selectAutopilotCandidate({ candidateEvaluations: [] }), null);
console.log('[autopilot-candidate-service] priority selection contract passed');
