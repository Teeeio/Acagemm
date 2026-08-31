import assert from 'node:assert/strict';
import { createAgentRuntimeEngine } from '../client-runtime/agent-runtime/engine.mjs';
import { createRuntimeRegistry, inspectRuntimeCapabilities, productionWorkflowCapabilities, runtimeRegistry } from '../client-runtime/agent-runtime/registry.mjs';

assert.deepEqual(runtimeRegistry.list().map((runtime) => runtime.id), ['claude-code', 'codex-cli', 'opencode-server']);
assert.equal(runtimeRegistry.supports('claude-code', 'research'), true);
assert.equal(runtimeRegistry.supports('opencode-server', 'research'), false);
assert.equal(runtimeRegistry.require('codex-cli').eventParser, 'codex-jsonl');
assert.equal(inspectRuntimeCapabilities('claude-code').supported, true);
assert.equal(inspectRuntimeCapabilities('codex-cli').supported, true);
assert.deepEqual(inspectRuntimeCapabilities('opencode-server').missing, ['research', 'materializer', 'iteration', 'workspaceWrite']);
assert.deepEqual(inspectRuntimeCapabilities('missing-runtime').missing, [...productionWorkflowCapabilities]);

const calls = [];
const engine = createAgentRuntimeEngine({
  registry: runtimeRegistry,
  clients: {
    codex: { readRun: (runId) => { calls.push(runId); return { runId, status: 'completed' }; } },
    claude: {},
    opencode: { abort: (sessionId) => ({ sessionId, status: 'cancel_requested' }) },
  },
});
assert.deepEqual(engine.invoke('codex-cli', 'readRun', 'codex-1'), { runId: 'codex-1', status: 'completed' });
assert.deepEqual(engine.invoke('opencode-server', 'cancel', 'session-1'), { sessionId: 'session-1', status: 'cancel_requested' });
assert.deepEqual(calls, ['codex-1']);
assert.equal(engine.definition('claude-code').transport, 'stdio-jsonl');
assert.throws(() => engine.invoke('opencode-server', 'start', {}), (error) => error.code === 'AGENT_RUNTIME_OPERATION_UNSUPPORTED');
assert.throws(() => engine.invoke('claude-code', 'readRun', 'missing'), (error) => error.code === 'AGENT_RUNTIME_CLIENT_CONTRACT_INVALID');
assert.throws(() => createAgentRuntimeEngine({ clients: {} }).client('codex-cli'), (error) => error.code === 'AGENT_RUNTIME_CLIENT_UNAVAILABLE');
assert.throws(() => createRuntimeRegistry([runtimeRegistry.require('codex-cli'), runtimeRegistry.require('codex-cli')]), /Duplicate Agent Runtime/);
assert.throws(() => createRuntimeRegistry([{ id: 'invalid' }]), /missing label/);
assert.throws(() => createRuntimeRegistry([{
  id: 'broken-cli', label: 'Broken', clientKey: 'broken', transport: 'stdio-jsonl', eventParser: 'broken', usageSemantics: 'custom', operations: {}, capabilities: {},
}]), /missing stdio-jsonl operations/);
const mutableDefinition = {
  id: 'custom', label: 'Custom', clientKey: 'custom', transport: 'custom', eventParser: 'custom', usageSemantics: 'custom', operations: { start: 'go' }, capabilities: { iteration: true },
};
const immutableRegistry = createRuntimeRegistry([mutableDefinition]);
mutableDefinition.operations.start = 'changed';
mutableDefinition.capabilities.iteration = false;
assert.equal(immutableRegistry.require('custom').operations.start, 'go');
assert.equal(immutableRegistry.supports('custom', 'iteration'), true);

console.log('[agent-runtime-registry] declarative definitions, capabilities and operation dispatch passed');
