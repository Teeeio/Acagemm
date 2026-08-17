// 天数测试 resume：现有 mission（研究已做、preflight 已过）→ 重跑主 run → 候选 → apply-patch → 真实天数 benchmark。
// 用法：node scripts/e2e-daysun-resume.mjs <port>
const port = Number(process.argv[2] || 4273);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (p, opts = {}) => {
  const r = await fetch(`${base}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${j.code || ''}: ${j.error || ''}`);
  return j;
};

const st = (await req('/api/state')).state;
const mid = st.activeMissionId;
console.log('mission:', mid, '| agent:', st.agent?.status);

// 1. 重跑主 run（codex 已恢复）
const run = await req(`/api/missions/${mid}/runs`, { method: 'POST', body: '{}' });
console.log('main run:', run.state.agent.runId, run.state.agent.status);

// 2. 等候选
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

// 3. apply-patch
const cid = (await req('/api/state')).state.candidateEvaluations[0].id;
await req('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: cid }) });
console.log('applied patch:', cid);

// 4. start-benchmark → 真实天数 runner（operator=vector_add：runner 可执行的 demo 算子）
const bench = await req('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ operator: 'vector_add', matrix: { environments: ['gpu-iluvatar-mainstream'], stages: ['Correctness', 'Full Benchmark'] } }) });
console.log('benchmark submitted:', bench.runId, '| task:', bench.taskId);

// 5. 轮询 benchmark
const bDeadline = Date.now() + 10 * 60 * 1000;
let benchDone = false;
while (Date.now() < bDeadline) {
  const s = (await req('/api/state')).state;
  const b = s.benchmark || {};
  console.log(`  bench ${b.status} progress ${b.progress}% · liveHardware=${b.result?.environment?.liveHardware}`);
  if (b.status === 'complete' || b.status === 'failed' || b.status === 'cancelled') { benchDone = true; break; }
  await sleep(8000);
}
const finalS = (await req('/api/state')).state;
const b2 = finalS.benchmark || {};
if (b2.result?.benchmark?.length) {
  const m = b2.result.benchmark[0];
  console.log(`  天数实测: ${m.environment} ${m.value}${m.unit} · correctness ${m.correctness.passed}/${m.correctness.total} · liveHardware=${b2.result.environment.liveHardware}`);
}
console.log('stage:', finalS.stage, '| decision:', finalS.decisionReview?.status);
process.exit(benchDone && b2.status === 'complete' ? 0 : 1);
