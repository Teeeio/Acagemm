import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = path.join(rootDir, 'runtime', `smoke-${process.pid}`);
const port = 4199;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn('node', ['server/mock-server.mjs'], {
  cwd: rootDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_DATA_DIR: path.join(smokeRoot, 'data'),
    OPERATOR_RUNTIME_DIR: path.join(smokeRoot, 'runtime'),
  },
});

const request = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
};

const waitForServer = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await request('/api/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Mock API did not start.');
};

try {
  await waitForServer();
  await request('/api/reset', { method: 'POST' });
  const mission = await request('/api/missions', { method: 'POST', body: JSON.stringify({ goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟' }) });
  assert.equal(mission.state.agent.status, 'running');
  let agentState;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    agentState = (await request('/api/state')).state;
    if (agentState.agent.status === 'awaiting_approval') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(agentState.agent.status, 'awaiting_approval');
  assert.equal(agentState.agent.currentAction.type, 'candidate.plan');
  const applied = await request('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });
  assert.equal(applied.state.patchApplied, true);
  assert.equal(applied.state.stage, 'validation');
  const patchedFile = await readFile(path.join(smokeRoot, 'runtime', 'mla-kernels', 'kernels', 'paged_attention.cu'), 'utf8');
  assert.match(patchedFile, /plan_cache\.get_or_build/);

  await request('/api/actions/start-benchmark', { method: 'POST', body: '{}' });
  let state;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = (await request('/api/state')).state;
    if (state.benchmark.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(state.benchmark.status, 'complete');
  assert.equal(state.stage, 'evidence');
  assert.equal(state.benchmark.logs.at(-1).progress, 100);

  const adopted = await request('/api/actions/adopt', { method: 'POST', body: JSON.stringify({ note: 'smoke test approved' }) });
  assert.equal(adopted.state.stage, 'curation');
  const published = await request('/api/knowledge/publish-all', { method: 'POST', body: JSON.stringify({ drafts: adopted.state.knowledgeDrafts }) });
  assert.equal(published.state.stage, 'published');
  assert.equal(published.state.publishedAssets.length, 3);
  console.log('[smoke] full mission workflow passed');
} finally {
  child.kill();
  await rm(smokeRoot, { recursive: true, force: true });
}
