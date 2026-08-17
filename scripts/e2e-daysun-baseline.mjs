// 准备 PyTorch 基线参考：研究员拉 PyTorch 原生 paged decode（基线）+ flashinfer 源码 + daysun 平台参考 进 sources/。
// 先启动产品（remote 模式 codex-cli），再 node scripts/e2e-daysun-baseline.mjs <port>
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

const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-daysun-baseline-'));
const projectRoot = path.join(root, 'project');
await mkdir(projectRoot, { recursive: true });

const proj = await req('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'e2e-daysun-bl', root: projectRoot, initializeGit: true }) });
const mission = await req('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'e2e-daysun-bl', goal: '将 flashinfer 的 paged decode 算子迁移到天数智芯 Iluvatar MR-V100，达到相对 PyTorch 原生实现的加速比 ≥ 0.8，生成候选 Patch', projectId: proj.project.id, hardware: ['Iluvatar MR-V100'], metric: 'speedup vs PyTorch' }) });
const mid = mission.state.activeMissionId;
const m = mission.state.missions.find((x) => x.id === mid);
const sourceRoot = m.sourceRoot;
console.log('mission:', mid, '| sourceRoot:', sourceRoot);

// 研究员方向：PyTorch paged decode 基线 + flashinfer 源码 + daysun 平台参考
await req(`/api/missions/${mid}/research`, { method: 'POST', body: JSON.stringify({ direction: '这是迁移任务：把 flashinfer 的 paged decode 算子迁移到天数智芯 Iluvatar MR-V100，加速比相对 PyTorch 原生实现 ≥ 0.8。请拉取三类参考资料进 Source Registry：① PyTorch 原生 paged decode / scaled_dot_product_attention 或 attention 实现（作为加速比基线参照）② flashinfer 的 paged decode 源码 ③ 天数智芯 Iluvatar 平台参考（iluvatar-corex-ixrt / DeepSparkInference 等）。不要修改主工作区。' }) });
console.log('research triggered (PyTorch baseline direction).');

// 轮询研究完成（采集→综合→笔记）
const rDeadline = Date.now() + 18 * 60 * 1000;
let noteSeen = false;
while (Date.now() < rDeadline) {
  const s = (await req('/api/state')).state;
  const count = await countSources(sourceRoot);
  if (s.researchNotes?.length) { noteSeen = true; console.log(`  研究笔记产出（${s.researchNotes.length} 条）· sources ${count} 项`); break; }
  if (['completed', 'failed', 'timed_out'].includes(s.researchAgent?.status) && s.researchAgent?.runPhase === 'synthesize') break;
  await sleep(5000);
}
const finalCount = await countSources(sourceRoot);
console.log('research:', noteSeen ? 'done' : 'no-note', '| sources:', finalCount);
const entries = await readdir(sourceRoot).catch(() => []);
console.log('sources/ 内容:', entries.filter((n) => n !== '.git').join(', ') || '(空)');
// 保留临时目录供检查
if (!noteSeen) process.exit(1);
