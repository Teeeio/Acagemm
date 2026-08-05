import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAuditEvent,
  applyCandidatePatch,
  createMission,
  ensureStorage,
  loadState,
  resetDemoData,
  saveState,
  selectMission,
  startAgentRun,
  workspaceFiles,
} from './state-store.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const distDir = path.join(rootDir, 'dist');
const port = Number(process.env.API_PORT || process.env.PORT || 4173);
const serveWeb = process.env.SERVE_WEB !== 'false';

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(JSON.stringify(payload));
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const guardMutation = (state) => {
  if (state.missionPaused) {
    const error = new Error('Mission 已暂停，请先恢复任务。');
    error.status = 409;
    throw error;
  }
};

const toKnowledgeAsset = (draft) => {
  const hardwareKeys = draft.hardware.map((item) => ({ C500: 'c500', CUDA: 'nvidia', 'ROCm MI300': 'amd' }[item])).filter(Boolean);
  return { id: draft.id, kind: 'Experience', version: 'v1.0', title: draft.title, description: draft.conclusion, tags: [draft.category, ...draft.hardware, 'Level 3'], tone: 'ochre', icon: 'Lightbulb', hardwareKeys, scope: draft.scope, permissions: 'organization:read', evidence: draft.evidence, updated: new Date().toISOString().slice(0, 10) };
};

const validateKnowledgeDraft = (draft) => {
  if (!draft?.id || !draft.title?.trim() || !draft.conclusion?.trim() || !Array.isArray(draft.hardware) || !draft.hardware.length) {
    const error = new Error('知识草稿缺少标题、结论或适配硬件。');
    error.status = 400;
    throw error;
  }
};

async function handleApi(request, response, url) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    json(response, 200, { status: 'ok', service: 'operator-studio-mock', persistence: 'disk', time: new Date().toISOString() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    json(response, 200, { state: await loadState() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/workspace') {
    const state = await loadState();
    json(response, 200, { patchApplied: state.patchApplied, workspace: 'runtime/mla-kernels', files: workspaceFiles });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/missions') {
    const state = await loadState();
    json(response, 200, { missions: state.missions, activeMissionId: state.activeMissionId });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/missions') {
    const state = await loadState();
    guardMutation(state);
    const body = await readJson(request);
    if (!body.goal?.trim()) {
      json(response, 400, { error: '请输入一个可执行的优化目标。' });
      return;
    }
    json(response, 201, { state: await saveState(createMission(state, body)) });
    return;
  }
  const missionRunMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs$/);
  if (request.method === 'POST' && missionRunMatch) {
    const state = await loadState();
    guardMutation(state);
    const missionId = decodeURIComponent(missionRunMatch[1]);
    if (state.activeMissionId !== missionId) selectMission(state, missionId);
    const body = await readJson(request);
    const mission = state.missions.find((item) => item.id === missionId);
    json(response, 202, { state: await saveState(startAgentRun(state, body.goal?.trim() || mission.goal)) });
    return;
  }
  const missionSelectMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/select$/);
  if (request.method === 'POST' && missionSelectMatch) {
    const state = await loadState();
    const missionId = decodeURIComponent(missionSelectMatch[1]);
    json(response, 200, { state: await saveState(selectMission(state, missionId)) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/apply-patch') {
    const state = await loadState();
    guardMutation(state);
    const workspace = await applyCandidatePatch();
    state.patchApplied = true;
    state.stage = 'validation';
    state.agent = {
      ...state.agent,
      status: 'awaiting_approval',
      phase: '异构验证',
      currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '运行 C500 + CUDA 测试矩阵', reason: '候选补丁已写入隔离工作区，需要先验证正确性和完整性能。', expectedOutput: '24 / 24 Correctness · 2 个 Full Benchmark Run', risk: 'medium', approvalRequired: true },
      messages: [...(state.agent?.messages || []), { id: `patch-${Date.now()}`, phase: 'approval', status: 'completed', title: 'Candidate Patch 已获批准', detail: '补丁已写入隔离工作区，等待提交测试矩阵。', time: '刚刚' }],
    };
    addAuditEvent(state, 'Patch 审批通过并写入隔离工作区', `${workspace.workspace} · Candidate 02`, 'green', 'ShieldCheck');
    json(response, 200, { state: await saveState(state), workspace });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/start-benchmark') {
    const state = await loadState();
    guardMutation(state);
    if (!state.patchApplied) {
      json(response, 409, { error: '请先应用候选补丁。' });
      return;
    }
    const runId = `run_${Date.now().toString(36).toUpperCase()}`;
    state.stage = 'validation';
    state.benchmark = { status: 'running', progress: 0, runId, startedAt: new Date().toISOString(), completedAt: null, durationMs: 2600, logs: [{ sequence: 1, progress: 0, message: '调度器已锁定 2 个环境快照' }] };
    state.agent = { ...state.agent, status: 'executing', phase: '异构验证', currentAction: null, messages: [...(state.agent?.messages || []), { id: `test-${runId}`, phase: 'validation', status: 'running', title: 'Validation Agent 已提交测试矩阵', detail: `${runId} 正在两个固定环境中执行。`, time: '刚刚' }] };
    addAuditEvent(state, 'Full Benchmark 已提交', `${runId} · ${state.testMatrix.environments.length} environments`, 'blue', 'TestTube2');
    json(response, 202, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/adopt') {
    const state = await loadState();
    guardMutation(state);
    if (state.benchmark.status !== 'complete') {
      json(response, 409, { error: 'Full Benchmark 尚未完成。' });
      return;
    }
    const body = await readJson(request);
    state.stage = 'curation';
    state.agent = { ...state.agent, status: 'awaiting_approval', phase: '知识沉淀', currentAction: { id: 'action.knowledge-publish', type: 'knowledge.publish', title: '审阅并发布本次优化经验', reason: '候选已经采用，需要把适用范围、约束和证据固化为可检索资产。', expectedOutput: '3 条 Experience Draft · fixed evidence', risk: 'low', approvalRequired: true } };
    addAuditEvent(state, 'Candidate 02 已采用', `Level 3 · ${body.note || 'approved'}`, 'green', 'CheckCircle2');
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/reject') {
    const state = await loadState();
    guardMutation(state);
    state.stage = 'validation';
    state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
    addAuditEvent(state, '候选退回验证', 'Candidate 02 · 需要补充验证', 'warning', 'TriangleAlert');
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'PATCH' && url.pathname.startsWith('/api/knowledge/drafts/')) {
    const state = await loadState();
    guardMutation(state);
    const draftId = decodeURIComponent(url.pathname.slice('/api/knowledge/drafts/'.length));
    const body = await readJson(request);
    const index = state.knowledgeDrafts.findIndex((draft) => draft.id === draftId);
    if (index === -1) {
      json(response, 404, { error: '知识草稿不存在。' });
      return;
    }
    state.knowledgeDrafts[index] = { ...state.knowledgeDrafts[index], ...body, id: draftId };
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/publish') {
    const state = await loadState();
    guardMutation(state);
    const draft = await readJson(request);
    validateKnowledgeDraft(draft);
    const asset = toKnowledgeAsset(draft);
    state.publishedAssets = [asset, ...state.publishedAssets.filter((item) => item.id !== asset.id)];
    if (state.publishedAssets.length >= state.knowledgeDrafts.length) state.stage = 'published';
    addAuditEvent(state, '组织经验已发布', `${asset.id}@${asset.version}`, 'green', 'BookOpen');
    json(response, 200, { state: await saveState(state), asset });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/publish-all') {
    const state = await loadState();
    guardMutation(state);
    const body = await readJson(request);
    const drafts = Array.isArray(body.drafts) ? body.drafts : state.knowledgeDrafts;
    drafts.forEach(validateKnowledgeDraft);
    state.publishedAssets = drafts.map(toKnowledgeAsset);
    state.stage = 'published';
    state.agent = { ...state.agent, status: 'completed', phase: 'Mission 完成', currentAction: null };
    addAuditEvent(state, '任务知识资产集已发布', `${state.publishedAssets.length} Experiences · fixed versions`, 'green', 'BookOpen');
    json(response, 200, { state: await saveState(state), assets: state.publishedAssets });
    return;
  }
  if (request.method === 'PATCH' && url.pathname === '/api/state') {
    const state = await loadState();
    const body = await readJson(request);
    if (body.testMatrix && (!Array.isArray(body.testMatrix.environments) || !body.testMatrix.environments.length || !Array.isArray(body.testMatrix.stages) || !body.testMatrix.stages.length)) {
      json(response, 400, { error: '测试矩阵至少需要一个环境和一个验证阶段。' });
      return;
    }
    for (const key of ['testMatrix', 'workspace', 'unreadCount', 'missionPaused']) {
      if (Object.hasOwn(body, key)) state[key] = body[key];
    }
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/reset') {
    json(response, 200, { state: await resetDemoData() });
    return;
  }
  json(response, 404, { error: 'API endpoint not found.' });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };

async function serveStatic(response, url) {
  if (!serveWeb) {
    json(response, 404, { error: 'Web serving disabled in API-only mode.' });
    return;
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  let target = path.resolve(distDir, requested);
  if (!target.startsWith(distDir)) {
    json(response, 403, { error: 'Forbidden path.' });
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error('not a file');
  } catch {
    target = path.join(distDir, 'index.html');
  }
  const content = await readFile(target);
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
  response.end(content);
}

await ensureStorage();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(response, url);
  } catch (error) {
    console.error('[mock-server]', error);
    json(response, error.status || 500, { error: error.message || 'Internal server error.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[operator-studio] ${serveWeb ? 'web + api' : 'api'} listening on http://127.0.0.1:${port}`);
});
