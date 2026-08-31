import React from 'react';
import { Box, Text } from 'ink';
import { deriveSemanticAlignment, deriveTuiViewModel } from '../tui-state.mjs';
import { deriveDashboardLayout } from '../tui-layout.mjs';
import { WorkflowActivityIndicator } from './WorkflowActivityIndicator.mjs';
import { WorkflowTopology } from './WorkflowTopology.mjs';
import { formatExactTokenCount } from '../../../client-runtime/token-usage.mjs';
import { normalizeOperatorLanguage } from '../../../client-runtime/operator-language.mjs';
import { bilingual, displayBanner, displayEvidence, displayHotkey, displayStatus } from '../ui-labels.mjs';

const Panel = ({ title, children, width }) => (
  React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1, width },
    React.createElement(Text, { color: 'cyan' }, title),
    children,
  )
);

const show = (input) => input == null || input === '' ? '--' : String(input);

export const Dashboard = ({ snapshot = {}, message = '', viewport = {} }) => {
  const layout = deriveDashboardLayout({
    columns: viewport.columns || process.stdout.columns,
    rows: viewport.rows || process.stdout.rows,
  });
  const state = snapshot.state || {};
  const mission = snapshot.mission || {};
  const health = snapshot.health || {};
  const tasks = snapshot.tasks || [];
  const best = state.currentBest || mission.currentBest || {};
  const benchmark = state.benchmark || {};
  const iteration = state.iterationStats || {};
  const backend = health.testBackend || {};
  const view = deriveTuiViewModel({ state, mission, tasks });
  const semantic = deriveSemanticAlignment({ state, mission });
  const implementation = normalizeOperatorLanguage(mission.implementation);
  const tokenUsage = state.tokenUsage || mission.tokenUsage || {};
  const totalTokens = formatExactTokenCount(tokenUsage.totalTokens || 0);
  const tokenCoverage = tokenUsage.coverage || '0/0 次精确统计';
  return React.createElement(Box, { flexDirection: 'column', height: layout.height, overflow: 'hidden' },
    React.createElement(Box, { justifyContent: 'space-between' },
      React.createElement(Text, { bold: true, color: 'green' }, bilingual(`${health?.testBackend?.device || 'C500'} 生产工作流测试器`, `${health?.testBackend?.device || 'C500'} Production Workflow Tester`)),
      React.createElement(Text, null, `${backend.kind || '连接中'}${backend.simulation ? ' / 完整模拟 (FULL SIMULATION)' : backend.mock ? ' / 硬件模拟 (HARDWARE MOCK)' : ''} · 令牌 ${totalTokens} · ${tokenCoverage}`),
    ),
    React.createElement(Text, { color: view.needsHuman ? 'red' : view.paused ? 'yellow' : view.terminal ? 'green' : 'cyan', bold: true }, displayBanner(view.banner)),
    React.createElement(Panel, { title: bilingual('当前任务', 'Current Mission') },
      React.createElement(Text, null, `${mission.id || '--'} · ${mission.title || '未发布任务 (No mission published)'} · ${displayStatus(view.statusLabel)} · ${displayStatus(state.stage || mission.stage || '--')}`),
      React.createElement(Text, null, `语言 (Language): ${implementation.label} · 测试规格 (Test spec): ${mission.testMatrix?.testSpec?.schemaVersion || '--'} · 令牌 (Tokens): ${totalTokens}`),
      layout.showMissionDetail ? React.createElement(Text, null, `目标 (Goal): ${mission.goal || '--'}`) : null,
      layout.showMissionDetail ? React.createElement(Text, null, `智能体 (Agent): ${displayStatus(state.agent?.status)} / ${state.agent?.phase || '--'} · 循环 (Loop): ${displayStatus(iteration.loopStatus)}${iteration.loopStatusReason ? ` / ${iteration.loopStatusReason}` : ''}`) : null,
      React.createElement(Text, { color: semantic.frozen ? 'green' : semantic.blockers.length ? 'yellow' : 'cyan' }, `语义 (Semantics): ${displayStatus(semantic.statusLabel)} · ${semantic.operator} · 摘要 (digest) ${semantic.digestShort}`),
      layout.showMissionDetail ? React.createElement(Text, null, `测试映射 (Test map): 正确性 (correctness) ${semantic.correctnessCases || '--'} [${semantic.correctnessCategories.join(', ') || '--'}] · 基准 (benchmark) ${semantic.primaryProfile}`) : null,
      semantic.blockers.length ? React.createElement(Text, { color: 'yellow' }, `对齐阻塞项 (Alignment blockers): ${semantic.blockers.join(', ')}`) : null,
    ),
    React.createElement(WorkflowTopology, { snapshot: { state, mission, health, tasks }, layout }),
    layout.showEvidencePanels ? React.createElement(Box, null,
      React.createElement(Panel, { title: bilingual('证据', 'Evidence'), width: 50 },
        React.createElement(Text, null, `基线 (baseline)    ${displayStatus(state.baseline?.status)} / ${state.baseline?.kind || '--'}`),
        React.createElement(Text, null, `基准 (benchmark)   ${displayStatus(benchmark.status)} ${benchmark.progress ?? 0}%`),
        React.createElement(Text, null, `任务 (task)        ${benchmark.testTaskId || '--'}`),
        React.createElement(Text, null, `真机 ${health?.testBackend?.device || 'C500'} (live)   ${displayEvidence(benchmark.result?.environment?.liveHardware === true ? true : benchmark.result?.environment?.source === 'simulation' ? 'simulation' : '--')}`),
        view.failure ? React.createElement(Text, { color: 'red' }, `错误 (error)      ${view.failure.code}: ${view.failure.message}`) : null,
      ),
      React.createElement(Panel, { title: bilingual('当前最优', 'Current Best'), width: 40 },
        React.createElement(Text, null, `候选 (candidate)   ${best.candidateId || '--'}`),
        React.createElement(Text, null, `数值 (value)       ${show(best.value)}`),
        React.createElement(Text, null, `提升 (improvement) ${show(best.improvement)}`),
        React.createElement(Text, null, `轮次 (rounds)      ${view.displayedRounds}`),
      ),
    ) : null,
    layout.showCompactSummary ? React.createElement(Text, { color: view.failure ? 'red' : undefined, dimColor: !view.failure }, `Evidence: ${state.baseline?.status || '--'} · ${benchmark.status || '--'} ${benchmark.progress ?? 0}% · Best ${best.candidateId || '--'} ${show(best.value)} · Queue ${view.activeTasks}/${tasks.length}${view.queue[0] ? ` · ${view.queue[0].line}` : ''}${view.failure ? ` · Error ${view.failure.code}: ${view.failure.message}` : ''}`) : null,
    layout.showEvents ? React.createElement(Panel, { title: `活动 / 队列 (Activity / Queue) ${view.activeTasks} 运行中 / 共 ${tasks.length}` },
      React.createElement(Text, { color: state.agent?.status === 'running' ? 'cyan' : undefined }, `智能体 (Agent) · ${view.currentActivity}`),
      ...(view.queue.length
        ? view.queue.slice(0, 3).map((entry) => React.createElement(Text, { key: entry.key, color: entry.status === 'failed' ? 'red' : ['running', 'waiting', 'queued'].includes(entry.status) ? 'cyan' : undefined }, `队列 (Queue) · ${entry.line}`))
        : [React.createElement(Text, { key: 'queue-empty', dimColor: true }, '队列 (Queue) · 空')]),
    ) : null,
    React.createElement(Text, { color: message ? 'yellow' : undefined }, message || ' '),
    React.createElement(Text, { inverse: true }, view.hotkeys.map(displayHotkey).join('  ')),
    React.createElement(WorkflowActivityIndicator, { snapshot: { state, mission, health, tasks } }),
  );
};
