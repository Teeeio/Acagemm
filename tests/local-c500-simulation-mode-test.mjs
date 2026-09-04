import assert from 'node:assert/strict';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

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
assert.equal(resolveMuxiDevice(simulationEnv, () => { throw new Error('hardware probe must not run'); }), 'C550');

const runtime = createAgentRuntime({ mode: 'reference-fixture' });
const descriptor = await runtime.describe();
assert.equal(descriptor.mode, 'reference-fixture');
assert.equal(descriptor.connected, true);
assert.equal(descriptor.liveHardware, false);
assert.equal(descriptor.authority, 'test-fixture-only');
console.log('[local-c500-simulation] reference Agent and production launch mode are isolated from model/hardware probes');
