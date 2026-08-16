// 前台诊断：驱动真实 codex 两阶段，实时打印 advanceIteration 的 action/material/status。
// 用法：node scripts/dbg-two-phase.mjs
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { advanceIteration } from '../client-runtime/iteration-loop.mjs';

const execFileAsync = promisify(execFile);
const tmp = await mkdtemp(path.join(os.tmpdir(), 'dbg-two-phase-'));
const researchDir = path.join(tmp, 'research');
const sourceRoot = path.join(tmp, 'sources');
const workspace = path.join(tmp, 'workspace');
await mkdir(path.join(researchDir, 'notes'), { recursive: true });
await mkdir(path.join(researchDir, 'clones'), { recursive: true });
await mkdir(sourceRoot, { recursive: true });
await mkdir(workspace, { recursive: true });
await execFileAsync('git', ['init'], { cwd: workspace });
await execFileAsync('git', ['config', 'user.name', 'D'], { cwd: workspace });
await execFileAsync('git', ['config', 'user.email', 'd@l'], { cwd: workspace });
await writeFile(path.join(workspace, 'kernel.cu'), '// baseline\n', 'utf8');
await execFileAsync('git', ['add', '-A'], { cwd: workspace });
await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: workspace });

const codex = createCodexClient({ bridgeDir: path.join(tmp, 'bridge') });
const runtime = createAgentRuntime({ mode: 'codex-cli', codexClient: codex, codexWorkspace: workspace });
const mission = { id: 'MIS_DBG', title: 'dbg', goal: '迁移 flashinfer paged decode 到沐曦', hardware: ['MetAX C500'], metric: 'speedup', currentBest: { value: 'x' }, sourceRoot };
let state = { activeMissionId: 'MIS_DBG', missions: [mission], runtimeEvents: [], stage: 'diagnosis', patchApplied: false, candidateEvaluations: [], failureRecords: [], agent: { status: 'idle', runId: null }, researchAgent: null, researchNotes: [] };
const direction = '分析迁移 flashinfer paged decode 需要什么资料，拉进 Source Registry，不碰主工作区';
state = (await runtime.startResearch({ state, mission, direction, workspace: researchDir, synchronous: true, runPhase: 'acquire' })).state;
console.log('acquire runId:', state.researchAgent.runId);

const loopDeps = {
  startResearch: async (o) => (await runtime.startResearch(o)).state,
  cancelResearch: async ({ state, runId }) => (await runtime.cancelRun({ state, runId })).state,
  startMainRound: async ({ state }) => state,
  researchDirForMission: () => researchDir,
  countSources: async () => { const e = await readdir(sourceRoot).catch(() => []); return { count: e.filter((n) => n !== '.git').length }; },
  registerSources: async () => { const e = await readdir(sourceRoot).catch(() => []); return { count: e.filter((n) => n !== '.git').length }; },
};

const deadline = Date.now() + 8 * 60 * 1000;
let iter = 0;
while (Date.now() < deadline) {
  state = (await runtime.projectState(state)).state;
  const ra = state.researchAgent || {};
  const note = state.researchNotes?.[0];
  if ((note && ra.acquireRunId) || (ra.runPhase === 'acquire' && ra.acquireHandled && !ra.synthesizeRunId && !note)) { console.log('RESEARCH DONE. note:', !!note, 'phase:', ra.runPhase, 'status:', ra.status); break; }
  const looped = await advanceIteration(state, loopDeps);
  state = looped.state;
  const ra2 = state.researchAgent || {};
  iter += 1;
  if (iter % 5 === 1 || looped.action !== 'wait_research') {
    console.log(`[${Math.round((Date.now() - new Date(ra2.startedAt || Date.now()).getTime()) / 1000)}s] action=${looped.action} phase=${ra2.runPhase} status=${ra2.status} material=${ra2.materialCount || 0} grown=${ra2.materialLastGrownAt ? new Date(ra2.materialLastGrownAt).toISOString().slice(11, 19) : 'null'} syn=${ra2.synchronous}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('LOOP END. phase:', state.researchAgent?.runPhase, 'note:', !!state.researchNotes?.[0], 'status:', state.researchAgent?.status);
await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(0);
