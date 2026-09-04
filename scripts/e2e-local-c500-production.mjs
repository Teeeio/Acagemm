import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number(process.argv[2] || process.env.API_PORT || 4294);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (pathname, options = {}) => {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${payload.code || response.status}: ${payload.error || response.statusText}`);
    error.payload = payload;
    throw error;
  }
  return payload;
};

const pollState = async (predicate, label, timeoutMs = 5 * 60 * 1000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await request('/api/state')).state;
    if (predicate(last)) return last;
    await sleep(1000);
  }
  throw new Error(`${label} timed out: ${JSON.stringify({ stage: last?.stage, agent: last?.agent?.status, phase: last?.agent?.phase, benchmark: last?.benchmark?.status, candidates: last?.candidateEvaluations?.length })}`);
};

const baselineRunPy = [
  'def get_inputs():',
  '    import torch',
  '    if not torch.cuda.is_available():',
  '        raise RuntimeError("accelerator required")',
  '    device = torch.device("cuda")',
  '    return {',
  '        "left": torch.arange(4096, device=device, dtype=torch.float32),',
  '        "right": torch.ones(4096, device=device, dtype=torch.float32),',
  '    }',
  '',
  'def run(inputs):',
  '    return inputs["left"] + inputs["right"]',
  '',
  'def reference(inputs):',
  '    return inputs["left"] + inputs["right"]',
  '',
].join('\n');

const matrix = {
  environments: ['C550'],
  stages: ['Correctness', 'Full Benchmark'],
  warmup: 1,
  repeats: 2,
  correctnessCases: 1,
};

const main = async () => {
  const health = await request('/api/health');
  assert.equal(health.runtime.mode, 'codex-cli');
  assert.equal(health.testBackend.enabled, true);
  assert.equal(health.testBackend.mock, true);

  const root = await mkdtemp(path.join(os.tmpdir(), 'operator-production-c500-e2e-'));
  const projectResponse = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'production-local-c500-e2e', root, initializeGit: true }),
  });
  const project = projectResponse.project;
  await writeFile(path.join(project.repository, 'run.py'), baselineRunPy, 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: project.repository });
  await execFileAsync('git', ['commit', '-m', 'vector add production baseline'], { cwd: project.repository });

  const goal = '优化 run.py 中 vector_add 在沐曦 C550 上的 latency p50，目标低于 100 us；保持 get_inputs、run、reference 契约并通过 correctness 1/1 和生产 Accept Gate。必须在隔离 Mission 工作区修改 run.py 生成一个有界的真实代码候选，不要只返回分析。';
  const missionResponse = await request('/api/missions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Local C550 generated vector_add',
      goal,
      projectId: project.id,
      hardware: ['C550'],
      metric: 'latency p50',
      testMatrix: matrix,
      missionBudgetMs: 10 * 60 * 1000,
    }),
  });
  const missionId = missionResponse.state.activeMissionId;

  await request('/api/actions/start-benchmark', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'baseline',
      baselineKind: 'naive_v0',
      baselineSource: {
        authority: 'generated',
        kind: 'naive_v0',
        type: 'naive_v0',
        repository: 'mission-workspace',
        commit: 'v0',
        path: 'run.py',
        operator: 'vector_add',
        expandedSingleFile: true,
        basedOn: 'v0',
      },
      operator: 'vector_add',
      matrix,
      timeoutSeconds: 30,
    }),
  });
  const baselineState = await pollState(
    (state) => state.activeMissionId === missionId && state.baseline?.status === 'complete' && state.benchmark?.status === 'idle',
    'baseline',
  );
  assert.equal(baselineState.baseline.evidence.liveHardware, false);

  await request(`/api/missions/${encodeURIComponent(missionId)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ goal }),
  });
  const candidateState = await pollState(
    (state) => state.activeMissionId === missionId
      && state.stage === 'candidate'
      && state.agent?.status === 'awaiting_action'
      && state.candidateEvaluations?.some((candidate) => candidate.patchDigest),
    'Codex candidate',
    Number(process.env.E2E_CODEX_TIMEOUT_MS || 10 * 60 * 1000),
  );
  const candidate = candidateState.candidateEvaluations.find((item) => item.patchDigest);
  assert.match(candidate.patchDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(candidate.files, /run\.py/);

  const applied = await request('/api/actions/apply-patch', {
    method: 'POST',
    body: JSON.stringify({ candidate: candidate.id }),
  });
  assert.equal(applied.state.stage, 'validation');
  assert.equal(applied.state.appliedCandidateId, candidate.id);

  await request('/api/actions/start-benchmark', {
    method: 'POST',
    body: JSON.stringify({ purpose: 'candidate', candidate: candidate.id, operator: 'vector_add', matrix, timeoutSeconds: 30 }),
  });
  const evaluated = await pollState(
    (state) => state.activeMissionId === missionId && state.benchmark?.status === 'complete' && state.decisionReview?.gate,
    'candidate Accept Gate',
  );
  const queueTaskId = evaluated.benchmark.testTaskId;
  const queueTask = (await request(`/api/operator-tests/${encodeURIComponent(queueTaskId)}`)).task;
  const testedRunPy = await readFile(path.join(health.testBackend.taskRoot, queueTask.remoteTaskId, 'run.py'), 'utf8');
  const workspaceRunPy = await readFile(path.join(applied.workspace.workspace, 'run.py'), 'utf8');
  assert.equal(testedRunPy, workspaceRunPy);
  assert.notEqual(testedRunPy, baselineRunPy);
  assert.equal(queueTask.payload.candidate.digest, candidate.patchDigest);
  assert.equal(evaluated.decisionReview.gate.publishable, false);
  assert.equal(evaluated.benchmark.result.environment.liveHardware, false);

  console.log(JSON.stringify({
    status: 'passed',
    missionId,
    candidateId: candidate.id,
    candidateDigest: candidate.patchDigest,
    generatedFiles: candidate.files,
    testedArtifactMatchesWorkspace: true,
    gate: evaluated.decisionReview.gate.result,
    publishable: evaluated.decisionReview.gate.publishable,
    hardwareEvidence: evaluated.benchmark.result.environment.source,
    projectRoot: root,
  }, null, 2));
};

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exitCode = 1;
});
