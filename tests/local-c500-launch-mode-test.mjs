import assert from 'node:assert/strict';
import { resolveAgentRuntimeMode, resolveLocalC500LaunchMode } from '../tools/local-c500-tester/production-api.mjs';
import { isCurrentLocalC500Runtime, LOCAL_C500_RUNTIME_CONTRACT_VERSION } from '../client-runtime/local-c500-runtime-contract.mjs';

assert.equal(resolveAgentRuntimeMode({}), 'claude-code');
assert.equal(resolveAgentRuntimeMode({ OPERATOR_RUNTIME_MODE: 'codex-cli' }), 'codex-cli');

assert.deepEqual(resolveLocalC500LaunchMode({}), {
  mock: false,
  scenario: null,
  label: 'real C500 hardware',
});
assert.deepEqual(resolveLocalC500LaunchMode({
  OPERATOR_LOCAL_C500_MOCK: '1',
}), {
  mock: true,
  scenario: 'mla-three-round',
  label: 'simulation',
});
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
assert.equal(isCurrentLocalC500Runtime({ service: 'operator-studio-client-runtime', __bridge: {} }), false);
assert.equal(isCurrentLocalC500Runtime({ service: 'another-service', __bridge: { runtimeContractVersion: LOCAL_C500_RUNTIME_CONTRACT_VERSION } }), false);

console.log('[local-c500-launch-mode] real hardware default and explicit simulation passed');
