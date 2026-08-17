// 天数完整测试：空项目 → 研究员 → 主 agent 迁移到天数 → 候选 → apply-patch → 真实天数 runner benchmark → Gate。
// 先启动产品（OPERATOR_TEST_MODE=remote codex-cli），再 node scripts/e2e-daysun-benchmark.mjs <port>
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 4273);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (p, opts = {}) => {
  const r = await fetch(`${base}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${j.code || ''}: ${j.error || ''}`);
  return j;
};
const countSources = async (sourceRoot) => { try { return (await readdir(sourceRoot)).filter((n) => n !== '.git').length; } catch { return 0; } };

const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-daysun-'));
const projectRoot = path.join(root, 'project');
await mkdir(projectRoot, { recursive: true });

// 1. 空项目 + mission（目标：天数 Iluvatar）
const proj = await req('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'e2e-daysun', root: projectRoot, initializeGit: true }) });
const mission = await req('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'e2e-daysun', goal: '将 flashinfer 的 paged decode 算子迁移到天数智芯 Iluvatar MR-V100 平台并达到加速比 0.8+，生成候选 Patch', projectId: proj.project.id, hardware: ['Iluvatar MR-V100'], metric: 'speedup ratio' }) });
const mid = mission.state.activeMissionId;
const m = mission.state.missions.find((x) => x.id === mid);
const sourceRoot = m.sourceRoot;
console.log('mission:', mid, '| sourceRoot:', sourceRoot);

// 2. 触发研究员（采集天数参考资料）
await req(`/api/missions/${mid}/research`, { method: 'POST', body: JSON.stringify({ direction: '分析迁移 flashinfer paged decode 到天数智芯 Iluvatar 需要什么参考资料，拉进 Source Registry，并整理研究笔记' }) });
console.log('research triggered (two-phase).');

// 3. 等研究完成（采集→综合→笔记）+ preflight
const rDeadline = Date.now() + 18 * 60 * 1000;
let noteSeen = false;
while (Date.now() < rDeadline) {
  const s = (await req('/api/state')).state;
  const count = await countSources(sourceRoot);
  if (s.researchNotes?.length) { noteSeen = true; console.log(`  研究笔记产出（${s.researchNotes.length} 条）· sources ${count} 项`); break; }
  if (['completed', 'failed', 'timed_out'].includes(s.researchAgent?.status) && s.researchAgent?.runPhase === 'synthesize') break;
  await sleep(5000);
}
console.log('research:', noteSeen ? 'done' : `no-note (sources ${await countSources(sourceRoot)})`);

const pre = await req(`/api/runtime/preflight?missionId=${mid}`);
console.log('preflight:', pre.preflight.ready, pre.preflight.workspaceCheck.code);
if (!pre.preflight.ready) { console.log('FAIL: preflight 未放行'); process.exit(1); }

// 4. 主 run → 迁移候选
const run = await req(`/api/missions/${mid}/runs`, { method: 'POST', body: '{}' });
console.log('main run:', run.state.agent.runId, run.state.agent.status);
const cDeadline = Date.now() + 35 * 60 * 1000;
let candidate = false;
let lastProg = 0;
while (Date.now() < cDeadline) {
  const s = (await req('/api/state')).state;
  const a = s.agent || {};
  if (s.candidateEvaluations?.length) { candidate = true; console.log(`  候选生成: ${s.candidateEvaluations.length} 个（agent ${a.status}）`); break; }
  if (['completed', 'failed', 'awaiting_action'].includes(a.status)) break;
  const now = Date.now();
  if (now - lastProg >= 60_000) { console.log(`  [${Math.round((now - new Date(a.startedAt || now).getTime()) / 1000)}s] 主 agent ${a.status} · ${(a.phase || '').slice(0, 24)}`); lastProg = now; }
  await sleep(5000);
}
console.log('candidate:', candidate ? 'generated' : 'none');
if (!candidate) { console.log('FAIL: 主 agent 未生成候选'); process.exit(1); }

// 5. apply-patch
const cid = (await req('/api/state')).state.candidateEvaluations[0].id;
await req('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: cid }) });
console.log('applied patch:', cid);

// 6. start-benchmark → 真实天数 runner（operator=vector_add：runner 上可执行的 demo 算子，scope=demo-workspace/operator/vector_add）
const bench = await req('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ operator: 'vector_add', matrix: { environments: ['gpu-iluvatar-mainstream'], stages: ['Correctness', 'Full Benchmark'] } }) });
const benchRunId = bench.runId;
console.log('benchmark submitted:', benchRunId, '| task:', bench.taskId, '| mode:', bench.state.runtime.mode);

// 7. 轮询 benchmark → 真实结果
const bDeadline = Date.now() + 10 * 60 * 1000;
let benchDone = false;
while (Date.now() < bDeadline) {
  const s = (await req('/api/state')).state;
  const b = s.benchmark || {};
  console.log(`  bench ${b.status} progress ${b.progress}% · liveHardware=${b.result?.environment?.liveHardware}`);
  if (b.status === 'complete' || b.status === 'failed' || b.status === 'cancelled') { benchDone = true; break; }
  await sleep(8000);
}
console.log('benchmark:', benchDone ? (await req('/api/state')).state.benchmark.status : 'timeout');
const finalS = (await req('/api/state')).state;
const b2 = finalS.benchmark || {};
if (b2.result?.benchmark?.length) {
  const m = b2.result.benchmark[0];
  console.log(`  天数实测: ${m.environment} ${m.value}${m.unit} · correctness ${m.correctness.passed}/${m.correctness.total} · liveHardware=${b2.result.environment.liveHardware}`);
}
console.log('stage:', finalS.stage, '| decision:', finalS.decisionReview?.status);
await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(benchDone && b2.status === 'complete' ? 0 : 1);
