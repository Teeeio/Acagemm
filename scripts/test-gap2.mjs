// 缺口 2 验证：空项目 + 研究员拉 sources/ → preflight 放行 → 主 run 可启动。
// 用法：先启动服务器（codex-cli），再 node scripts/test-gap2.mjs <port>
// 用 Node 原生 fetch 避免 bash 中文路径转义问题。
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 4243);
const base = `http://127.0.0.1:${port}`;
const req = async (p, opts = {}) => {
  const r = await fetch(`${base}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${j.code || ''}: ${j.error || ''}`);
  return j;
};

const root = await mkdtemp(path.join(os.tmpdir(), 'gap2-test-'));
const projectRoot = path.join(root, 'project');
await mkdir(projectRoot, { recursive: true });

// 1. 建空项目 + mission（路径走 API，Node 正确处理 Unicode）
const proj = await req('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'gap2-test', root: projectRoot, initializeGit: true }) });
const projectId = proj.project.id;
console.log('project:', projectId, '| sourceRoot:', proj.project.sourceRoot);
const mission = await req('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'gap2', goal: '迁移 flashinfer paged decode 算子到沐曦平台并达到加速比 0.8+', projectId, hardware: ['MetAX C500'], metric: 'speedup' }) });
const missionId = mission.state.activeMissionId;
console.log('mission:', missionId);
const m = mission.state.missions.find((x) => x.id === missionId);
console.log('mission.sourceRoot:', m.sourceRoot);

// 2. sources/ 为空时 → preflight 应阻断（WORKSPACE_BASELINE_EMPTY）
const blocked = await req(`/api/runtime/preflight?missionId=${missionId}`);
console.log('preflight (empty sources):', blocked.preflight.ready, blocked.preflight.workspaceCheck.code);

// 3. 模拟研究员往 sources/ 拉资料（写一个参考文件）
await mkdir(m.sourceRoot, { recursive: true });
await writeFile(path.join(m.sourceRoot, 'flashinfer-reference.cu'), '// flashinfer paged decode reference\n', 'utf8');

// 4. sources/ 有资料后 → preflight 应放行（WORKSPACE_READY，从参考迁移）
const allowed = await req(`/api/runtime/preflight?missionId=${missionId}`);
console.log('preflight (sources populated):', allowed.preflight.ready, allowed.preflight.workspaceCheck.code);

// 5. 主 run 应可启动（codex-cli；若联网会真跑，这里只验证 preflight 通过）
console.log(allowed.preflight.ready ? 'PASS: 空项目 + sources 有资料 → preflight 放行，主 agent 可从 sources 迁移' : 'FAIL: preflight 未放行');

process.exit(allowed.preflight.ready ? 0 : 1);
