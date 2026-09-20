// 验证：研究员能否"分析 mission → 自主决定需要什么外部资料 → 拉进 Source Registry（sources/）作参考 → 不碰主工作区"。
//
// 本脚本证明的是：两阶段研究（采集 → 综合）在真实 CLI 下能完成，sources/ 被填充，笔记被写出，
// 且主工作区未被修改。
// 本脚本【不】证明：研究材料实际进入了目标轮次的 prompt，也不证明任何 GPU / 性能收益。
// 材料交付链路（选择 → 冻结 prompt → 提交执行端、preflight 失败不丢材料、不重复拼接）由
// `npm run test:research-delivery` 用真实编排路径 + mock 模型与仓库获取覆盖。
// 需要本机 Agent CLI 可用 + 有网。运行：npm run verify:researcher-source
//   VERIFY_AGENT_RUNTIME=codex-cli（默认）| claude-code
// claude-code 走本机的 Anthropic 兼容层（ANTHROPIC_BASE_URL 指向的本地代理），
// 真实应答模型由该兼容层的配置决定，不由本脚本选择。
//
// 退出码：0 = PASS；1 = FAIL；2 = Agent CLI 不可用。

import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
import { createClaudeClient } from '../client-runtime/claude-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { advanceIteration } from '../client-runtime/iteration-loop.mjs';
import { acquireSelectedSources } from '../client-runtime/agent-runtime.mjs';
import { createSourceAcquisitionService } from '../client-runtime/application/source-acquisition-service.mjs';
import { loadSourceMirrorPolicy } from '../client-runtime/source-mirror-policy.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MS || 600_000); // 兜底墙钟（停滞/事件预算优先触发）
// 运行时通过兼容层切换：默认保持既有 codex-cli 行为，显式设置才走 claude-code。
const runtimeMode = process.env.VERIFY_AGENT_RUNTIME || 'codex-cli';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = await mkdtemp(path.join(os.tmpdir(), 'verify-researcher-source-'));
const exitCode = await (async () => {
  try {
    const bridgeDir = path.join(tmp, 'bridge');
    console.log(`[verify] 运行时 = ${runtimeMode}；检测本机 Agent CLI...`);
    const client = runtimeMode === 'claude-code'
      ? createClaudeClient({ bridgeDir })
      : createCodexClient({ bridgeDir });
    const descriptor = await client.describe();
    if (!descriptor.installed) {
      console.error(`[verify] FAIL: 未检测到 ${runtimeMode} CLI。`);
      return 2;
    }
    if (!descriptor.loggedIn) console.warn(`[verify] WARN: ${runtimeMode} 未检测到登录态；若走本地兼容层可忽略。`);

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
      hardware: ['MetaX C550'],
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
    const runtime = createAgentRuntime({
      mode: runtimeMode,
      ...(runtimeMode === 'claude-code' ? { claudeClient: client } : { codexClient: client }),
      codexWorkspace: workspace,
      bridgeDir,
    });

    // 分析式方向：不点名 clone 哪个仓库。研究员只负责"选"，固定工作流负责"拉"——
    // 与生产契约一致：Source Registry 对研究员是只读的，clone 由 deps.acquireSources 执行。
    const direction = `这是 mission 目标：${mission.goal}。
请在 ${Math.round(timeoutMs / 1000)} 秒内完成，只访问公开来源。
请【分析】完成这个迁移需要哪些外部参考资料（例如 flashinfer 的 paged decode 上游实现、相关论文、MetaX/C550 平台文档）。
Source Registry（${sourceRoot}）对你是只读的：你只负责按平台提供的清单【选择】来源，不要自己 clone，也不要写任何文件进去。
按采集阶段的 JSON 契约返回被选中的仓库（含 name、location、可访问的 HTTPS url、reason，以及仓库内相对路径的 evidencePaths）。
绝对不要修改主工作区（${workspace}）、Source Registry 或迭代仓库。`;

    // 与生产组合根一致：来源获取走迭代推进路径的注入端口，不在状态投影里做。
    const sourceAcquisitionService = createSourceAcquisitionService({
      agentRuntime: runtime, readdir, acquireSelectedSources,
      sourceMirrorPolicy: () => loadSourceMirrorPolicy({ configPath: process.env.OPERATOR_SOURCE_MIRROR_CONFIG }),
    });
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
      acquireSources: sourceAcquisitionService.acquireSources,
      countRunSources: async ({ state }) => ({
        count: Number(state.researchAgent?.acquisition?.sourceCount) || 0,
        failures: Number(state.researchAgent?.acquisition?.failureCount) || 0,
        runId: state.researchAgent?.acquisition?.runId || null,
      }),
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
      if (looped.action !== 'wait_research') console.log(`[verify]   action=${looped.action} raPhase=${ra.runPhase} status=${ra.status} material=${ra.materialCount || 0} grownAt=${ra.materialLastGrownAt ? new Date(ra.materialLastGrownAt).toISOString().slice(11, 19) : 'null'}`);
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

    // 可定位的失败原因：解析/来源策略/获取失败各自给出细分原因码，不再只有「没材料」。
    if (ra.acquisition) {
      console.log(`[verify] 采集落账: status=${ra.acquisitionStatus || '?'} sources=${ra.acquisition.sourceCount} failures=${ra.acquisition.failureCount} reasonCode=${ra.acquisition.reasonCode || '-'}`);
      for (const failure of (ra.acquisition.failures || []).slice(0, 3)) console.log(`[verify]   来源失败 ${failure.code}: ${String(failure.detail || '').slice(0, 240)}`);
    }
    if (note) {
      console.log(`[verify] 结果定位: outcome=${note.outcome || '-'} reasonCode=${note.resultReasonCode || '-'} ${String(note.resultReason || '').slice(0, 200)}`);
      for (const rejected of (note.extraction?.rejected || []).slice(0, 3)) console.log(`[verify]   候选被拒（${rejected.source}）: ${String(rejected.reason || '').slice(0, 160)}`);
    }

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
    // 交付诚实性：材料只能处于显式交付阶段；researchAgent.injected 不得在没有绑定 run 时被置为 true。
    const injection = ra.injection || {};
    const boundDigest = runState.agent?.researchAdvisory?.digest || null;
    const claimedInjected = runState.researchAgent?.injected === true;
    const pending = runState.iterationStats?.pendingInjection || null;
    console.log(`[verify] 交付阶段: ${injection.status || (pending ? pending.stage : 'none')} · 待交付材料: ${pending ? 1 : 0}`);
    if (claimedInjected && !boundDigest) {
      console.error('[verify] FAIL: researchAgent.injected 在没有任何绑定 run 的情况下被置为 true——不得显示已注入却未交付。');
      return 1;
    }
    if (pending && !['available', 'selected', 'prepared', 'uncertain'].includes(pending.stage)) {
      console.error(`[verify] FAIL: 待交付材料处于未知阶段 ${pending.stage}。`);
      return 1;
    }
    console.log('[verify] PASS：研究员两阶段（采集拉资料进 sources/ → 综合写笔记）完成，且未碰主工作区。');
    console.log('[verify] 注意：本脚本不验证材料进入目标轮次 prompt，也不验证任何 GPU/性能收益；交付链路见 npm run test:research-delivery。');
    return 0;
  } catch (error) {
    console.error(`[verify] FAIL: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'));
    return 1;
  }
})();

await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(exitCode);
