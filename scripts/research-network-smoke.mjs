// 真实联网研究员 Smoke —— 需要本机 codex-cli 已登录且可访问网络。
//
// 用途：验证研究员子 Agent 在真实 Codex + 网络下确实能拉取外部资料并产出带来源的调研笔记。
// 这不是自动化测试（不能进 CI）；运行前请确认本机 codex 可用：
//   codex --version
// 然后运行：
//   npm run research:smoke
//
// 设计：白名单方向（只读公开论文/文档）+ 短时限外部超时（默认 90s），避免长任务。
// 退出码：0 = PASS（研究员产出带来源笔记）；1 = FAIL；2 = codex 不可用。

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexClient } from '../client-runtime/codex-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.env.RESEARCH_SMOKE_TIMEOUT_MS || 300_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = await mkdtemp(path.join(os.tmpdir(), 'research-network-smoke-'));
const exitCode = await (async () => {
  try {
    console.log('[research-smoke] 检测本机 Codex...');
    const codex = createCodexClient({ bridgeDir: path.join(tmp, 'bridge') });
    const descriptor = await codex.describe();
    if (!descriptor.installed) {
      console.error('[research-smoke] FAIL: 未检测到 codex CLI，请先 `npm i -g @openai/codex` 或确认 codex 在 PATH。');
      return 2;
    }
    if (!descriptor.loggedIn) {
      console.warn('[research-smoke] WARN: codex 未检测到官方登录态（login status 非 detected）；真实调用可能因缺认证失败。');
    } else {
      console.log('[research-smoke] codex 就绪（已检测到登录态）。');
    }

    const researchDir = path.join(tmp, 'research');
    await mkdir(path.join(researchDir, 'notes'), { recursive: true });
    await mkdir(path.join(researchDir, 'clones'), { recursive: true });

    const mission = {
      id: 'MIS_SMOKE',
      title: 'Research network smoke',
      goal: '优化 MLA paged_attention 算子在 C550 上的 small batch 延迟',
      hardware: ['C550'],
      metric: 'latency_p50',
      currentBest: { value: '47.0 μs' },
      sourceRoot: null,
    };
    const state = {
      activeMissionId: 'MIS_SMOKE',
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
    const runtime = createAgentRuntime({ mode: 'codex-cli', codexClient: codex, codexWorkspace: path.join(tmp, 'workspace') });

    // 白名单方向：只读公开来源，限时内完成，范围收窄以控制在几分钟内，产出带来源的笔记
    const direction = `请在 ${Math.round(timeoutMs / 1000)} 秒内完成，只访问公开来源（arXiv、GitHub 公开仓库、官方文档），只检索并概括 2-3 个来源，不要展开长任务。
研究方向：paged_attention / MLA KV cache 在 small batch 下的延迟优化有哪些被验证的做法？
要求：给出最可能直接收益的方向；产出 research-notes/v1（含 sources 来源，来源 2-3 个即可）。`;

    console.log('[research-smoke] 启动研究员（真实 Codex，开放沙箱联网）...');
    const started = await runtime.startResearch({ state, mission, direction, workspace: researchDir });
    const runId = started.state.researchAgent.runId;
    console.log(`[research-smoke] research run ${runId} 已启动，轮询最多 ${Math.round(timeoutMs / 1000)}s。`);

    const deadline = Date.now() + timeoutMs;
    let final = null;
    let lastProgressAt = Date.now();
    let lastEventCount = 0;
    while (Date.now() < deadline) {
      final = (await runtime.projectState(state)).state;
      const statusNow = final?.researchAgent?.status || 'running';
      if (['completed', 'failed', 'timed_out', 'cancelled'].includes(statusNow)) break;
      // 每 20s 打一次进度：事件数在涨说明 codex 正在产出（调研中）；长时间不涨可能是卡住
      const now = Date.now();
      if (now - lastProgressAt >= 20_000) {
        let events = [];
        try { events = await codex.readEvents(runId); } catch { /* 读取事件失败忽略 */ }
        const lastType = events.at(-1)?.type || events.at(-1)?.item?.type || '(无事件)';
        const messageCount = events.filter((e) => e.item?.type === 'agent_message' || /agent_message|message.completed/i.test(e.type || '')).length;
        console.log(`[research-smoke]   运行中 ${Math.round((now - new Date(final?.researchAgent?.startedAt || now).getTime()) / 1000)}s · 事件 ${events.length}（+${events.length - lastEventCount}）· 最新 ${lastType} · 消息 ${messageCount}`);
        lastProgressAt = now;
        lastEventCount = events.length;
      }
      await sleep(2000);
    }
    const status = final?.researchAgent?.status || 'running';
    const note = final?.researchNotes?.[0];
    const elapsed = Math.round((Date.now() - new Date(final?.researchAgent?.startedAt || Date.now()).getTime()) / 1000);
    if (status === 'running') {
      try { await runtime.cancelRun({ state: final, runId }); console.log('[research-smoke] 外部超时，已请求取消研究员 run（避免孤儿 codex 进程）。'); } catch { /* 忽略取消失败 */ }
      let events = [];
      try { events = await codex.readEvents(runId); } catch { /* 忽略读取失败 */ }
      if (events.length) {
        console.log(`[research-smoke] 最近事件（共 ${events.length} 条，判断 codex 是否在产出）：`);
        events.slice(-6).forEach((e) => console.log(`[research-smoke]   ${e.type || ''} ${e.item?.type || ''} ${String(e.item?.text || e.item?.aggregated_output || e.item?.output || '').slice(0, 80)}`.trim()));
      } else {
        console.log('[research-smoke] 无事件产出——codex 进程可能卡在沙箱/认证/网络初始化，需进一步排查。');
      }
    }

    console.log(`[research-smoke] 研究员状态: ${status}（${elapsed}s）`);
    if (status === 'completed' && note) {
      console.log(`[research-smoke] 摘要: ${note.summary || '(无摘要)'}`);
      console.log(`[research-smoke] 发现数: ${(note.findings || []).length} · 建议方向数: ${(note.suggestedDirections || []).length} · 来源数: ${(note.sources || []).length}`);
      if ((note.sources || []).length) {
        note.sources.slice(0, 5).forEach((source) => console.log(`[research-smoke]   来源: ${source.title || ''} ${source.url || ''}`.trim()));
      }
      console.log('[research-smoke] PASS: 研究员真实联网调研完成并产出带来源笔记。');
      return 0;
    }
    const phase = final?.researchAgent?.phase || '';
    let runError = '';
    try { const run = await codex.readRun(runId); runError = run?.error?.message || run?.error || ''; } catch { /* 忽略读取错误 */ }
    const detail = runError || final?.researchAgent?.messages?.slice(-1)?.[0]?.detail || '';
    console.error(`[research-smoke] FAIL: 研究员未产出可用笔记（status=${status}${phase ? ` · ${phase}` : ''}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}）。`);
    console.error('[research-smoke] 请检查：① codex 是否已登录且有网络访问 ② Windows 沙箱是否能初始化 ③ 方向是否过窄。');
    return 1;
  } catch (error) {
    console.error(`[research-smoke] FAIL: ${error.message}`);
    return 1;
  }
})();

await rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(exitCode);
