import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testerDir = path.dirname(fileURLToPath(import.meta.url));
const taskFileName = 'local-c500-tasks.json';

const now = () => new Date().toISOString();

const loadTasks = async (missionDir) => {
  try {
    return JSON.parse(await readFile(path.join(missionDir, taskFileName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const saveTasks = async (missionDir, tasks) => {
  await mkdir(missionDir, { recursive: true });
  await writeFile(path.join(missionDir, taskFileName), `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
};

const taskView = (task) => ({
  taskId: task.taskId,
  queueId: task.taskId,
  status: task.status,
  progress: task.progress,
  submittedAt: task.submittedAt,
  startedAt: task.startedAt || null,
  completedAt: task.completedAt || null,
  durationMs: task.durationMs || 0,
  payload: task.payload,
  result: task.result || null,
  error: task.error || null,
  cancelRequested: task.cancelRequested === true,
});

const fail = (message, code = 'LOCAL_C500_TASK_INVALID') => {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
};

const validatePayload = (payload) => {
  if (!payload || typeof payload !== 'object') throw fail('local C500 test payload must be an object');
  if (!['baseline', 'candidate'].includes(payload.purpose)) throw fail('local C500 test purpose must be baseline or candidate');
  if (!payload.candidateArtifact?.path || !payload.candidateArtifact?.digest) throw fail('candidateArtifact.path and candidateArtifact.digest are required');
  if (!existsSync(payload.candidateArtifact.path)) throw fail(`candidate artifact does not exist: ${payload.candidateArtifact.path}`);
  if (!payload.matrix?.shapeKey) throw fail('matrix.shapeKey is required');
  if (!Array.isArray(payload.stages) || payload.stages.length === 0) throw fail('at least one test stage is required');
};

const mockMeasurement = (payload) => {
  if (payload.purpose === 'baseline') return { latency_p50_us: 356.2615, latency_p95_us: 372.4 };
  const round = Math.max(1, Number(payload.round || 1));
  const values = [160, 120.5, 100, 99.5, 99.2];
  const latency_p50_us = values[Math.min(round - 1, values.length - 1)];
  return { latency_p50_us, latency_p95_us: latency_p50_us * 1.1 };
};

const runMockTask = (payload) => {
  const measurement = mockMeasurement(payload);
  const baseline = payload.purpose === 'baseline' ? measurement.latency_p50_us : Number(payload.baselineLatency || 356.2615);
  const speedup = baseline / measurement.latency_p50_us;
  return {
    status: 'completed',
    correctness: 'pass',
    correctness_detail: { passed: true, simulated: true },
    latency_p50_us: measurement.latency_p50_us,
    latency_p95_us: measurement.latency_p95_us,
    baseline_latency_p50_us: baseline,
    speedup,
    warmup: 50,
    repeats: 200,
    mctracer: 'generated',
    mcProfiler: 'generated',
  };
};

const runHarness = (payload) => {
  const args = [path.join(testerDir, 'harness.py'), '--operator-path', payload.candidateArtifact.path];
  if (payload.purpose === 'baseline') args.push('--mode', 'reference');
  const started = Date.now();
  const result = spawnSync('python', args, { encoding: 'utf8' });
  if (result.status !== 0) return { status: 'failed', error: result.stderr || result.stdout || 'local C500 harness failed', elapsed_ms: Date.now() - started };
  try {
    return { ...JSON.parse(result.stdout), elapsed_ms: Date.now() - started };
  } catch (error) {
    return { status: 'failed', error: `invalid harness JSON: ${error.message}`, elapsed_ms: Date.now() - started };
  }
};

const runAnalysisTool = (toolName, payload, environment) => {
  const configured = environment?.tools?.[toolName];
  if (configured?.status !== 'ok') return { status: 'missing', tool: toolName };
  const artifactDir = path.join(path.dirname(payload.candidateArtifact.path), 'analysis', toolName);
  const result = spawnSync(toolName, [
    '--output', artifactDir,
    'python',
    path.join(testerDir, 'harness.py'),
    '--operator-path',
    payload.candidateArtifact.path,
    '--warmup',
    '5',
    '--repeats',
    '10',
  ], { encoding: 'utf8', cwd: testerDir });
  return {
    status: result.status === 0 ? 'completed' : 'failed',
    tool: toolName,
    artifact_dir: artifactDir,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exit_code: result.status,
  };
};

const buildResult = ({ payload, raw, mock, environment }) => {
  const liveHardware = !mock && (environment?.liveHardware === true || environment?.checks?.c500?.status === 'ok');
  const tracer = mock ? { status: 'generated', tool: 'mctracer' } : runAnalysisTool('mctracer', payload, environment);
  const profiler = mock ? { status: 'generated', tool: 'mcProfiler' } : runAnalysisTool('mcProfiler', payload, environment);
  const benchmark = raw.status === 'completed' && Number.isFinite(Number(raw.latency_p50_us))
    ? {
      status: 'completed',
      latency_p50_us: Number(raw.latency_p50_us),
      latency_p95_us: Number(raw.latency_p95_us || 0) || null,
      baseline_latency_p50_us: Number(raw.baseline_latency_p50_us || 0) || null,
      speedup: Number(raw.speedup || 0) || null,
    }
    : { status: 'failed', error: raw.error || 'benchmark did not produce a latency measurement' };
  return {
    status: raw.status,
    candidate: { digest: payload.candidateArtifact.digest, path: payload.candidateArtifact.path },
    matrix: structuredClone(payload.matrix),
    purpose: payload.purpose,
    correctness: raw.correctness || 'fail',
    correctness_detail: raw.correctness_detail || null,
    benchmark,
    tracer,
    profiler,
    latency_p50_us: benchmark.latency_p50_us || null,
    latency_p95_us: benchmark.latency_p95_us || null,
    baseline_latency_p50_us: benchmark.baseline_latency_p50_us || null,
    speedup: benchmark.speedup || null,
    mctracer: tracer.status,
    mcProfiler: profiler.status,
    environment: {
      liveHardware,
      source: mock ? 'simulation' : liveHardware ? 'local-c500' : 'local-c500-unverified',
      platform: 'local-c500',
    },
    raw,
  };
};

export const createLocalC500Adapter = ({ missionDir, mock = false, environment = {} } = {}) => {
  if (!missionDir) throw new Error('missionDir is required');

  const submitTest = async (payload) => {
    validatePayload(payload);
    const tasks = await loadTasks(missionDir);
    const task = {
      schemaVersion: 1,
      taskId: `local_c500_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      status: 'waiting',
      progress: 0,
      submittedAt: now(),
      payload: structuredClone(payload),
      result: null,
      error: null,
    };
    await saveTasks(missionDir, [...tasks, task]);
    return taskView(task);
  };

  const pollTest = async (taskId) => {
    const tasks = await loadTasks(missionDir);
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) throw fail(`local C500 task not found: ${taskId}`, 'LOCAL_C500_TASK_NOT_FOUND');
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return taskView(task);
    task.status = 'running';
    task.startedAt = task.startedAt || now();
    task.progress = 10;
    await saveTasks(missionDir, tasks);
    const raw = mock ? runMockTask(task.payload) : runHarness(task.payload);
    task.result = buildResult({ payload: task.payload, raw, mock, environment });
    task.status = raw.status === 'completed' ? 'completed' : 'failed';
    task.progress = 100;
    task.completedAt = now();
    task.durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    task.error = task.status === 'failed' ? { code: 'LOCAL_C500_TEST_FAILED', message: raw.error || 'local C500 test failed' } : null;
    await saveTasks(missionDir, tasks);
    return taskView(task);
  };

  const cancelTest = async (taskId) => {
    const tasks = await loadTasks(missionDir);
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) throw fail(`local C500 task not found: ${taskId}`, 'LOCAL_C500_TASK_NOT_FOUND');
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      task.status = 'cancelled';
      task.cancelRequested = true;
      task.completedAt = now();
      task.progress = task.progress || 0;
      await saveTasks(missionDir, tasks);
    }
    return taskView(task);
  };

  return { missionDir, submitTest, pollTest, cancelTest };
};
