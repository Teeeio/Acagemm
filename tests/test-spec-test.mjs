import assert from 'node:assert/strict';
import { validateBaselineRunPy } from '../client-runtime/baseline-materializer.mjs';
import { createMissionTestSpec, normalizeMissionTestMatrix, testSpecAgentInstruction } from '../client-runtime/test-spec.mjs';

const spec = createMissionTestSpec({ correctnessCases: 12, warmup: 7, repeats: 31 });
assert.equal(spec.correctness.requestedCases, 12);
assert.deepEqual(spec.correctness.requiredCategories, ['minimal', 'representative', 'boundary', 'ragged']);
assert.deepEqual(spec.benchmark.requiredProfiles, ['primary', 'small', 'boundary']);

const matrix = normalizeMissionTestMatrix({ environments: ['C500'], correctnessCases: 12, warmup: 7, repeats: 31 });
assert.equal(matrix.testSpec.schemaVersion, 'operator-studio.test-spec/v1');
assert.equal(matrix.correctnessCases, 12);
assert.match(testSpecAgentInstruction(matrix), /exactly 12 named cases/);

const legacyRunPy = 'def get_inputs(): pass\ndef run(inputs): pass\ndef reference(inputs): pass\n';
assert.equal(validateBaselineRunPy(legacyRunPy).ok, true);
const strictValidation = validateBaselineRunPy(legacyRunPy, { requireGeneratedTests: true });
assert.equal(strictValidation.ok, false);
assert.deepEqual(strictValidation.missing, ['get_test_cases', 'get_benchmark_inputs']);
const generatedRunPy = `${legacyRunPy}def get_test_cases(): pass\ndef get_benchmark_inputs(): pass\n`;
assert.equal(validateBaselineRunPy(generatedRunPy, { requireGeneratedTests: true }).ok, true);

console.log('[test-spec] generated matrix and executable contract passed');
