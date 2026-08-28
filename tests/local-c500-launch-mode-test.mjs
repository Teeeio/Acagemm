import assert from 'node:assert/strict';
import { resolveAgentRuntimeMode, resolveLocalC500LaunchMode, resolveMuxiDevice } from '../tools/local-c500-tester/production-api.mjs';
import { isCurrentLocalC500Runtime, LOCAL_C500_RUNTIME_CONTRACT_VERSION } from '../client-runtime/local-c500-runtime-contract.mjs';

assert.equal(resolveAgentRuntimeMode({}), 'claude-code');
assert.equal(resolveAgentRuntimeMode({ OPERATOR_RUNTIME_MODE: 'codex-cli' }), 'codex-cli');
assert.equal(resolveMuxiDevice({}, () => ({ status: 1, stdout: '', stderr: '' })), 'C550');
assert.equal(resolveMuxiDevice({ OPERATOR_MUXI_DEVICE: 'C550' }), 'C550');

assert.deepEqual(resolveLocalC500LaunchMode({}), {
  mock: false,
  scenario: null,
  label: 'real C550 hardware',
});
assert.deepEqual(resolveLocalC500LaunchMode({
  OPERATOR_LOCAL_C500_MOCK: '1',
}), {
  mock: true,
  scenario: 'mla-three-round',
  label: 'simulation',
});
assert.equal(resolveLocalC500LaunchMode({ OPERATOR_MUXI_DEVICE: 'C550' }).label, 'real C550 hardware');
assert.deepEqual(resolveLocalC500LaunchMode({
  OPERATOR_LOCAL_C500_MOCK: '1',
  OPERATOR_LOCAL_C500_MOCK_SCENARIO: 'custom-scenario',
}), {
  mock: true,
  scenario: 'custom-scenario',
  label: 'simulation',
});
assert.equal(resolveLocalC500LaunchMode({ OPERATOR_LOCAL_C500_MOCK: '0' }).mock, false);
assert.equal(isCurrentLocalC500Runtime({ service: 'operator-studio-client-runtime', __bridge: { runtimeContractVersion: LOCAL_C500_RUNTIME_CONTRACT_VERSION } }), true);
assert.equal(isCurrentLocalC500Runtime({ service: 'operator-studio-client-runtime', __bridge: { runtimeContractVersion: LOCAL_C500_RUNTIME_CONTRACT_VERSION - 1 } }), false);
assert.equal(isCurrentLocalC500Runtime({ service: 'operator-studio-client-runtime', __bridge: {} }), false);
assert.equal(isCurrentLocalC500Runtime({ service: 'another-service', __bridge: { runtimeContractVersion: LOCAL_C500_RUNTIME_CONTRACT_VERSION } }), false);

console.log('[local-c500-launch-mode] real hardware default and explicit simulation passed');
