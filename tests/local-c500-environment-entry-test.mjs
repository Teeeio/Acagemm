import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../scripts/c500-test.sh', import.meta.url), 'utf8');

assert.match(script, /OPERATOR_RUNTIME_MODE=.*claude-code/);
assert.match(script, /OPERATOR_TEST_BACKEND=.*local-c500/);
assert.match(script, /TESTER_HOME=.*PROJECT_ROOT.*local-c500-production/);
assert.match(script, /install-bundled-node\.sh/);
assert.match(script, /with-bundled-node\.sh/);
assert.match(script, /BUNDLED_NODE=/);
assert.match(script, /BUNDLED_NODE.*--input-type=module/);
assert.match(script, /verify\|doctor\|start\|mock\|simulation\|stop/);
assert.match(script, /operator-studio-client-runtime/);
assert.match(script, /bridge\.port/);
assert.match(script, /kill \"\$pid\"/);
assert.match(script, /unset OPERATOR_LOCAL_C500_MOCK OPERATOR_LOCAL_C500_MOCK_SCENARIO/);
assert.match(script, /OPERATOR_LOCAL_C500_SIMULATION OPERATOR_SIMULATION/);
assert.match(script, /OPERATOR_HARDWARE_DISABLED OPERATOR_MUXI_DEVICE/);
assert.doesNotMatch(script, /rm\s+-rf/);

console.log('[local-c500-environment-entry] relocatable bootstrap and scoped runtime replacement passed');
