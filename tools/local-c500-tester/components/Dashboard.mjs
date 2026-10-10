import { businessOutcomeText } from '../tui-state.mjs';
import React from 'react';
import { Box, Text } from 'ink';
import { deriveSemanticAlignment, deriveTuiViewModel, deriveWorkflowTopology, missionTargetLabel, roundExperienceLines } from '../tui-state.mjs';
import { deriveDashboardLayout } from '../tui-layout.mjs';
import { WorkflowActivityIndicator } from './WorkflowActivityIndicator.mjs';
import { FlowLines, CurrentStep, CandidateLines, CANDIDATE_TITLE, candidateNote, workflowChains, zhStatus, zhValue } from './WorkflowTopology.mjs';
import { formatExactTokenCount } from '../../../client-runtime/token-usage.mjs';
import { normalizeOperatorLanguage } from '../../../client-runtime/operator-language.mjs';
import { displayBannerText, displayHotkey, displayValue } from '../ui-labels.mjs';
import { theme, Brand, HeaderLine, KeyBar, Panel, panelContentWidth, hotkeyChip, clipDisplay, padDisplay, displayWidth } from './chrome.mjs';

// Work panel: header + banner, bounded regions (panels) — a main column
// (summary on narrow terminals, current step, candidates, activity,
// recent events) and, on wide terminals, a sidebar of fact panels — then a
// full-width workflow panel (the visual anchor) pinned just above the key bar.
// Presentation only: every value comes from the view models in tui-state.mjs.
// Height budget: every panel gets its minimum, then frames are chosen if they
// fit (else titled rules), then spare lines grow the panels in priority order;
// the recent-events panel shows as many entries as the rest allows.
const placeholder = new Set(['', '--', '—', '–', '-', 'unknown', 'undefined', 'null', 'NaN']);
const quiet = (value) => placeholder.has(String(value ?? '').trim());
// Joins the meaningful parts only: ['运行中', '--'] -> '运行中'.
const join = (...parts) => parts.filter((part) => !quiet(part)).join(' · ');
const line = (text, props = {}) => React.createElement(Text, { wrap: 'truncate-end', ...props }, text);
const activeStatuses = new Set(['running', 'waiting', 'queued']);
const queueIcon = (status) => (status === 'failed' ? '×' : status === 'completed' ? '✓' : activeStatuses.has(status) ? '●' : '○');
const queueColor = (status) => (status === 'failed' ? theme.error : activeStatuses.has(status) ? theme.accent : undefined);
const purposeLabel = { baseline: '基线测试', candidate: '候选测试' };
const toneColor = (tone) => (/warn|amber|yellow|orange/i.test(tone || '') ? theme.warn
  : /red|error|danger|fail/i.test(tone || '') ? theme.error : /green|success|ok/i.test(tone || '') ? theme.ok : theme.secondary);

const QueueRow = ({ entry, width }) => {
  const identity = entry.identity === 'baseline' ? '基线' : entry.identity;
  const status = activeStatuses.has(entry.status) && entry.progress ? `${zhStatus(entry.status)} ${entry.progress}%` : zhStatus(entry.status || 'waiting');
  const note = join(entry.note, entry.cache ? `参考缓存 ${entry.cache}` : '');
  return React.createElement(Text, { wrap: 'truncate-end' },
    React.createElement(Text, { color: queueColor(entry.status) }, `${queueIcon(entry.status)} `),
    React.createElement(Text, { bold: activeStatuses.has(entry.status) }, padDisplay(clipDisplay(identity, 16), 17)),
    React.createElement(Text, { color: theme.muted }, padDisplay(purposeLabel[entry.purpose] || entry.purpose || '任务', 10)),
    React.createElement(Text, { color: queueColor(entry.status) }, padDisplay(status, 10)),
    note ? React.createElement(Text, { color: entry.status === 'failed' ? theme.error : theme.muted }, clipDisplay(note, Math.max(8, width - 40))) : null);
};

const EventRow = ({ event, width }) => React.createElement(Text, { wrap: 'truncate-end' },
  React.createElement(Text, { color: theme.muted }, padDisplay(event.time || '', 9)),
  React.createElement(Text, { color: toneColor(event.tone) }, '● '),
  React.createElement(Text, null, clipDisplay(event.title || '事件', Math.max(8, width - 12))),
  event.detail ? React.createElement(Text, { color: theme.muted }, `  ${String(event.detail).split(' · ').map(displayValue).join(' · ')}`) : null);

const FactRows = ({ rows, width }) => {
  const labelWidth = Math.max(...rows.map(([label]) => displayWidth(label)), 4) + 2;
  return rows.map(([label, value, color], index) => React.createElement(Text, { key: index, wrap: 'truncate-end' },
    React.createElement(Text, { color: theme.muted }, padDisplay(label, labelWidth)),
    React.createElement(Text, { color }, clipDisplay(value, Math.max(4, width - labelWidth)))));
};

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
  const tokenCoverage = /^0\/0\b/.test(tokenUsage.coverage || '0/0') ? '' : displayValue(tokenUsage.coverage);
  const experiences = roundExperienceLines({ state, mission }).map((entry) => entry.replace(/^本轮经验 \(Round experience\):\s*/u, ''));
  const decision = view.evidence.current || view.evidence.best;
  const fullSnapshot = { state, mission, health, tasks };
  const full = layout.density === 'full';
  const round = Number(deriveWorkflowTopology(fullSnapshot).currentRound || 0);

  // ---- widths ----
  const inner = Math.max(40, layout.columns - 2);
  const sidebar = inner >= 100;
  const sideWidth = sidebar ? Math.max(36, Math.min(54, Math.round(inner * 0.32))) : 0;
  const mainWidth = sidebar ? inner - sideWidth - 1 : inner;
  // Fixed chrome: header, banner, message, key bar (+ failure line).
  const bodyHeight = Math.max(1, layout.height - 4 - (view.failure ? 1 : 0));

  const bannerColor = view.needsHuman ? theme.error : view.paused ? theme.warn : view.terminal ? theme.ok : theme.accent;
  const backendLabel = join(`后端 ${backend.kind || '未连接'}`, backend.simulation ? '完整模拟' : backend.mock ? '硬件模拟' : '', '云端未部署');
  const semanticColor = semantic.frozen ? theme.ok : semantic.blockers.length ? theme.warn : undefined;

  // ---- main column: blocks with min/max content lines ----
  const topology = deriveWorkflowTopology(fullSnapshot);
  // No Mission or a finished one: nothing is "current", so no step is highlighted.
  const chains = mission.id && !view.terminal ? workflowChains(topology) : { ...workflowChains(topology), focus: null };
  const content = (framed) => panelContentWidth(mainWidth, framed);
  const step = CurrentStep({ topology, view, state, mission, width: content(true) });
  const candidateTotal = topology.candidates.length;
  const agentLine = topology.currentNode.owner !== 'Agent' && state.agent?.status === 'running' ? view.currentActivity : '';
  const events = Array.isArray(state.auditEvents) ? state.auditEvents : [];
  const blocks = [
    sidebar ? null : { key: 'summary', title: '概况', min: 2, max: 2 },
    { key: 'step', title: '当前步骤', color: step.color === theme.muted ? undefined : step.color, min: 1, max: step.lines.length },
    { key: 'candidates', title: CANDIDATE_TITLE, min: candidateTotal ? 2 : 1, max: candidateTotal ? 1 + Math.min(candidateTotal, 5) : 1 },
    { key: 'activity', title: '活动', note: tasks.length ? `${view.activeTasks} 运行中 / 共 ${tasks.length} 项` : '',
      min: (agentLine ? 1 : 0) + 1, max: (agentLine ? 1 : 0) + Math.max(1, view.queue.length) },
    events.length ? { key: 'events', title: '最近事件', note: `共 ${events.length} 条`, min: 0, max: events.length, optional: true } : null,
  ].filter(Boolean);
  const required = blocks.filter((block) => !block.optional);
  const minimum = required.reduce((sum, block) => sum + block.min, 0);
  // The workflow panel spans the full width below the main/sidebar row.
  const FLOW_LINES = 2;
  const framed = FLOW_LINES + minimum + 2 * (required.length + 1) <= bodyHeight;
  const chrome = framed ? 2 : 1;
  const rowHeight = Math.max(1, bodyHeight - FLOW_LINES - chrome);
  let spare = Math.max(0, rowHeight - minimum - chrome * required.length);
  for (const block of required) block.lines = block.min;
  const grow = (key) => {
    const block = blocks.find((item) => item.key === key);
    if (!block) return;
    const extra = Math.min(spare, block.max - block.lines);
    block.lines += extra;
    spare -= extra;
  };
  ['step', 'candidates', 'activity'].forEach(grow);
  const eventsBlock = blocks.find((block) => block.key === 'events');
  if (eventsBlock && spare >= chrome + 1) {
    eventsBlock.lines = Math.min(eventsBlock.max, spare - chrome);
    spare -= eventsBlock.lines + chrome;
  }
  // Leftover lines stay below the panels: an empty frame reads worse than space.
  const visible = blocks.filter((block) => block.lines > 0);

  const summary = [
    line(join(view.hasMission ? view.acceptanceSummary?.shortText : '', zhStatus(view.statusLabel), missionTargetLabel(mission), implementation.label, `语义 ${zhStatus(semantic.statusLabel)}`), { key: 's1', color: semanticColor }),
    line(view.generationOutcome?.noCandidate ? `已记录生成 ${view.generationOutcome.recordedGenerations} 次 · 候选已测 ${view.generationOutcome.measuredCandidates} 次 · [I] 实测结果` : view.businessOutcome ? businessOutcomeText(view.businessOutcome) : join(state.baseline?.status ? `基线 ${zhValue(state.baseline.status)}` : '', best.candidateId ? `最优 ${best.candidateId}${quiet(best.value) ? '' : ` ${best.value}`}` : '最优 尚无', `令牌 ${totalTokens}`), { key: 's2', color: theme.muted }),
  ];
  const render = {
    summary: () => summary,
    step: () => step.lines,
    candidates: (width, lines) => CandidateLines({ topology, width, rows: lines - 1 }),
    activity: (width) => [
      agentLine ? line(`● 智能体  ${agentLine}`, { key: 'agent', color: theme.accent }) : null,
      ...(view.queue.length
        ? view.queue.map((entry) => React.createElement(QueueRow, { key: entry.key, entry, width }))
        : [line('队列为空', { key: 'queue-empty', color: theme.muted })]),
    ].filter(Boolean),
    events: (width) => events.map((event, index) => React.createElement(EventRow, { key: `${event.time}-${index}`, event, width })),
  };
  const mainPanels = visible.map((block) => {
    const width = content(framed);
    const note = block.key === 'candidates' ? candidateNote(topology, Math.max(1, block.lines - 1)) : block.note;
    return React.createElement(Panel, {
      key: block.key, title: block.title, note, width: mainWidth, height: block.lines + chrome, framed,
      color: block.color || theme.muted, titleColor: block.color || theme.secondary,
    }, ...render[block.key](width, block.lines).slice(0, block.lines));
  });

  // ---- sidebar: fact panels, rows without a real value omitted, panels fit whole ----
  const loopRow = view.paused || view.needsHuman ? null : ['循环', join(zhStatus(iteration.loopStatus), zhValue(iteration.loopStatusReason || ''))];
  const sections = [
    ['任务', [
      ['状态', zhStatus(view.statusLabel), view.paused ? theme.warn : view.needsHuman ? theme.error : undefined],
      ['目标硬件', missionTargetLabel(mission)],
      ['验收策略', view.acceptanceSummary?.shortText],
      ['语言', implementation.label],
      loopRow,
      full ? ['目标', mission.goal] : null,
    ]],
    ['当前最优', [
      ['候选', best.candidateId || '尚无', best.candidateId ? theme.ok : theme.muted],
      ['数值', join(best.value, quiet(best.improvement) ? '' : `提升 ${best.improvement}`)],
      Number(view.displayedRounds) > 0 ? ['轮次', String(view.displayedRounds)] : null,
    ]],
    ['证据', [
      view.businessOutcome ? ['本次判定', businessOutcomeText(view.businessOutcome)] : null,
      ['基线', join(zhValue(state.baseline?.status), displayValue(state.baseline?.kind || '')),
        ['missing', 'failed'].includes(state.baseline?.status) ? theme.warn : undefined],
      benchmark.status && !(benchmark.status === 'idle' && !Number(benchmark.progress)) ? ['基准测试', join(zhStatus(benchmark.status), `${benchmark.progress ?? 0}%`)] : null,
      ['执行', join(displayValue(decision?.execution?.kind || ''), decision?.execution?.source)],
      ['发布', join(displayValue(decision?.publication?.status || ''), (decision?.publication?.reasons || []).map(displayValue).join('、')),
        decision?.publication?.status === 'blocked' ? theme.warn : undefined],
      full ? ['测试任务', benchmark.testTaskId] : null,
    ]],
    ['语义', [
      ['状态', join(zhStatus(semantic.statusLabel), semantic.operator), semanticColor],
      ['摘要', semantic.digestShort],
      semantic.correctnessCases ? ['正确性', join(`${semantic.correctnessCases} 例`, semantic.correctnessCategories.map(displayValue).join('、'))] : null,
      ['基准档', (semantic.benchmarkProfiles.length ? semantic.benchmarkProfiles : [semantic.primaryProfile]).filter((item) => !quiet(item)).map(displayValue).join('、')],
      semantic.blockers.length ? ['阻塞项', semantic.blockers.join(', '), theme.warn] : null,
    ]],
    ['用量', [
      ['令牌', join(totalTokens, tokenCoverage)],
      ['经验', experiences[0]],
      full && experiences[1] ? ['', experiences[1]] : null,
    ]],
  ].map(([title, rows]) => [title, rows.filter((row) => row && !quiet(row[1]))]).filter(([, rows]) => rows.length);
  const flow = FlowLines({ chains, view, round, width: panelContentWidth(inner, framed), hasMission: Boolean(mission.id) });
  const flowPanel = React.createElement(Panel, {
    title: '工作流', note: flow.stage ? `阶段 ${flow.stage}/2` : '', width: inner, height: FLOW_LINES + chrome, framed,
    color: mission.id ? theme.accent : theme.muted, titleColor: mission.id ? theme.accent : theme.secondary,
  }, ...flow.lines);
  const sidePanels = [];
  let sideUsed = 0;
  for (const [title, rows] of sidebar ? sections : []) {
    const height = rows.length + chrome;
    if (sideUsed + height > rowHeight) continue;
    sidePanels.push(React.createElement(Panel, { key: title, title, width: sideWidth, height, framed },
      ...FactRows({ rows, width: panelContentWidth(sideWidth, framed) })));
    sideUsed += height;
  }

  return React.createElement(Box, { flexDirection: 'column', height: layout.height, overflow: 'hidden', paddingX: 1 },
    React.createElement(HeaderLine, {
      left: React.createElement(Brand, { suffix: mission.id ? `${mission.id} · ${mission.title || '未命名任务'}` : '未发布任务' }),
      right: React.createElement(WorkflowActivityIndicator, { snapshot: fullSnapshot }),
    }),
    React.createElement(HeaderLine, {
      left: line(displayBannerText(view.banner), { color: bannerColor, bold: true }),
      right: line(backendLabel, { color: theme.muted }),
    }),
    view.failure ? line(`× ${view.failure.code}: ${view.failure.message}`, { color: theme.error }) : null,
    React.createElement(Box, { height: rowHeight, overflow: 'hidden', flexDirection: 'row' },
      React.createElement(Box, { flexDirection: 'column', width: mainWidth, overflow: 'hidden' }, ...mainPanels),
      sidebar ? React.createElement(Box, { flexDirection: 'column', width: sideWidth, marginLeft: 1, overflow: 'hidden' }, ...sidePanels) : null),
    flowPanel,
    line(message || ' ', { color: message ? theme.warn : undefined }),
    React.createElement(KeyBar, { items: view.hotkeys.map((hotkey) => hotkeyChip(hotkey, displayHotkey)) }),
  );
};
