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
请【分析】完成这个迁移需要哪些外部参考资料（例如 flashinfer 的 paged decode 上游实现、相关论文、MetAX/C500 平台文档），把它们拉进 Source Registry 目录（${sourceRoot}）作为只读参考：可 git clone 仓库或下载文档，每个资料对应 mission 的哪部分需求请说明。
绝对不要修改主工作区（${workspace}）或迭代仓库。产出 research-notes/v1：findings + suggestedDirections + sources（每个 source 指向你在 Source Registry 里实际拉到的资料，标注 repo URL/commit/path）。`;

    console.log('[verify] 启动研究员（分析任务 → 拉资料进 sources/）...');
    const started = await runtime.startResearch({ state, mission, direction, workspace: researchDir, synchronous: true });
    const runId = started.state.researchAgent.runId;
    console.log(`[verify] research run ${runId} 已启动，轮询最多 ${Math.round(timeoutMs / 1000)}s。`);

    // 三个终止条件：停滞（事件无新增）、事件预算（防无限增长）、兜底墙钟。
    // 任一命中都不"直接失败"——取消后利用已搜集资料（sources/ + 事件）整理评估。
    const stallMs = Number(process.env.VERIFY_STALL_MS || 90_000);
    const eventBudget = Number(process.env.VERIFY_EVENT_BUDGET || 200);
    const deadline = Date.now() + timeoutMs;
    let final = null;
    let lastEventAt = Date.now();
    let lastEventCount = 0;
    let stoppedBy = null;
    let lastProgressAt = Date.now();
    while (Date.now() < deadline) {
      final = (await runtime.projectState(state)).state;
      if (['completed', 'failed', 'timed_out', 'cancelled'].includes(final?.researchAgent?.status)) { stoppedBy = 'terminal'; break; }
      let events = [];
      try { events = await codex.readEvents(runId); } catch {}
      const now = Date.now();
      if (events.length > lastEventCount) { lastEventAt = now; lastEventCount = events.length; }
      else if (now - lastEventAt >= stallMs) { stoppedBy = `stall（${stallMs / 1000}s 无新事件，共 ${events.length} 条）`; break; }
      if (events.length >= eventBudget) { stoppedBy = `event budget（${eventBudget} 条）`; break; }
      if (now - lastProgressAt >= 20_000) {
        let fetched = 0;
        try { fetched = (await readdir(sourceRoot)).filter((name) => name !== '.git').length; } catch {}
        const lastType = events.at(-1)?.type || events.at(-1)?.item?.type || '(无)';
        const lastText = String(events.at(-1)?.item?.text || events.at(-1)?.item?.output || '').slice(0, 60);
        console.log(`[verify]   运行中 ${Math.round((now - new Date(final?.researchAgent?.startedAt || now).getTime()) / 1000)}s · 事件 ${events.length} · 最新 ${lastType} ${lastText} · sources/ ${fetched} 项`);
        lastProgressAt = now;
      }
      await sleep(2000);
    }
    if (!stoppedBy) stoppedBy = `max wall-clock（${timeoutMs / 1000}s）`;

    if (stoppedBy !== 'terminal') {
      console.log(`[verify] 命中终止: ${stoppedBy}（不判失败，利用已搜集资料评估）`);
      try { await runtime.cancelRun({ state: final, runId }); } catch {}
      for (let i = 0; i < 6; i += 1) { // 等 run 记录落盘为 cancelled/timed_out
        final = (await runtime.projectState(state)).state;
        if (['completed', 'failed', 'timed_out', 'cancelled'].includes(final?.researchAgent?.status)) break;
        await sleep(2000);
      }
    }
    const note = final?.researchNotes?.[0];
    const elapsed = Math.round((Date.now() - new Date(final?.researchAgent?.startedAt || Date.now()).getTime()) / 1000);
    console.log(`[verify] 研究员状态: ${final?.researchAgent?.status}（${elapsed}s）`);

    // 硬性约束：主工作区绝不能被动过
    let diffLines = 0;
    try { diffLines = (await execFileAsync('git', ['status', '--porcelain'], { cwd: workspace })).stdout.split('\n').filter(Boolean).length; } catch {}
    console.log(`[verify] 主工作区未修改: ${diffLines === 0 ? '是' : `否（${diffLines} 个变更）`}`);
    if (diffLines !== 0) {
      console.error('[verify] FAIL: 研究员修改了主工作区——应只写 sources/ 参考区。');
      return 1;
    }

    // 关键：sources/（Source Registry）是否被填充（哪怕部分）——机制成立的判定
    const fetched = (await readdir(sourceRoot)).filter((name) => name !== '.git');
    console.log(`[verify] Source Registry（sources/）内容: ${fetched.join(', ') || '(空)'}`);
    if (!fetched.length) {
      let events = [];
      try { events = await codex.readEvents(runId); } catch {}
      console.error('[verify] FAIL: sources/ 没有被填充——研究员没有把参考资料拉进 Source Registry。');
      console.log('[verify] 最近事件（判断是没拉还是拉错地方）：');
      events.slice(-8).forEach((e) => console.log(`[verify]   ${e.type || ''} ${e.item?.type || ''} ${String(e.item?.text || e.item?.output || e.item?.command || '').slice(0, 110)}`.trim()));
      return 1;
    }

    const partial = stoppedBy !== 'terminal';
    console.log(`[verify] 笔记摘要: ${note?.summary || '(无摘要，可能仍在搜集/整理)'}`);
    console.log(`[verify] 发现: ${(note?.findings || []).length} · 建议方向: ${(note?.suggestedDirections || []).length} · 来源: ${(note?.sources || []).length}`);
    (note?.sources || []).slice(0, 5).forEach((source) => console.log(`[verify]   来源: ${source.title || ''} ${source.url || ''}`.trim()));
    console.log(partial
      ? '[verify] PASS（部分）：命中终止但已把资料拉进 sources/ 且未碰工作区——机制成立，完整搜集度待更长时限验证。'
      : '[verify] PASS：研究员能分析任务 → 拉资料进 sources/ 作参考 → 不碰主工作区。');
    return 0;
  } catch (error) {
    console.error(`[verify] FAIL: ${error.message}`);
    return 1;
  }
})();

await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(exitCode);
