import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { createLocalC500Adapter } from '../tools/local-c500-tester/local-c500-adapter.mjs';

const simulationEnv = {
  OPERATOR_LOCAL_C500_SIMULATION: '1',
  OPERATOR_LOCAL_C500_MOCK: '1',
  OPERATOR_RUNTIME_MODE: 'claude-code',
};
process.env.OPERATOR_LOCAL_C500_SIMULATION = '1';
process.env.OPERATOR_LOCAL_C500_MOCK = '1';
process.env.OPERATOR_RUNTIME_MODE = 'reference-fixture';
const { resolveAgentRuntimeMode, resolveLocalC500LaunchMode, resolveMuxiDevice } = await import('../tools/local-c500-tester/production-api.mjs');
assert.equal(resolveAgentRuntimeMode(simulationEnv), 'reference-fixture');
assert.deepEqual(resolveLocalC500LaunchMode(simulationEnv), {
  id: 'full-simulation',
  simulation: true,
  mock: true,
  hardwareMock: false,
  liveHardware: false,
  scenario: 'mla-three-round',
  label: 'full simulation',
});
assert.equal(resolveMuxiDevice(simulationEnv, () => { throw new Error('hardware probe must not run'); }), 'C500');

const runtime = createAgentRuntime({ mode: 'reference-fixture' });
const descriptor = await runtime.describe();
assert.equal(descriptor.mode, 'reference-fixture');
assert.equal(descriptor.connected, true);
assert.equal(descriptor.liveHardware, false);
assert.equal(descriptor.authority, 'test-fixture-only');
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-simulation-unit-'));
try {
  await mkdir(tempDir, { recursive: true });
  const adapter = createLocalC500Adapter({ missionDir: tempDir, mock: true, environment: { checks: { c500: { status: 'simulated' } } } });
  const submitted = await adapter.submitTest({
    purpose: 'candidate',
    candidateArtifact: { digest: 'sha256:simulation-candidate', path: tempDir },
    stages: ['Correctness', 'Full Benchmark'],
    matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'], shapeKey: 'simulation-shape', correctnessCases: 24, repeats: 10 },
  });
  const task = await adapter.pollTest(submitted.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.result.environment.source, 'simulation');
  assert.equal(task.result.environment.liveHardware, false);
  assert.equal(task.result.tracer.status, 'generated');
  assert.equal(task.result.profiler.status, 'generated');
  assert.equal(task.result.correctness, 'pass');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('[local-c500-simulation] reference Agent and local benchmark simulation are isolated from model/hardware probes');
