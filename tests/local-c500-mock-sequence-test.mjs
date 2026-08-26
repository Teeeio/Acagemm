import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'local-c500-mock-sequence-'));
process.env.OPERATOR_RUNTIME_DIR = tempRoot;
process.env.OPERATOR_LOCAL_C500_DIR = path.join(tempRoot, 'tasks');
process.env.OPERATOR_LOCAL_C500_MOCK = '1';
process.env.OPERATOR_LOCAL_C500_MOCK_SCENARIO = 'mla-three-round';

const { createLocalC500ServiceClient } = await import('../client-runtime/local-c500-service-client.mjs');

const runPy = (round) => [
  `# FlashInfer MLA paged attention round ${round}`,
  'def get_inputs():',
  `    return {"round": ${round}, "page_size": 16, "kv_indices": [0]}`,
  '',
  'def run(inputs):',
  `    return ("mla_paged_attention", inputs["round"], ${round})`,
  '',
  'def reference(inputs):',
  '    return ("mla_paged_attention", inputs["round"], inputs["round"])',
  '',
].join('\n');

const materializedBaselineRunPy = [
  '# MLA semantic reference selected from verified upstream provenance',
  'def get_inputs():',
  '    return {"page_size": 16, "kv_indices": [0]}',
  '',
  'def run(inputs):',
  '    return (inputs["page_size"], inputs["kv_indices"])',
  '',
  'def reference(inputs):',
  '    return (inputs["page_size"], inputs["kv_indices"])',
  '',
].join('\n');

const digest = (character) => `sha256:${character.repeat(64)}`;
const basePayload = {
  schemaVersion: 1,
  missionId: 'MIS_MLA_SEQUENCE',
  operator: 'flashinfer_mla_paged_attention',
  hardware: ['C500'],
  metric: 'latency_p50',
  matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'], repeats: 3, warmup: 1, correctnessCases: 1 },
};

const execute = async (client, payload) => {
  const submitted = await client.submit(payload);
  return client.get(submitted.taskId);
};

try {
  const client = createLocalC500ServiceClient();
  const baseline = await execute(client, { ...basePayload, purpose: 'baseline', candidate: { id: 'baseline', digest: 'sha256:baseline-agent' }, baselineSource: { operator: 'flashinfer.mla.BatchMLAPagedAttentionWrapper' }, runPy: materializedBaselineRunPy });
  const first = await execute(client, { ...basePayload, purpose: 'candidate', candidate: { id: 'candidate-01', digest: digest('1') }, runPy: runPy(1) });
  const retry = await execute(client, { ...basePayload, purpose: 'candidate', candidate: { id: 'candidate-01-retry', digest: digest('1') }, runPy: runPy(1) });
  const second = await execute(client, { ...basePayload, purpose: 'candidate', candidate: { id: 'candidate-02', digest: digest('2') }, runPy: runPy(2) });
  const third = await execute(client, { ...basePayload, purpose: 'candidate', candidate: { id: 'candidate-03', digest: digest('3') }, runPy: runPy(3) });

  assert.deepEqual([baseline, first, retry, second, third].map((task) => task.status), ['completed', 'completed', 'completed', 'completed', 'completed']);
  assert.deepEqual([baseline, first, retry, second, third].map((task) => task.result.benchmark[0].value), [100, 92, 92, 84, 75]);
  assert.equal(third.result.environment.source, 'simulation');
  assert.equal(third.result.environment.liveHardware, false);
  assert.equal(third.result.tracer.simulated, true);
  assert.equal(third.result.profiler.simulated, true);

  const fourth = await execute(client, { ...basePayload, purpose: 'candidate', candidate: { id: 'candidate-04', digest: digest('4') }, runPy: runPy(4) });
  assert.equal(fourth.status, 'failed');
  assert.equal(fourth.error.code, 'LOCAL_C500_SCENARIO_SEQUENCE_EXHAUSTED');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write('[local-c500-mock-sequence] persistent 100/92/84/75 sequence passed\n');
