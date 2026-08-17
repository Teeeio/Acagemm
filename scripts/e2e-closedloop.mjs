// 缺口 2 完整闭环：空项目 → 研究员拉 sources/ → preflight 放行 → 主 agent 迁移生成候选。
// 用法：先启动服务器（codex-cli），再 node scripts/e2e-closedloop.mjs <port>
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 4250);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (p, opts = {}) => {
  const r = await fetch(`${base}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${j.code || ''}: ${j.error || ''}`);
  return j;
};

const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-closedloop-'));
const projectRoot = path.join(root, 'project');
await mkdir(projectRoot, { recursive: true });

// 1. 空项目 + mission
const proj = await req('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'e2ecl', root: projectRoot, initializeGit: true }) });
const mission = await req('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'e2ecl', goal: '将 flashinfer 的 paged decode 算子迁移到沐曦平台并达到加速比 0.8+，生成候选 Patch', projectId: proj.project.id, hardware: ['MetAX C500'], metric: 'speedup ratio' }) });
const mid = mission.state.activeMissionId;
const m = mission.state.missions.find((x) => x.id === mid);
const sourceRoot = m.sourceRoot;
console.log('mission:', mid, '| sourceRoot:', sourceRoot);

// 2. 触发研究员（采集拉 sources/）
await req(`/api/missions/${mid}/research`, { method: 'POST', body: JSON.stringify({ direction: '分析迁移 flashinfer paged decode 需要什么参考资料，拉进 Source Registry（sources/），并继续整理成研究笔记' }) });
console.log('research triggered (two-phase acquire → synthesize).');

// 3. 等 sources/ 有资料 + 研究员完成（两阶段：采集→综合→笔记）
const deadline = Date.now() + 15 * 60 * 1000;
let sourcesSeen = 0;
let noteSeen = false;
while (Date.now() < deadline) {
  const st = await req('/api/state');
  const s = st.state;
  let count = 0;
  try { count = (await readdir(sourceRoot)).filter((n) => n !== '.git').length; } catch {}
  if (count !== sourcesSeen) { sourcesSeen = count; console.log(`  sources/ ${count} 项 · 研究 ${s.researchAgent?.runPhase} ${s.researchAgent?.status}`); }
  if (s.researchNotes?.length) { noteSeen = true; console.log(`  研究笔记产出（${s.researchNotes.length} 条）`); break; }
  if (['completed', 'failed', 'timed_out'].includes(s.researchAgent?.status) && s.researchAgent?.runPhase === 'synthesize') break;
  await sleep(5000);
}
console.log('research done:', noteSeen ? 'note produced' : `no note (sources ${sourcesSeen})`);

// 4. preflight（sources 有资料 → 应放行）
const pre = await req(`/api/runtime/preflight?missionId=${mid}`);
console.log('preflight:', pre.preflight.ready, pre.preflight.workspaceCheck.code);
if (!pre.preflight.ready) { console.log('FAIL: preflight 未放行'); await rm(root, { recursive: true, force: true }).catch(() => {}); process.exit(1); }

// 5. 启动主 run（主 agent 从 sources/ 迁移生成候选）
const run = await req(`/api/missions/${mid}/runs`, { method: 'POST', body: '{}' });
const runId = run.state.agent.runId;
console.log('main run:', runId, run.state.agent.status);

// 6. 轮询候选
const candDeadline = Date.now() + 10 * 60 * 1000;
let candidate = false;
while (Date.now() < candDeadline) {
  const st = await req('/api/state');
  const s = st.state;
  const a = s.agent || {};
  if (s.candidateEvaluations?.length) { candidate = true; console.log(`  候选生成: ${s.candidateEvaluations.length} 个（agent ${a.status}）`); break; }
  if (['completed', 'failed'].includes(a.status)) break;
  await sleep(5000);
}
console.log(candidate ? 'PASS: 主 agent 从 sources/ 迁移生成候选' : 'FAIL: 主 agent 未生成候选');
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(candidate ? 0 : 1);
