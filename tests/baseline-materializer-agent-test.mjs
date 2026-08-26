import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { parseBaselineMaterializerResult } from '../client-runtime/agent-result.mjs';
import { resolveBaselineRunPlan } from '../client-runtime/baseline-resolver.mjs';

const runPy = [
  'def get_inputs():',
  '    import torch',
  '    if not torch.cuda.is_available():',
  '        raise RuntimeError("cuda unavailable")',
  '    return {"x": torch.ones((4,), device="cuda")}',
  '',
  'def run(inputs):',
  '    return inputs["x"] + 1',
  '',
  'def reference(inputs):',
  '    return inputs["x"] + 1',
  '',
].join('\n');

const parsed = parseBaselineMaterializerResult([{
  type: 'item.completed',
  item: { type: 'agent_message', text: JSON.stringify({ schemaVersion: 'operator-studio.baseline-materializer-result/v1', summary: 'ok', runPy, report: { summary: 'materialized' } }) },
}]);
assert.equal(parsed.format, 'structured-json');
assert.equal(parsed.runPy, runPy);
assert.equal(parsed.report.summary, 'materialized');

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-baseline-materializer-'));
const sourceRoot = path.join(root, 'sources');
const materializationDir = path.join(root, 'artifacts', 'baseline-materialization');
const source = {
  authority: 'upstream',
  repository: 'https://github.com/flashinfer-ai/flashinfer.git',
  commit: 'ee3fda10',
  path: 'flashinfer/decode.py',
  operator: 'paged_attention',
  expandedSingleFile: false,
};
const matrix = { environments: ['gpu-iluvatar-mainstream'], stages: ['correctness', 'benchmark'], shape: { batch: 1, num_heads: 2, seq_len: 16, head_dim: 32 } };
const mission = { id: 'MIS_MAT_AGENT', title: 'FlashInfer paged_attention', operator: 'paged_attention', hardware: ['gpu-iluvatar-mainstream'], metric: 'latency_p50', sourceRoot };
const execFileAsync = promisify(execFile);
let startArgs = null;
let cancelCalled = false;
const codexClient = {
  describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli test' }),
  start: async (args) => {
    startArgs = args;
    return { runId: args.runId, startedAt: new Date().toISOString(), threadId: 'thread-materializer' };
  },
  readRun: async () => ({ runId: startArgs.runId, status: 'completed', completedAt: new Date().toISOString(), threadId: 'thread-materializer' }),
  readEvents: async () => [
    { type: 'thread.started', thread_id: 'thread-materializer' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ schemaVersion: 'operator-studio.baseline-materializer-result/v1', summary: 'materialized baseline', runPy, report: { summary: 'expanded from upstream', sourceFiles: ['flashinfer/decode.py'], assumptions: ['torch eager semantic reference'] } }) } },
    { type: 'turn.completed' },
  ],
  eventText: (event) => event.item?.text || '',
  cancel: async () => { cancelCalled = true; return { status: 'cancel_requested' }; },
};

try {
  const sourceRepository = path.join(sourceRoot, 'flashinfer');
  await mkdir(path.join(sourceRepository, 'flashinfer'), { recursive: true });
  await writeFile(path.join(sourceRepository, 'flashinfer', 'decode.py'), 'def paged_attention_reference(x):\n    return x\n', 'utf8');
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['add', '-A'],
    ['commit', '-m', 'fixture'],
    ['remote', 'add', 'origin', source.repository],
  ]) await execFileAsync('git', args, { cwd: sourceRepository, windowsHide: true });
  source.commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepository, windowsHide: true })).stdout.trim();
  const runtime = createAgentRuntime({ mode: 'codex-cli', codexClient, codexWorkspace: root });
  const state = {
    activeMissionId: mission.id,
    runtimeEvents: [],
    missions: [mission],
    agent: { status: 'idle' },
    baseline: { required: true, status: 'missing', kind: 'pytorch_reference', sourcePolicy: { requireAuthority: true, requireSingleFileExpansion: true } },
    testMatrix: matrix,
  };

  const started = await runtime.startBaselineMaterialization({ state, mission, source, matrix, workspace: materializationDir });
  assert.equal(started.state.baseline.materializer.status, 'running');
  assert.match(started.state.baseline.materializer.runId, /^codex_materializer_[A-Z0-9]+_[A-Z0-9]+$/);
  assert.equal(startArgs.workspace, materializationDir);
  assert.deepEqual(startArgs.additionalDirectories, []);
  assert.deepEqual(JSON.parse(startArgs.environment.OPERATOR_AGENT_ROOTS), { workspace: path.resolve(materializationDir) });
  assert.equal(startArgs.sandboxMode, 'workspace-write');
  assert.match(startArgs.goal, /Do NOT submit tests/);
  assert.match(startArgs.goal, /must not import flashinfer/i);
  assert.match(startArgs.goal, /baseline-materializer-result\/v1/);
  assert.match(startArgs.goal, /paged_attention_reference/);

  const projected = await runtime.projectState(state);
  assert.equal(projected.state.baseline.materializer.status, 'completed');
  assert.equal(projected.state.baseline.materializer.result.runPy, runPy);
  assert.equal(projected.state.baseline.materializer.result.source.expandedSingleFile, true);
  assert.equal(projected.state.baseline.resolution.status, 'materialized');
  assert.ok(projected.state.runtimeEvents.some((event) => event.type === 'baseline.materializer_completed'));

  const plan = await resolveBaselineRunPlan({ state: projected.state, mission, body: { purpose: 'baseline' }, matrix });
  assert.equal(plan.runPy, runPy);
  assert.equal(plan.runPySource, 'agent_assisted');
  assert.equal(plan.baselineSource.expandedSingleFile, true);

  const cancelState = {
    activeMissionId: mission.id,
    runtimeEvents: [],
    baseline: { materializer: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_materializer_CANCEL' } },
    agent: { status: 'idle' },
  };
  const cancelled = await runtime.cancelRun({ state: cancelState, runId: 'codex_materializer_CANCEL' });
  assert.equal(cancelled.state.baseline.materializer.status, 'cancel_requested');
  assert.equal(cancelCalled, true);

  console.log('[baseline-materializer-agent] lifecycle passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
