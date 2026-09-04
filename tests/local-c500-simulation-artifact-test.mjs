import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'local-c500-simulation-artifact-'));
process.env.OPERATOR_STORAGE_ROOT = storageRoot;
process.env.OPERATOR_DATA_DIR = path.join(storageRoot, 'data');
process.env.OPERATOR_RUNTIME_DIR = path.join(storageRoot, 'runtime');
process.env.OPERATOR_LOCAL_C500_SIMULATION = '1';
process.env.OPERATOR_LOCAL_C500_MOCK = '1';
process.env.OPERATOR_LOCAL_C500_MOCK_SCENARIO = 'mla-three-round';
process.env.OPERATOR_TEST_BACKEND = 'local-c500';

try {
  const { applyCandidatePatch, workspaceDirForMission } = await import('../client-runtime/state-store.mjs');
  const { createLocalC500ServiceClient } = await import('../client-runtime/local-c500-service-client.mjs');
  const missionId = 'MIS_SIM_ARTIFACT';
  await applyCandidatePatch(missionId, 'candidate-02');
  const workspace = workspaceDirForMission(missionId);
  const runPy = await readFile(path.join(workspace, 'run.py'), 'utf8');
  assert.match(runPy, /operatorIdentity\s*=\s*['"]mla_paged_attention['"]/);
  assert.match(runPy, /page_size/);
  assert.match(runPy, /page_ids/);
  assert.match(runPy, /kv_indices/);
  assert.match(runPy, /block_tables/);

  const adapter = createLocalC500ServiceClient();
  const submitted = await adapter.submit({
    missionId,
    purpose: 'candidate',
    operator: 'mla_paged_attention',
    candidate: { id: 'candidate-02', digest: `sha256:${'a'.repeat(64)}` },
    runPy,
    baselineSource: { profileId: 'profile.mla-paged-attention', operator: 'mla_paged_attention' },
    matrix: { environments: ['C550'], stages: ['Correctness', 'Full Benchmark'], shapeKey: 'simulation-shape', correctnessCases: 24, repeats: 10 },
  });
  const task = await adapter.get(submitted.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.result.environment.source, 'simulation');
} finally {
  await rm(storageRoot, { recursive: true, force: true });
}

console.log('[local-c500-simulation-artifact] generated bridge satisfies scripted operator identity contract');
