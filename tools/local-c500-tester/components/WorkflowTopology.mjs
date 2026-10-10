import React from 'react';
import { Text } from 'ink';
import { displayStatus, displayTitle, displayDisposition, displayValue } from '../ui-labels.mjs';
import { theme, clipDisplay, padDisplay, displayWidth } from './chrome.mjs';

// Content builders for the work panel's workflow regions: stage chains, the
// current-step card and the candidate table. Each returns plain lines so the
// Dashboard can size its panels exactly; nothing here draws a border, reads
// the runtime or runs a timer (the spinner lives in WorkflowActivityIndicator).
const statusMeta = {
  completed: { icon: '✓', color: theme.ok },
  running: { icon: '●', color: theme.accent },
  rejected: { icon: '×', color: theme.error },
  failed: { icon: '×', color: theme.error },
  pending: { icon: '○', color: theme.muted },
};
const metaOf = (status) => statusMeta[status] || statusMeta.pending;

// "中文 (raw)" -> "中文"; untranslated values pass through unchanged.
export const zh = (display, raw) => {
  const text = String(display);
  const suffix = ` (${raw})`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
};
export const zhStatus = (value) => zh(displayStatus(value), String(value ?? '--'));
// Status first, then the generic value table ("missing" -> "缺失").
export const zhValue = (value) => {
  const status = zhStatus(value);
  return status !== String(value ?? '--') ? status : displayValue(value);
};
const zhOwner = (owner) => (owner === 'Agent' ? '智能体' : owner === 'Fixed' ? '固定流程' : String(owner ?? '--'));
const quietDetail = new Set(['', '--', '—', 'pending', 'waiting', 'target pending', 'untested']);
const quiet = (value) => quietDetail.has(String(value ?? '').trim());
const text = (key, children, props = {}) => React.createElement(Text, { key, wrap: 'truncate-end', ...props }, ...[].concat(children));

const progressBar = (progress, width) => {
  const normalized = Math.max(0, Math.min(100, Number(progress || 0)));
  const filled = Math.round((normalized / 100) * width);
  return `${'━'.repeat(filled)}${'─'.repeat(width - filled)}`;
};

// The two stage chains plus which node the flow is at: the running node, else
// the first unfinished setup node, else the first unfinished iteration node.
export const workflowChains = (topology) => {
  const flow = topology.iterationNodes;
  const outcome = flow.rollback.status === 'completed' ? flow.rollback : flow.adopt;
  const setup = topology.setup;
  const iteration = [{ ...flow.candidate, detail: '' }, flow.test, flow.gate, outcome];
  const all = [...setup, ...iteration];
  const done = (item) => ['completed', 'rejected'].includes(item.status);
  const focus = all.find((item) => item.status === 'running')
    || setup.find((item) => !done(item))
    || iteration.find((item) => !done(item)) || null;
  return { setup, iteration, focus: focus?.id || null, focusTitle: focus ? displayTitle(focus.title) : '' };
};

// One line: `准备  ✓ 源码调研 › ◉ 基线生成 › ○ 基线测试`. The focused node is
// drawn in the accent colour with ◉ even while still pending; while the mission
// is paused the running node is drawn as the (yellow) focus, not as running.
export const Chain = ({ label, items, focus, paused = false, details = false, detailWidth = 14, suffix = '', compact = false }) => React.createElement(Text, { wrap: 'truncate-end' },
  React.createElement(Text, { color: theme.muted }, `${label}  `),
  ...chainNodes({ items, focus, paused, details, detailWidth, separator: compact ? ' › ' : ' ── ' }),
  suffix ? React.createElement(Text, { color: theme.muted }, `${compact ? '  ' : '   '}${suffix}`) : '');

const chainNodes = ({ items, focus, paused, details, detailWidth, separator }) => [
  ...items.flatMap((item, index) => {
    const focused = item.id === focus && (item.status === 'pending' || paused);
    const meta = focused ? { icon: '◉', color: paused ? theme.warn : theme.accent } : metaOf(item.status);
    // Only the step in motion carries a detail; finished steps stay terse.
    const live = focused || ['running', 'failed', 'rejected'].includes(item.status);
    const detail = details && live && !quiet(item.detail) ? ` ${clipDisplay(displayValue(item.detail), detailWidth)}` : '';
    return [
      index ? React.createElement(Text, { color: theme.muted }, separator) : '',
      React.createElement(Text, { color: meta.color, bold: focused || item.status === 'running' }, `${meta.icon} ${displayTitle(item.title)}`),
      detail ? React.createElement(Text, { color: theme.muted }, detail) : '',
    ];
  })];

// Stage the flow is in: 1 = preparation (one-off), 2 = iteration (looping).
// Iteration starts once every preparation node is done or any iteration node
// has moved; 0 = no Mission yet.
export const flowStage = (chains, hasMission = true) => {
  if (!hasMission) return 0;
  const done = (item) => ['completed', 'rejected'].includes(item.status);
  const moved = chains.iteration.some((item) => item.status !== 'pending');
  return chains.setup.every(done) || moved ? 2 : 1;
};

// Workflow panel content: a stage bar (preparation → iteration, current stage
// highlighted, finished preparation collapsed to a green label) and the steps
// of the current stage only. Paused / needs-human colour the current stage.
export const FlowLines = ({ chains, view, round = 0, width, hasMission = true }) => {
  const stage = flowStage(chains, hasMission);
  const halted = view.needsHuman ? { color: theme.error, note: '需要人工' } : view.paused ? { color: theme.warn, note: '已暂停' } : null;
  const current = halted?.color || (view.terminal ? theme.muted : theme.accent);
  const currentIcon = view.terminal ? '■' : halted ? '◉' : '●';
  const narrow = width < 76;
  const roundText = round ? `第 ${round} 轮` : '';
  const haltNote = halted ? ` · ${halted.note}` : view.terminal ? ' · 已结束' : '';
  const setupLabel = stage === 2
    ? { text: narrow ? '✓ 准备' : '✓ 准备完成', color: theme.ok, bold: false }
    : { text: `${stage === 1 ? currentIcon : '○'} ${narrow ? '准备' : '① 准备（一次性）'}${stage === 1 ? haltNote : ''}`, color: stage === 1 ? current : theme.muted, bold: stage === 1 };
  const iterName = narrow ? '迭代' : '② 迭代优化';
  const iterLabel = stage === 2
    ? { text: `${currentIcon} ${[iterName, roundText].filter(Boolean).join(' · ')}${haltNote}`, color: current, bold: true }
    : { text: `○ ${narrow ? iterName : `${iterName}（循环）`}`, color: theme.muted, bold: false };
  const gap = narrow ? 3 : Math.max(4, Math.min(28, width - displayWidth(setupLabel.text) - displayWidth(iterLabel.text) - 2));
  const bar = React.createElement(Text, { key: 'stages', wrap: 'truncate-end' },
    React.createElement(Text, { color: setupLabel.color, bold: setupLabel.bold }, setupLabel.text),
    React.createElement(Text, { color: stage === 2 ? theme.ok : theme.muted }, narrow ? ' → ' : ` ${'━'.repeat(gap)} `),
    React.createElement(Text, { color: iterLabel.color, bold: iterLabel.bold }, iterLabel.text));
  const paused = view.paused || view.needsHuman;
  const steps = React.createElement(Chain, {
    key: 'steps', label: ' ', items: stage === 2 ? chains.iteration : chains.setup, focus: chains.focus, paused,
    details: width >= 100, detailWidth: 12, compact: narrow, suffix: stage === 2 && !view.terminal ? '↺ 下一轮' : '',
  });
  return { stage, lines: [bar, steps] };
};

// Current-step card, as prioritised lines (the Dashboard keeps the first N).
// It speaks for the mission's real state: paused / action required / not yet
// started never fall back to the "publish a Mission" placeholder.
export const CurrentStep = ({ topology, view, state = {}, mission = {}, width }) => {
  const node = topology.currentNode;
  const chains = workflowChains(topology);
  // WAITING / ACTION REQUIRED name no real step; point at where the flow stands.
  const placeholderNode = ['WAITING', 'ACTION REQUIRED'].includes(node.title);
  const nextTitle = placeholderNode ? chains.focusTitle || '候选方案' : displayTitle(node.title);
  const reason = zhValue(state.iterationStats?.loopStatusReason || '');
  const baseline = state.baseline?.status;
  const baselineNote = ['missing', 'failed'].includes(baseline) && !/BASELINE/.test(node.title)
    ? text('baseline', `基线结果${zhValue(baseline)}，基线步骤完成前没有可对比的性能数据`, { color: theme.warn }) : null;
  const hint = (key, label) => text('hint', [
    React.createElement(Text, { color: theme.accent, bold: true }, `[${key}]`),
    React.createElement(Text, { color: theme.muted }, ` ${label}`)]);
  const heading = (icon, color, title, suffix) => text('head', [
    React.createElement(Text, { color, bold: true }, `${icon} ${title}`),
    suffix ? React.createElement(Text, { color: theme.muted }, `   ${suffix}`) : '']);

  if (view.generationOutcome?.noCandidate && !view.needsHuman) return { color: theme.muted, lines: [
    heading('■', theme.muted, '未提出新候选', '本次生成已结束'),
    text('count', `已记录生成 ${view.generationOutcome.recordedGenerations} 次 · 候选已测 ${view.generationOutcome.measuredCandidates} 次`),
    hint('H', '查看结束原因；I 查看原测量和判定'),
  ] };
  if (view.needsHuman && view.resourceState === 'pending') return { color: theme.error, lines: [
    heading('!', theme.error, '资源释放未确认', '需原执行所有者核对'),
    text('release', '队列空不等于执行资源退出；原预算不续期'),
    hint('H', '完整资源身份、下一步和原截止时间'),
  ] };
  if (view.paused) {
    return { color: theme.warn, lines: [
      heading('Ⅱ', theme.warn, '已暂停后续推进', `${placeholderNode ? '下一步' : '停在'}：${nextTitle}`),
      reason && reason !== '--' ? text('reason', `原因：${reason}`) : null,
      text('clock', '原时钟仍计时；在途工作未取消 · [H] 说明'),
      baselineNote,
      view.actions?.resume ? hint('Space', '恢复运行') : null,
    ].filter(Boolean) };
  }
  if (view.needsHuman) {
    return { color: theme.error, lines: [
      heading('!', theme.error, '需要人工处理', `停在：${nextTitle}`),
      text('reason', `原因：${reason && reason !== '--' ? reason : displayValue(node.detail)}`),
      baselineNote,
      view.actions?.resume ? hint('Space', '处理后恢复') : null,
    ].filter(Boolean) };
  }
  if (!mission.id) {
    return { color: theme.muted, lines: [heading('○', theme.muted, '尚无活动任务'), hint('M', '打开任务列表，创建或选择任务')] };
  }
  if (placeholderNode) {
    return { color: theme.muted, lines: [heading('◉', theme.accent, `下一步：${nextTitle}`, '等待流程推进'), baselineNote].filter(Boolean) };
  }

  const meta = metaOf(node.status);
  const activity = node.progressMode === 'activity';
  const elapsed = String(node.meta || '').split(' · elapsed ')[1] || '--';
  const progress = Number(node.progress);
  const showBar = !activity && Number.isFinite(progress) && progress < 100 && ['running', 'failed'].includes(node.status);
  const barWidth = Math.max(10, Math.min(36, width - 8));
  const lines = [
    heading(meta.icon, meta.color, displayTitle(node.title), `${zhOwner(node.owner)} · ${zhStatus(node.status)}`),
    activity ? text('progress', `事件 ${Number(state.agent?.eventCount || 0)}  ·  已用 ${elapsed}`, { color: theme.secondary }) : null,
    showBar ? text('progress', `${progressBar(progress, barWidth)}  ${Math.round(progress)}%`, { color: node.status === 'failed' ? theme.error : meta.color }) : null,
    !quiet(node.detail) ? text('detail', clipDisplay(displayValue(node.detail), width)) : null,
    baselineNote,
    node.meta && !activity ? text('meta', node.meta, { color: theme.muted }) : null,
  ].filter(Boolean);
  return { color: node.status === 'failed' ? theme.error : node.status === 'running' ? theme.accent : theme.muted, lines };
};

// Candidate table lines: header + newest `rows` candidates, or one empty line.
export const CANDIDATE_TITLE = '最近候选';
export const candidateNote = (topology, rows) => {
  const total = topology.candidates.length;
  if (!total) return '';
  return rows < total ? `最近 ${rows} / 共 ${total} 个` : `共 ${total} 个`;
};
export const CandidateLines = ({ topology, width, rows }) => {
  if (!topology.candidates.length) return [text('empty', '尚未生成候选', { color: theme.muted })];
  const candidates = topology.candidates.slice(-Math.max(1, rows));
  const cols = width >= 88 ? { round: 5, id: 16, attempt: 4, value: 12, gain: 9, gate: 10 } : { round: 4, id: 13, attempt: 3, value: 10, gain: 7, gate: 8 };
  const cell = (value, size) => padDisplay(clipDisplay(value, size), size);
  const row = (values) => `${cell(values[0], cols.round)} ${cell(values[1], cols.id)} ${cell(values[2], cols.attempt)} ${cell(values[3], cols.value)} ${cell(values[4], cols.gain)} ${cell(values[5], cols.gate)} ${values[6]}`;
  return [
    text('head', row(['轮次', '候选', '次', '结果', '提升', '门禁', '处置']), { color: theme.muted }),
    ...candidates.map((candidate) => text(candidate.key, row([candidate.round, candidate.id, candidate.attempt, candidate.value, candidate.improvement, zhStatus(candidate.gate),
      zh(displayDisposition(candidate.disposition), String(candidate.disposition ?? '--'))]), {
      color: candidate.adopted ? theme.ok : candidate.rolledBack ? theme.warn : ['generating', 'running'].includes(candidate.taskStatus) ? theme.accent : undefined,
    })),
  ];
};
