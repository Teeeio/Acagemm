import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.TEST_SERVICE_PORT || 4180);
// A deadline is a ceiling, never the simulated workload duration.
const mockDurationMs = Number(process.env.TEST_SERVICE_MOCK_DURATION_MS ?? 3000);
if (!Number.isInteger(mockDurationMs) || mockDurationMs < 1 || mockDurationMs > 60000) {
  throw new Error('TEST_SERVICE_MOCK_DURATION_MS must be an integer from 1 to 60000.');
}
const tasks = new Map();
const startedAt = new Date().toISOString();

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) {
      const error = new Error('Operator test request exceeds the 2 MB limit.');
      error.status = 413;
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Operator test request must be valid JSON.');
    error.status = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
};

const validateTask = (task) => {
  if (!task || typeof task !== 'object') return 'request must be an object';
  if (!task.operator) return 'operator is required';
  if (!task.candidate?.digest && !task.candidate?.commit && !task.candidate?.patch) return 'candidate digest, commit, or patch is required';
  if (!Array.isArray(task.matrix?.environments) || !task.matrix.environments.length) return 'matrix.environments is required';
  if (!Array.isArray(task.matrix?.stages) || !task.matrix.stages.length) return 'matrix.stages is required';
  return null;
};

const environmentScore = (environment, index) => {
  const key = String(environment).toUpperCase();
  const base = key.includes('C500') || key.includes('METAX') ? 41.8 : key.includes('CUDA') || key.includes('NVIDIA') ? 36.1 : 44.6;
  return Number((base + index * 0.7).toFixed(2));
};

const buildResult = (task) => {
  const environments = task.matrix.environments.map(String);
  const benchmark = environments.map((environment, index) => ({
    environment,
    metric: task.metric || 'latency_p50',
    value: environmentScore(environment, index),
    unit: task.metric?.includes('throughput') ? 'items/s' : 'us',
    samples: Number(task.matrix.repeats || 200),
    warmup: Number(task.matrix.warmup || 50),
    correctness: { passed: true, total: Number(task.matrix.correctnessCases || 24) },
  }));
  const traceEvents = [
    { name: 'plan_lookup', category: 'runtime', startUs: 0, durationUs: 8.4 },
    { name: 'workspace_prepare', category: 'runtime', startUs: 8.4, durationUs: 6.1 },
    { name: 'paged_attention_kernel', category: 'kernel', startUs: 14.5, durationUs: 21.3 },
    { name: 'host_mirror_fallback', category: 'sync', startUs: 35.8, durationUs: 2.2 },
  ];
  return {
    benchmark,
    tracer: {
      format: 'operator-trace/v1',
      events: traceEvents,
      criticalPathUs: 38.0,
    },
    profiler: {
      format: 'operator-profile/v1',
      metrics: {
        achievedOccupancy: 0.74,
        dramBandwidthGbps: 812,
        launchOverheadUs: 8.4,
        kernelDurationUs: 21.3,
      },
    },
    environment: {
      requested: task.hardware || task.matrix.environments,
      runtime: task.runtime || 'mock-runtime',
      service: 'operator-test-service',
      liveHardware: false,
    },
  };
};

const materialize = (task) => {
  if (task.status === 'cancelled') {
    return {
      taskId: task.taskId,
      status: 'cancelled',
      resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Simulation has no execution worker.' },
      progress: task.progress || 0,
      submittedAt: task.submittedAt,
      completedAt: task.completedAt,
      durationMs: Date.now() - task.startedAtMs,
      logs: [...(task.logs || []), { sequence: (task.logs || []).length + 1, progress: task.progress || 0, message: 'Mock test service: task cancelled' }],
      result: null,
    };
  }
  const elapsed = Date.now() - task.startedAtMs;
  const durationMs = mockDurationMs;
  const progress = Math.min(100, Math.floor((elapsed / durationMs) * 100 / 10) * 10);
  if (progress < 100) {
    return {
      taskId: task.taskId,
      status: progress > 0 ? 'running' : 'queued',
      progress,
      submittedAt: task.submittedAt,
      logs: [{ sequence: 1, progress, message: `Mock test service: ${progress}%` }],
      result: null,
    };
  }
  return {
    taskId: task.taskId,
    status: 'completed',
    resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Simulation has no execution worker.' },
    progress: 100,
    submittedAt: task.submittedAt,
    completedAt: new Date(task.startedAtMs + durationMs).toISOString(),
    durationMs,
    logs: [
      { sequence: 1, progress: 25, message: 'Correctness matrix completed' },
      { sequence: 2, progress: 70, message: 'Benchmark samples collected' },
      { sequence: 3, progress: 100, message: 'Tracer and profiler artifacts generated' },
    ],
    result: buildResult(task),
  };
};

const handle = async (request, response, url) => {
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok', service: 'operator-test-service', liveHardware: false, startedAt });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/operator-tests') {
    const body = await readJson(request);
    const validationError = validateTask(body);
    if (validationError) {
      json(response, 400, { error: validationError, code: 'OPERATOR_TEST_REQUEST_INVALID' });
      return;
    }
    const taskId = `test_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const task = { ...body, taskId, submittedAt: new Date().toISOString(), startedAtMs: Date.now() };
    tasks.set(taskId, task);
    json(response, 202, { taskId, status: 'queued', submittedAt: task.submittedAt });
    return;
  }
  const taskMatch = url.pathname.match(/^\/v1\/operator-tests\/([^/]+)$/);
  if (request.method === 'GET' && taskMatch) {
    const task = tasks.get(decodeURIComponent(taskMatch[1]));
    if (!task) {
      json(response, 404, { error: 'operator test task not found', code: 'OPERATOR_TEST_NOT_FOUND' });
      return;
    }
    json(response, 200, materialize(task));
    return;
  }
  const cancelMatch = url.pathname.match(/^\/v1\/operator-tests\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const taskId = decodeURIComponent(cancelMatch[1]);
    const task = tasks.get(taskId);
    if (!task) {
      json(response, 404, { error: 'operator test task not found', code: 'OPERATOR_TEST_NOT_FOUND' });
      return;
    }
    task.status = 'cancelled';
    task.progress = Math.min(99, Math.floor(((Date.now() - task.startedAtMs) / mockDurationMs) * 100));
    task.completedAt = new Date().toISOString();
    json(response, 200, materialize(task));
    return;
  }
  const eventMatch = url.pathname.match(/^\/v1\/operator-tests\/([^/]+)\/events$/);
  if (request.method === 'GET' && eventMatch) {
    const task = tasks.get(decodeURIComponent(eventMatch[1]));
    if (!task) {
      json(response, 404, { error: 'operator test task not found', code: 'OPERATOR_TEST_NOT_FOUND' });
      return;
    }
    const snapshot = materialize(task);
    json(response, 200, { taskId: snapshot.taskId, events: snapshot.logs, nextSequence: snapshot.logs.length });
    return;
  }
  json(response, 404, { error: 'not found' });
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  handle(request, response, url).catch((error) => json(response, error.status || 500, { error: error.message, code: error.code || 'OPERATOR_TEST_SERVICE_ERROR' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Operator test service listening on http://127.0.0.1:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
