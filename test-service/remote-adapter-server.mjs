import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteApiClient } from '../client-runtime/remote-api-client.mjs';

const port = Number(process.env.TEST_SERVICE_PORT || 4180);
const targetPlatforms = (process.env.OPERATOR_TEST_TARGET_PLATFORMS || 'gpu-iluvatar-mainstream')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const maxPollSeconds = process.env.OPERATOR_TEST_MAX_POLL_SECONDS ? Number(process.env.OPERATOR_TEST_MAX_POLL_SECONDS) : 0;
const systemId = process.env.OPERATOR_API_SYSTEM_ID || 'system-demo';

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

// ---------- 纯映射函数（供单元测试直接调用） ----------

export const validateTask = (task) => {
  if (!task || typeof task !== 'object') return 'request must be an object';
  if (!task.operator) return 'operator is required';
  if (!task.candidate?.digest && !task.candidate?.commit && !task.candidate?.patch) return 'candidate digest, commit, or patch is required';
  if (!Array.isArray(task.matrix?.environments) || !task.matrix.environments.length) return 'matrix.environments is required';
  if (!Array.isArray(task.matrix?.stages) || !task.matrix.stages.length) return 'matrix.stages is required';
  return null;
};

/** 本地 payload → 远程 test-jobs body（v1 固定 test_type=correctness，target_platforms 只发天数/环境变量覆盖） */
export const mapPayloadToRemoteSubmit = (payload, { targetPlatforms: platforms = targetPlatforms, systemId: system = systemId } = {}) => ({
  system_id: system,
  candidate_id: payload.candidate?.id || payload.candidate?.digest || 'candidate-demo-001',
  test_type: 'correctness',
  scope: `demo-workspace/operator/${payload.operator || 'unknown'}`,
  target_platforms: platforms,
});

/** 幂等键派生自 requestId（runId，每次提交唯一）；重试同键幂等，重跑同候选产生新任务 */
export const buildIdempotencyKey = (payload) => `op-${String(payload.requestId || payload.candidate?.digest || 'unknown').slice(0, 64)}`;

const DEFAULT_PAYLOAD = { operator: 'unknown', metric: 'latency_p50', matrix: {}, runtime: 'remote-runtime' };

/** 远程 job → 本地快照（满足队列 taskView 与 state-store applyOperatorTestSnapshot / evaluateAcceptGate 消费） */
export const mapRemoteJobToSnapshot = (job, { submittedAt = new Date().toISOString(), payload = DEFAULT_PAYLOAD, cancelled = false, now = Date.now() } = {}) => {
  const remoteStatus = String(job.status || '');
  const results = Array.isArray(job.platform_results) ? job.platform_results : [];
  const submittedMs = Date.parse(submittedAt);
  const elapsedSeconds = submittedMs && Number.isFinite(submittedMs) ? (now - submittedMs) / 1000 : 0;

  if (cancelled) {
    return {
      taskId: job.id,
      status: 'cancelled',
      progress: 90,
      submittedAt,
      completedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - submittedMs),
      logs: [{ sequence: 1, progress: 90, message: '已请求取消远端测试（远端平台不提供 cancel 端点，本地终止轮询）。' }],
      result: null,
      error: null,
    };
  }

  let local = { status: 'running', progress: 50 };
  if (remoteStatus === 'pending' || remoteStatus === 'scheduled') local = { status: 'queued', progress: 10 };
  else if (remoteStatus === 'running') local = { status: 'running', progress: 50 };
  else if (remoteStatus === 'needs_review') local = { status: 'completed', progress: 100 };
  else if (remoteStatus === 'failed') local = { status: 'failed', progress: 100 };
  else if (remoteStatus === 'executor_missing') local = { status: 'failed', progress: 100 };
  else local = { status: 'failed', progress: 100, unknown: true };

  // needs_review 但 platform_results 为空 → 转 failed（空 benchmark 会让 accept gate 硬失败，UX 更差）
  if (local.status === 'completed' && results.length === 0) {
    local = { status: 'failed', progress: 100, emptyResults: true };
  }
  // 看门狗：超过 OPERATOR_TEST_MAX_POLL_SECONDS 仍非终态 → failed
  if (local.status === 'running' || local.status === 'queued') {
    if (maxPollSeconds > 0 && elapsedSeconds > maxPollSeconds) {
      local = { status: 'failed', progress: 100, timedOut: true };
    }
  }

  const terminal = local.status === 'completed' || local.status === 'failed';
  const failedPlatform = results.find((p) => p.status === 'failed') || {};

  const logs = [];
  if (local.status === 'queued') logs.push({ sequence: 1, progress: 10, message: `远端测试已提交（${remoteStatus}），等待调度。` });
  if (local.status === 'running') logs.push(
    { sequence: 1, progress: 10, message: '远端测试已提交，等待调度。' },
    { sequence: 2, progress: 50, message: '远端 runner 正在执行测试。' },
  );
  if (local.status === 'completed') logs.push(
    { sequence: 1, progress: 10, message: '远端测试已提交，等待调度。' },
    { sequence: 2, progress: 50, message: '远端 runner 正在执行测试。' },
    { sequence: 3, progress: 100, message: `远端平台测试完成，等待审查。${results.map((p) => `${p.platform_id}=${p.correctness || p.status}`).join(' · ')}` },
  );
  if (local.status === 'failed') {
    const reason = local.timedOut ? `远端测试超时（${maxPollSeconds}s）。`
      : local.emptyResults ? '远端任务已通过但未返回平台结果。'
      : local.unknown ? `远端返回未知状态 "${remoteStatus}"。`
      : failedPlatform.error_summary || failedPlatform.error || `远端平台执行失败。`;
    logs.push(
      { sequence: 1, progress: 10, message: '远端测试已提交，等待调度。' },
      { sequence: 2, progress: 50, message: '远端 runner 正在执行测试。' },
      { sequence: 3, progress: 100, message: `远端测试失败：${reason}` },
    );
  }

  return {
    taskId: job.id,
    status: local.status,
    progress: local.progress,
    submittedAt,
    completedAt: terminal ? new Date(now).toISOString() : null,
    durationMs: terminal && submittedMs ? Math.max(0, now - submittedMs) : 0,
    logs,
    error: local.status === 'failed' ? {
      code: local.timedOut ? 'REMOTE_TEST_TIMEOUT' : local.unknown ? 'REMOTE_UNKNOWN_STATUS' : 'REMOTE_TEST_FAILED',
      message: (local.emptyResults ? '任务通过但无平台结果' : (failedPlatform.error_summary || failedPlatform.error || `远端状态 ${remoteStatus}`)),
    } : null,
    result: terminal && local.status === 'completed' ? buildResult(results, payload) : null,
  };
};

/** platform_results → result（满足 evaluateAcceptGate：benchmark correctness、tracer/profiler format、liveHardware=true） */
const buildResult = (results, payload) => ({
  benchmark: results.map((p) => ({
    environment: p.platform_id,
    metric: payload.metric || 'latency_p50',
    value: Number(p.latency_us ?? p.throughput ?? 0),
    unit: p.latency_us != null ? 'us' : 'items/s',
    samples: Number(payload.matrix?.repeats || 200),
    warmup: Number(payload.matrix?.warmup || 50),
    correctness: { passed: p.status === 'passed' && p.correctness === 'pass', total: Number(payload.matrix?.correctnessCases || 24) },
  })),
  tracer: { format: 'operator-trace/v1', events: [], criticalPathUs: Number(results[0]?.latency_us ?? 0) },
  profiler: { format: 'operator-profile/v1', metrics: { throughput: results[0]?.throughput ?? null } },
  environment: {
    requested: payload.hardware || payload.matrix?.environments,
    runtime: payload.runtime || 'remote-runtime',
    service: 'operator-test-service',
    liveHardware: true,
  },
});

// ---------- 适配服务 ----------

/**
 * 与 mock-server 相同的 /v1/* 契约，内部桥接到远程 operator-iteration-platform API。
 * 返回 { handle }，handle 处理 (request, response, url)；直接运行时自动监听 TEST_SERVICE_PORT。
 */
export const createRemoteAdapterServer = ({ remoteClient, targetPlatforms: platforms = targetPlatforms } = {}) => {
  // record: { systemId, submittedAt, payload, cancelled, remoteId }
  const jobs = new Map();

  const snapshotFor = async (remoteId) => {
    const record = jobs.get(remoteId);
    if (record?.cancelled) {
      return { snapshot: mapRemoteJobToSnapshot({ id: remoteId }, { submittedAt: record.submittedAt, payload: record.payload, cancelled: true }), record: null };
    }
    try {
      const job = await remoteClient.getJob(remoteId);
      return { snapshot: mapRemoteJobToSnapshot(job, { submittedAt: record?.submittedAt || job.created_at, payload: record?.payload }), record };
    } catch (error) {
      throw error; // 404 / 网络错误向上抛，由 handle 归一化为 HTTP 状态
    }
  };

  const handle = async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', service: 'operator-test-service', liveHardware: true, remote: remoteClient.baseUrl, startedAt });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/operator-tests') {
      const body = await readJson(request);
      const validationError = validateTask(body);
      if (validationError) {
        json(response, 400, { error: validationError, code: 'OPERATOR_TEST_REQUEST_INVALID' });
        return;
      }
      const remoteBody = mapPayloadToRemoteSubmit(body, { targetPlatforms: platforms });
      const submitted = await remoteClient.submitJob(remoteBody, buildIdempotencyKey(body));
      const remoteId = String(submitted.id);
      jobs.set(remoteId, {
        systemId: remoteClient.systemId || systemId,
        submittedAt: new Date().toISOString(),
        payload: structuredClone({ ...body, submittedAt: new Date().toISOString() }),
        cancelled: false,
        remoteId,
      });
      json(response, 202, { taskId: remoteId, status: 'queued', progress: 0, submittedAt: new Date().toISOString() });
      return;
    }
    const taskMatch = url.pathname.match(/^\/v1\/operator-tests\/([^/]+)$/);
    if (request.method === 'GET' && taskMatch) {
      const remoteId = decodeURIComponent(taskMatch[1]);
      const { snapshot } = await snapshotFor(remoteId);
      json(response, 200, snapshot);
      return;
    }
    const cancelMatch = url.pathname.match(/^\/v1\/operator-tests\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const remoteId = decodeURIComponent(cancelMatch[1]);
      const record = jobs.get(remoteId);
      if (!record) {
        json(response, 404, { error: 'operator test task not found', code: 'OPERATOR_TEST_NOT_FOUND' });
        return;
      }
      if (record.cancelled) {
        json(response, 200, mapRemoteJobToSnapshot({ id: remoteId }, { submittedAt: record.submittedAt, payload: record.payload, cancelled: true }));
        return;
      }
      // 远端已终态则返回终态快照，不覆盖已完成任务；否则本地标记取消（远端无 cancel 端点）
      let terminal = false;
      try {
        const job = await remoteClient.getJob(remoteId);
        terminal = ['needs_review', 'failed', 'executor_missing'].includes(job.status);
        if (terminal) {
          json(response, 200, mapRemoteJobToSnapshot(job, { submittedAt: record.submittedAt, payload: record.payload }));
          return;
        }
      } catch { /* 远端不可达时按本地取消处理 */ }
      record.cancelled = true;
      json(response, 200, mapRemoteJobToSnapshot({ id: remoteId }, { submittedAt: record.submittedAt, payload: record.payload, cancelled: true }));
      return;
    }
    const eventMatch = url.pathname.match(/^\/v1\/operator-tests\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventMatch) {
      const remoteId = decodeURIComponent(eventMatch[1]);
      const { snapshot } = await snapshotFor(remoteId);
      json(response, 200, { taskId: snapshot.taskId, events: snapshot.logs, nextSequence: (snapshot.logs || []).length });
      return;
    }
    json(response, 404, { error: 'not found' });
  };

  return { handle, jobs };
};

const startedAt = new Date().toISOString();

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const remoteClient = createRemoteApiClient();
  const { handle } = createRemoteAdapterServer({ remoteClient });
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    handle(request, response, url).catch((error) => json(response, error.status || 500, { error: error.message, code: error.code || 'OPERATOR_TEST_SERVICE_ERROR' }));
  });
  server.listen(port, '127.0.0.1', async () => {
    console.log(`Remote operator test service (adapter) listening on http://127.0.0.1:${port} → ${remoteClient.baseUrl}`);
    await remoteClient.warmup();
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
