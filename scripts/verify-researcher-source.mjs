// 验证：研究员能否"分析 mission → 自主决定需要什么外部资料 → 拉进 Source Registry（sources/）作参考 → 不碰主工作区"。
// 需要本机 codex-cli 已登录 + 有网。运行：npm run verify:researcher-source
//
// 退出码：0 = PASS；1 = FAIL；2 = codex 不可用。

import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { advanceIteration } from '../client-runtime/iteration-loop.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MS || 600_000); // 兜底墙钟（停滞/事件预算优先触发）
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-researcher-source-'));
const exitCode = await (async () => {
  try {
    console.log('[verify] 检测本机 Codex...');
    const codex = createCodexClient({ bridgeDir: path.join(tmp, 'bridge') });
    const descriptor = await codex.describe();
    if (!descriptor.installed) {
      console.error('[verify] FAIL: 未检测到 codex CLI。');
      return 2;
    }
    if (!descriptor.loggedIn) console.warn('[verify] WARN: codex 未检测到登录态，真实调用可能失败。');

    // 布局：sources/ = Source Registry（研究员应往这里拉参考）；workspace/ = 主工作区（研究员绝不能碰）
    const researchDir = path.join(tmp, 'research');
    const sourceRoot = path.join(tmp, 'sources');
    const workspace = path.join(tmp, 'workspace');
    await mkdir(path.join(researchDir, 'notes'), { recursive: true });
    await mkdir(path.join(researchDir, 'clones'), { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.name', 'Verify'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.email', 'verify@local.invalid'], { cwd: workspace });
    await writeFile(path.join(workspace, 'kernel.cu'), '// workspace baseline\n', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: workspace });
    await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: workspace });

    const mission = {
      id: 'MIS_VERIFY',
      title: 'Verify researcher source-fetch',
      goal: '迁移 flashinfer 的 paged decode 算子到沐曦平台并达到加速比 0.8+',
      hardware: ['MetAX C500'],
      metric: 'speedup ratio',
      currentBest: { value: '47.0 μs' },
      sourceRoot,
    };
    const state = {
      activeMissionId: 'MIS_VERIFY',
      missions: [mission],
      runtimeEvents: [],
      stage: 'diagnosis',
      patchApplied: false,
      candidateEvaluations: [],
      failureRecords: [],
      agent: { status: 'idle', runId: null },
      researchAgent: null,
      researchNotes: [],
    };
    const runtime = createAgentRuntime({ mode: 'codex-cli', codexClient: codex, codexWorkspace: workspace });

    // 分析式方向：不点名 clone 哪个仓库，要求研究员自己判断需要什么资料并拉进 Source Registry
    const direction = `这是 mission 目标：${mission.goal}。
请在 ${Math.round(timeoutMs / 1000)} 秒内完成，只访问公开来源。
请【分析】完成这个迁移需要哪些外部参考资料（例如 flashinfer 的 paged decode 上游实现、相关论文、MetAX/C500 平台文档），把它们拉进 Source Registry 目录（${sourceRoot}）作为只读参考：可 git clone 仓库或下载文档。
绝对不要修改主工作区（${workspace}）或迭代仓库。`;

    // 用循环编排器驱动两阶段（采集 → 综合），保证笔记总能被综合阶段写出
    const loopDeps = {
      startResearch: async ({ state, mission, direction, workspace: ws, synchronous, runPhase }) => {
        try {
          return (await runtime.startResearch({ state, mission, direction, workspace: ws, synchronous, runPhase })).state;
        } catch (error) {
          console.error(`[verify]   startResearch(${runPhase}) 失败: ${error.message}`);
          return state;
        }
      },
      cancelResearch: async ({ state, runId }) => {
        try { return (await runtime.cancelRun({ state, runId })).state; } catch (error) { console.error(`[verify]   cancelRun 失败: ${error.message}`); return state; }
      },
      startMainRound: async ({ state }) => state,
      researchDirForMission: () => researchDir,
      registerSources: async ({ state, mission }) => {
        const entries = await readdir(sourceRoot).catch(() => []);
        return { count: entries.filter((name) => name !== '.git').length };
      },
      countSources: async () => {
        const entries = await readdir(sourceRoot).catch(() => []);
        return { count: entries.filter((name) => name !== '.git').length };
      },
    };

    console.log('[verify] 启动研究员两阶段（采集 → 综合）...');
    let runState = (await runtime.startResearch({ state, mission, direction, workspace: researchDir, synchronous: true, runPhase: 'acquire' })).state;
    const acquireRunId = runState.researchAgent.runId;
    console.log(`[verify] 采集 run ${acquireRunId} 已启动，驱动循环最多 ${Math.round(timeoutMs / 1000)}s。`);

    let deadline = Date.now() + timeoutMs;
    let lastProgressAt = Date.now();
    let stoppedBy = null;
    let seenPhase = 'acquire';
    while (Date.now() < deadline) {
      runState = (await runtime.projectState(runState)).state;
      const ra = runState.researchAgent || {};
      const note = runState.researchNotes?.[0];
      // 研究完成：综合阶段已产出笔记，或采集无资料已结束
      if ((note && ra.acquireRunId) || (ra.runPhase === 'acquire' && ra.acquireHandled && !ra.synthesizeRunId && !note)) { stoppedBy = 'research_done'; break; }
      // 转入综合阶段时重置预算窗口：采集时长不吃掉综合的写笔记时间
      if (ra.runPhase === 'synthesize' && seenPhase !== 'synthesize') {
        seenPhase = 'synthesize';
        console.log(`[verify] 进入综合阶段，重置窗口 ${Math.round(Math.min(timeoutMs, 5 * 60 * 1000) / 1000)}s`);
        deadline = Date.now() + Math.min(timeoutMs, 5 * 60 * 1000);
      }
      const looped = await advanceIteration(runState, loopDeps);
      runState = looped.state;
      if (['research_no_material', 'needs_human', 'completed', 'paused', 'disabled'].includes(looped.action)) { stoppedBy = looped.action; break; }
      const now = Date.now();
      if (now - lastProgressAt >= 20_000) {
        let fetched = 0;
        try { fetched = (await readdir(sourceRoot)).filter((name) => name !== '.git').length; } catch {}
        console.log(`[verify]   运行中 ${Math.round((now - new Date(ra.startedAt || now).getTime()) / 1000)}s · 阶段 ${ra.runPhase || '?'} · sources/ ${fetched} 项 · 笔记 ${runState.researchNotes?.length || 0}`);
        lastProgressAt = now;
      }
      await sleep(2000);
    }
    if (!stoppedBy) stoppedBy = `max wall-clock（${timeoutMs / 1000}s）`;
    console.log(`[verify] 终止: ${stoppedBy}`);

    const ra = runState.researchAgent || {};
    const note = runState.researchNotes?.[0];

    // 硬性约束：主工作区绝不能被动过
    let diffLines = 0;
    try { diffLines = (await execFileAsync('git', ['status', '--porcelain'], { cwd: workspace })).stdout.split('\n').filter(Boolean).length; } catch {}
    console.log(`[verify] 主工作区未修改: ${diffLines === 0 ? '是' : `否（${diffLines} 个变更）`}`);
    if (diffLines !== 0) {
      console.error('[verify] FAIL: 研究员修改了主工作区——应只写 sources/ 参考区。');
      return 1;
    }

    // 关键：sources/（Source Registry）是否被填充
    const fetched = (await readdir(sourceRoot)).filter((name) => name !== '.git');
    console.log(`[verify] Source Registry（sources/）内容: ${fetched.join(', ') || '(空)'}`);
    if (!fetched.length) {
      console.error('[verify] FAIL: sources/ 没有被填充——研究员没有把参考资料拉进 Source Registry。');
      return 1;
    }

    // 笔记必须由综合阶段产出（两阶段的保证）
    console.log(`[verify] 研究阶段: ${ra.runPhase} · 笔记数: ${runState.researchNotes?.length || 0}`);
    if (!note) {
      console.error('[verify] FAIL: 未产出研究笔记（两阶段综合应保证写出）。');
      return 1;
    }
    console.log(`[verify] 笔记摘要: ${note.summary || '(无摘要)'}`);
    console.log(`[verify] 发现: ${(note.findings || []).length} · 建议方向: ${(note.suggestedDirections || []).length} · 来源: ${(note.sources || []).length}`);
    (note.sources || []).slice(0, 5).forEach((source) => console.log(`[verify]   来源: ${source.title || ''} ${source.url || ''}`.trim()));
    console.log('[verify] PASS：研究员两阶段（采集拉资料进 sources/ → 综合写笔记）完成，且未碰主工作区。');
    return 0;
  } catch (error) {
    console.error(`[verify] FAIL: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'));
    return 1;
  }
})();

await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(exitCode);
