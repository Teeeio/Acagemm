import { createServer } from 'node:http';
import assert from 'node:assert';
import { createRemoteApiClient } from '../client-runtime/remote-api-client.mjs';
import { createRemoteAdapterServer, mapRemoteJobToSnapshot } from './remote-adapter-server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- fake 远程 operator-iteration-platform ----------

const makeFakeRemote = () => {
  const logins = [];
  const submitted = [];
  // jobId -> scripted remote job (advances one step per GET)
  const jobs = new Map([
    ['job_1', [{ status: 'running', platform_results: [{ platform_id: 'gpu-iluvatar-mainstream', status: 'running' }] },
      { status: 'needs_review', platform_results: [{ platform_id: 'gpu-iluvatar-mainstream', status: 'passed', correctness: 'pass', latency_us: 51.5, throughput: 20330000000, evidence_id: 'evidence-fake-1' }] }]],
    ['job_fail', [{ status: 'failed', platform_results: [{ platform_id: 'gpu-iluvatar-mainstream', status: 'failed', correctness: 'fail', error_summary: 'command exit code is non-zero' }] }]],
    ['job_exec_missing', [{ status: 'executor_missing', platform_results: [] }]],
    ['job_empty_pass', [{ status: 'needs_review', platform_results: [] }]],
    ['job_cancel', [{ status: 'running', platform_results: [{ platform_id: 'gpu-iluvatar-mainstream', status: 'running' }] }]],
    ['job_unknown', [{ status: 'weird_state', platform_results: [] }]],
  ]);
  const index = new Map();
  let server;
  const handler = async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      logins.push(parsed);
      json(200, { access_token: 'fake-token', token_type: 'Bearer', expires_in: 86400 });
      return;
    }
    if (url.pathname === '/api/v1/test-platforms' && request.method === 'GET') {
      json(200, { items: [{ platform_id: 'gpu-iluvatar-mainstream', status: 'available' }], runners: [] });
      return;
    }
    if (url.pathname === '/api/v1/test-jobs' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      // 测试通过 candidate_id 挑选脚本化的远程 job id（cancel 走提交路径，保证 adapter 有记录）
      const id = parsed.candidate_id === 'cancel-me' ? 'job_cancel' : parsed.candidate_id === 'fail-me' ? 'job_fail' : `job_${submitted.length + 1}`;
      submitted.push({ body: parsed, idempotencyKey: request.headers['idempotency-key'] });
      json(200, { id, status: 'scheduled', target_platforms: parsed.target_platforms });
      return;
    }
    const match = url.pathname.match(/^\/api\/v1\/test-jobs\/([^/]+)$/);
    if (match && request.method === 'GET') {
      const id = match[1];
      const script = jobs.get(id);
      if (!script) { json(404, { error: 'job not found' }); return; }
      const step = index.get(id) || 0;
      index.set(id, step + 1);
      json(200, { id, ...script[Math.min(step, script.length - 1)] });
      return;
    }
    json(404, { error: 'not found' });
  };
  return {
    listen: () => new Promise((resolve) => {
      server = createServer(handler).listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
    url: () => `http://127.0.0.1:${server.address().port}`,
    logins,
    submitted,
  };
};

// ---------- 测试工具 ----------

const createStack = async () => {
  const fake = makeFakeRemote();
  await fake.listen();
  const remoteClient = createRemoteApiClient({ baseUrl: fake.url(), username: 'demo_admin', password: 'demo123', tlsAllowSelfSigned: false, timeoutMs: 2000 });
  const { handle } = createRemoteAdapterServer({ remoteClient });
  let adapterServer;
  const adapterPort = await new Promise((resolve) => {
    adapterServer = createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      handle(request, response, url).catch((error) => {
        response.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error.message, code: error.code }));
      });
    }).listen(0, '127.0.0.1', () => resolve(adapterServer.address().port));
  });
  const api = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${adapterPort}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body,
    });
    let body = {};
    try { body = await response.json(); } catch { /* empty */ }
    return { status: response.status, body };
  };
  return {
    fake,
    api,
    close: async () => { await fake.close(); await new Promise((resolve) => adapterServer.close(resolve)); },
  };
};

const samplePayload = (overrides = {}) => ({
  schemaVersion: 1,
  requestId: 'run_remote_adapter_test',
  missionId: 'MIS_TEST',
  operator: 'vector_add',
  candidate: { id: 'candidate-demo-001', digest: 'deadbeef' },
  hardware: ['天数 Iluvatar'],
  runtime: 'client-managed-runtime',
  metric: 'latency_p50',
  matrix: { environments: ['天数 Iluvatar'], stages: ['Correctness'], warmup: 50, repeats: 200, correctnessCases: 24 },
  tracer: { enabled: true },
  profiler: { enabled: true },
  limits: { timeoutSeconds: 3 },
  ...overrides,
});

// ---------- 用例 ----------

const run = async () => {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (error) { failed += 1; console.error(`  ✗ ${name}: ${error.message}`); }
  };
  const checkAsync = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (error) { failed += 1; console.error(`  ✗ ${name}: ${error.message}`); }
  };

  console.log('remote-adapter: 登录 / 提交 / 轮询');
  {
    const stack = await createStack();
    const { fake, api } = stack;
    await checkAsync('health 报告 liveHardware=true + remote baseUrl', async () => {
      const h = await api('/health');
      assert.equal(h.status, 200);
      assert.equal(h.body.liveHardware, true);
      assert.match(h.body.remote, /^http:\/\/127\.0\.0\.1/);
    });
    await checkAsync('提交 202 返回真实远程 job id', async () => {
      const r = await api('/v1/operator-tests', { method: 'POST', body: JSON.stringify(samplePayload()) });
      assert.equal(r.status, 202);
      assert.equal(r.body.taskId, 'job_1');
      assert.equal(r.body.status, 'queued');
      assert.equal(fake.submitted[0].body.system_id, 'system-demo');
      assert.equal(fake.submitted[0].body.candidate_id, 'candidate-demo-001');
      assert.equal(fake.submitted[0].body.test_type, 'correctness');
      assert.equal(fake.submitted[0].body.scope, 'demo-workspace/operator/vector_add');
      assert.deepEqual(fake.submitted[0].body.target_platforms, ['gpu-iluvatar-mainstream']);
      assert.equal(fake.submitted[0].idempotencyKey, 'op-run_remote_adapter_test');
    });
    await checkAsync('校验缺失 operator 返回 400', async () => {
      const r = await api('/v1/operator-tests', { method: 'POST', body: JSON.stringify(samplePayload({ operator: undefined })) });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'OPERATOR_TEST_REQUEST_INVALID');
    });
    await checkAsync('running → running(progress 50)', async () => {
      const s = await api('/v1/operator-tests/job_1');
      assert.equal(s.status, 200);
      assert.equal(s.body.status, 'running');
      assert.equal(s.body.progress, 50);
      assert.equal(s.body.result, null);
    });
    await checkAsync('needs_review → completed(progress 100) + result 字段满足 accept gate', async () => {
      const s = await api('/v1/operator-tests/job_1');
      assert.equal(s.body.status, 'completed');
      assert.equal(s.body.progress, 100);
      assert.equal(s.body.result.benchmark[0].environment, 'gpu-iluvatar-mainstream');
      assert.equal(s.body.result.benchmark[0].value, 51.5);
      assert.equal(s.body.result.benchmark[0].correctness.passed, true);
      assert.equal(s.body.result.benchmark[0].correctness.total, 24);
      assert.equal(s.body.result.tracer.format, 'operator-trace/v1');
      assert.ok(Array.isArray(s.body.result.tracer.events));
      assert.equal(s.body.result.profiler.format, 'operator-profile/v1');
      assert.ok(s.body.result.profiler.metrics);
      assert.equal(s.body.result.environment.liveHardware, true);
    });
    await checkAsync('未知 job id → 404 OPERATOR_TEST_NOT_FOUND', async () => {
      const s = await api('/v1/operator-tests/nope');
      assert.equal(s.status, 404);
      assert.equal(s.body.code, 'OPERATOR_TEST_NOT_FOUND');
    });
    await checkAsync('边界守卫：/api/missions → 404（不暴露 API）', async () => {
      const s = await api('/api/missions');
      assert.equal(s.status, 404);
    });
    await stack.close();
  }

  console.log('remote-adapter: failed / executor_missing / 空结果 / 未知状态 / cancel');
  {
    const stack = await createStack();
    const { fake, api } = stack;
    await checkAsync('failed → failed + error_summary', async () => {
      const s = await api('/v1/operator-tests/job_fail');
      assert.equal(s.body.status, 'failed');
      assert.equal(s.body.progress, 100);
      assert.match(s.body.error.message, /command exit code is non-zero/);
    });
    await checkAsync('executor_missing → failed', async () => {
      const s = await api('/v1/operator-tests/job_exec_missing');
      assert.equal(s.body.status, 'failed');
    });
    await checkAsync('needs_review 但平台结果为空 → failed（避免 accept gate 硬失败）', async () => {
      const s = await api('/v1/operator-tests/job_empty_pass');
      assert.equal(s.body.status, 'failed');
      assert.equal(s.body.error.code, 'REMOTE_TEST_FAILED');
    });
    await checkAsync('未知远程状态 → failed(REMOTE_UNKNOWN_STATUS)', async () => {
      const s = await api('/v1/operator-tests/job_unknown');
      assert.equal(s.body.status, 'failed');
      assert.equal(s.body.error.code, 'REMOTE_UNKNOWN_STATUS');
    });
    await checkAsync('cancel 本地覆盖，随后 GET 保持 cancelled', async () => {
      // 先提交一个停留在 running 的 job（candidate_id=cancel-me → job_cancel），让 adapter 有记录
      const previousCandidateId = process.env.OPERATOR_TEST_CANDIDATE_ID;
      process.env.OPERATOR_TEST_CANDIDATE_ID = 'cancel-me';
      const sub = await api('/v1/operator-tests', { method: 'POST', body: JSON.stringify(samplePayload({ requestId: 'run_cancel', candidate: { id: 'cancel-me', digest: 'c' } })) });
      if (previousCandidateId == null) delete process.env.OPERATOR_TEST_CANDIDATE_ID;
      else process.env.OPERATOR_TEST_CANDIDATE_ID = previousCandidateId;
      assert.equal(sub.body.taskId, 'job_cancel');
      const c = await api('/v1/operator-tests/job_cancel/cancel', { method: 'POST', body: '{}' });
      assert.equal(c.body.status, 'cancelled');
      const again = await api('/v1/operator-tests/job_cancel');
      assert.equal(again.body.status, 'cancelled');
      assert.equal(fake.submitted.at(-1).idempotencyKey, 'op-run_cancel');
    });
    await stack.close();
  }

  console.log('remote-adapter: 纯映射函数边界');
  {
    const terminal = mapRemoteJobToSnapshot(
      { id: 'x', status: 'needs_review', platform_results: [{ platform_id: 'p1', status: 'passed', correctness: 'pass', latency_us: 10 }] },
      { payload: samplePayload() },
    );
    check('needs_review 终态含 result', () => {
      assert.equal(terminal.status, 'completed');
      assert.ok(terminal.result);
    });
    const fail = mapRemoteJobToSnapshot({ id: 'x', status: 'failed', platform_results: [] }, { payload: samplePayload() });
    check('failed 无结果时 result 为 null', () => {
      assert.equal(fail.status, 'failed');
      assert.equal(fail.result, null);
    });
    const timedOut = mapRemoteJobToSnapshot({ id: 'x', status: 'running', platform_results: [] }, {
      payload: samplePayload(),
      submittedAt: new Date(Date.now() - 4000 * 1000).toISOString(),
      now: Date.now(),
    });
    check('默认未启看门狗：超时不误判 running', () => {
      // OPERATOR_TEST_MAX_POLL_SECONDS 未设置时 running 保持 running（不误判失败）
      assert.equal(timedOut.status, 'running');
    });
  }

  console.log(`\nremote-adapter: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((error) => { console.error(error); process.exit(1); });
