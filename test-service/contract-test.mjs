import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4181;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['test-service/mock-server.mjs'], { cwd: root, env: { ...process.env, TEST_SERVICE_PORT: String(port) }, stdio: 'ignore' });

const request = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  assert.equal(response.ok, true, `${pathname}: ${payload.error || response.status}`);
  return payload;
};

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await request('/health'); break; } catch { await delay(50); }
    if (attempt === 29) throw new Error('test service did not start');
  }
  const submitted = await request('/v1/operator-tests', {
    method: 'POST',
    body: JSON.stringify({ operator: 'mla_paged_attention', candidate: { digest: 'candidate:test' }, matrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'] }, tracer: { enabled: true }, profiler: { enabled: true } }),
  });
  assert.match(submitted.taskId, /^test_/);
  let result;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    result = await request(`/v1/operator-tests/${submitted.taskId}`);
    if (result.status === 'completed') break;
    await delay(150);
  }
  assert.equal(result.status, 'completed');
  assert.ok(Array.isArray(result.result.benchmark));
  assert.equal(result.result.tracer.format, 'operator-trace/v1');
  assert.equal(result.result.profiler.format, 'operator-profile/v1');
  const cancellable = await request('/v1/operator-tests', {
    method: 'POST',
    body: JSON.stringify({ operator: 'mla_paged_attention', candidate: { digest: 'candidate:cancel' }, matrix: { environments: ['C500'], stages: ['Correctness'] } }),
  });
  const cancelled = await request(`/v1/operator-tests/${cancellable.taskId}/cancel`, { method: 'POST', body: '{}' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await request(`/v1/operator-tests/${cancellable.taskId}`)).status, 'cancelled');
  const notBusinessApi = await fetch(`${baseUrl}/api/missions`);
  assert.equal(notBusinessApi.status, 404);
  console.log('test-service contract: PASS');
} finally {
  child.kill();
}
