import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendRuntimeEvent, createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-runtime-'));

try {
  const demoRuntime = createAgentRuntime({ mode: 'reference-fixture' });
  const demoDescriptor = await demoRuntime.describe();
  assert.equal(demoDescriptor.mode, 'reference-fixture');
  assert.equal(demoDescriptor.connected, true);

  const unavailableRuntime = createAgentRuntime({ mode: 'unavailable' });
  const unavailableDescriptor = await unavailableRuntime.describe();
  assert.equal(unavailableDescriptor.connected, false);
  assert.equal(unavailableDescriptor.capabilities.length, 0);
  await assert.rejects(
    unavailableRuntime.startRun({ state: {}, mission: { id: 'MIS_NONE' }, goal: 'must not fabricate a run' }),
    (error) => error.code === 'AGENT_RUNTIME_UNAVAILABLE' && error.status === 503,
  );

  const cliRoot = path.join(root, 'cli');
  const bridgeDir = path.join(root, 'bridge');
  await mkdir(path.join(cliRoot, 'results'), { recursive: true });
  await mkdir(path.join(cliRoot, 'docs'), { recursive: true });
  await writeFile(path.join(cliRoot, 'results', 'agent_status_cli_integration.json'), '{"status":"running","events":[]}\n');
  await writeFile(path.join(cliRoot, 'results', 'test_queue.jsonl'), '');
  await writeFile(path.join(cliRoot, 'docs', 'optimization_records.json'), '{"20003":{"current_best":"T116"}}\n');

  const cliRuntime = createAgentRuntime({ mode: 'cli-file', cliRoot, bridgeDir });
  const cliDescriptor = await cliRuntime.describe();
  assert.equal(cliDescriptor.connected, true);
  assert.equal(cliDescriptor.liveHardware, false);
  assert.equal(cliDescriptor.actionBridge, 'mission-request-only');
  assert.deepEqual(cliDescriptor.capabilities, ['mission.request', 'agent.status', 'queue.probe', 'canonical.probe']);

  const state = { activeMissionId: 'MIS_TEST', runtimeEvents: [] };
  const mission = { id: 'MIS_TEST', title: 'Runtime Test', goal: 'Validate the CLI bridge', repository: 'fixture-repo', hardware: ['C500'], metric: 'latency p50' };
  const started = await cliRuntime.startRun({ state, mission, goal: mission.goal });
  assert.equal(started.handled, true);
  assert.equal(state.agent.phase, '等待 CLI 接管');
  assert.equal(state.runtimeEvents[0].sequence, 1);
  const request = JSON.parse(await readFile(path.join(bridgeDir, 'requests', `${state.agent.runId}.json`), 'utf8'));
  assert.equal(request.missionId, mission.id);

  appendRuntimeEvent(state, 'tool.completed', { tool: 'fixture' });
  assert.equal(state.runtimeEvents[1].sequence, 2);
  state.agent.phase = 'stale local phase';
  const projection = await cliRuntime.projectState(state);
  assert.equal(projection.state.runtime.mode, 'cli-file');
  assert.equal(projection.state.agent.phase, 'stale local phase');
  await writeFile(path.join(cliRoot, 'results', 'agent_status_cli_integration.json'), JSON.stringify({ status: 'running', requestId: state.agent.runId, missionId: state.activeMissionId, phase: 'CLI queue', progress: 20, events: [] }));
  const correlatedProjection = await cliRuntime.projectState(state);
  assert.equal(correlatedProjection.state.agent.phase, 'CLI queue');
  await writeFile(path.join(cliRoot, 'results', 'agent_status_cli_integration.json'), '{"status":"unknown"}\n');
  const invalidStatusDescriptor = await cliRuntime.describe();
  assert.equal(invalidStatusDescriptor.connected, false);
  assert.equal(invalidStatusDescriptor.probes.agentStatus, false);
  await writeFile(path.join(cliRoot, 'results', 'agent_status_cli_integration.json'), '{"status":"running","events":[]}\n');
  await writeFile(path.join(cliRoot, 'docs', 'optimization_records.json'), '{}\n');
  const emptyCanonicalDescriptor = await cliRuntime.describe();
  assert.equal(emptyCanonicalDescriptor.connected, false);
  assert.equal(emptyCanonicalDescriptor.probes.canonicalRecords, false);
  console.log('[runtime] adapter contract passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
