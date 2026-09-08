import assert from 'node:assert/strict';
import { genericMissionSpecExample, normalizeGenericMissionSpecification } from '../tools/local-c500-tester/mission-spec.mjs';

const valid = structuredClone(genericMissionSpecExample);
valid.repository = 'F:/operators/custom';
const normalized = normalizeGenericMissionSpecification(valid);
assert.equal(normalized.schemaVersion, 'operator-studio.generic-mission/v1');
assert.equal(normalized.implementation.language, 'python');
assert.equal(normalized.sourceFiles[0].role, 'entrypoint');
assert.equal(normalized.testMatrix.testSpec.schemaVersion, 'operator-studio.test-spec/v1');
assert.equal(normalized.start, false);

for (const [name, mutate] of [
  ['missing schema', (item) => { delete item.schemaVersion; }],
  ['missing test spec', (item) => { delete item.testMatrix.testSpec; }],
  ['path escape', (item) => { item.sourceFiles[0].path = '../run.py'; }],
  ['missing entrypoint', (item) => { item.sourceFiles = [{ path: 'oracle.py', role: 'oracle' }]; }],
]) {
  const candidate = structuredClone(valid);
  mutate(candidate);
  assert.throws(() => normalizeGenericMissionSpecification(candidate), { code: 'GENERIC_MISSION_SPEC_INVALID' }, name);
}

console.log('generic mission import contract passed');
