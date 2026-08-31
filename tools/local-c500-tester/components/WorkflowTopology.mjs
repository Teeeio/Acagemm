import React from 'react';
import { Box, Text } from 'ink';
import { deriveWorkflowTopology } from '../tui-state.mjs';
import { displayStatus, displayTitle, displayOwner, displayDisposition, bilingual } from '../ui-labels.mjs';

const statusMeta = {
  completed: { icon: '✓', color: 'green' },
  running: { icon: '●', color: 'cyan' },
  rejected: { icon: '×', color: 'red' },
  failed: { icon: '×', color: 'red' },
  pending: { icon: '·', color: 'gray' },
};

const fit = (input, width) => {
  const value = String(input ?? '');
  if (value.length > width) return `${value.slice(0, Math.max(0, width - 1))}…`;
  return value.padEnd(width);
};

const TopologyNode = ({ item, width = 20, current = false, oneLine = false }) => {
  const meta = statusMeta[item.status] || statusMeta.pending;
  return React.createElement(Box, {
    width,
    minHeight: oneLine ? 3 : current ? 5 : 4,
    flexDirection: 'column',
    borderStyle: current ? 'double' : 'round',
    borderColor: meta.color,
    paddingX: 1,
  },
  React.createElement(Text, { color: meta.color, bold: current || item.status === 'running' }, `${meta.icon} ${displayTitle(item.title)}`),
  oneLine ? null : React.createElement(Text, { dimColor: item.status === 'pending' }, `${displayOwner(item.owner)} · ${displayStatus(item.detail || item.status)}`));
};

const Arrow = ({ label = '▶' }) => React.createElement(Box, { width: 3, justifyContent: 'center', alignItems: 'center' }, React.createElement(Text, { dimColor: true }, label));

const progressBar = (progress, width = 28) => {
  const normalized = Math.max(0, Math.min(100, Number(progress || 0)));
  const filled = Math.round((normalized / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

const CandidateTable = ({ topology, width, limit = 5 }) => {
  const compact = width < 105;
  const candidates = topology.candidates.slice(-limit);
  const earlierCount = Math.max(0, topology.candidates.length - candidates.length);
  const columns = compact
    ? { candidate: 12, attempt: 3, result: 9, gain: 7, gate: 11 }
    : { candidate: 16, attempt: 3, result: 11, gain: 12, gate: 15 };
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { color: 'cyan' }, bilingual('最近候选', 'Recent Candidates')),
    React.createElement(Text, { dimColor: true }, compact
      ? `轮  Rnd  ${fit('候选 Candidate', columns.candidate)} ${fit('次 Try', columns.attempt)} ${fit('结果 Result', columns.result)} ${fit('增益 Gain', columns.gain)} ${fit('门禁 Gate', columns.gate)} 处置 Disposition`
      : `轮次 Round  ${fit('候选 Candidate', columns.candidate)} ${fit('次 Try', columns.attempt)} ${fit('结果 Result', columns.result)} ${fit('提升 Improvement', columns.gain)} ${fit('门禁 Gate', columns.gate)} 处置 Disposition`),
    earlierCount > 0 ? React.createElement(Text, { dimColor: true }, ` ...   前面还有 ${earlierCount} 个候选 (earlier candidates)`) : null,
    ...(candidates.length ? candidates.map((candidate) => React.createElement(Text, {
      key: candidate.key,
      color: candidate.adopted ? 'green' : candidate.rolledBack ? 'yellow' : candidate.taskStatus === 'generating' || candidate.taskStatus === 'running' ? 'cyan' : undefined,
    }, `${String(candidate.round).padStart(compact ? 3 : 5)}  ${fit(candidate.id, columns.candidate)} ${fit(candidate.attempt, columns.attempt)} ${fit(candidate.value, columns.result)} ${fit(candidate.improvement, columns.gain)} ${fit(displayStatus(candidate.gate), columns.gate)} ${displayDisposition(candidate.disposition)}`))
      : [React.createElement(Text, { key: 'empty', dimColor: true }, '  --   尚未生成候选 (No candidate generated)')]),
  );
};

export const WorkflowTopology = ({ snapshot = {}, layout = {} }) => {
  const topology = deriveWorkflowTopology(snapshot);
  const width = Math.max(40, Number(layout.columns || process.stdout.columns || 120) - 2);
  const tight = layout.density === 'tight';
  const compact = width < 110;
  const setupWidth = tight ? 15 : compact ? 16 : 21;
  const current = topology.currentNode;
  const currentItem = { title: current.title, owner: current.owner, status: current.status, detail: current.progressMode === 'activity' ? current.detail : `${current.progress}% · ${current.detail}` };
  const flowNodes = topology.iterationNodes;
  return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    React.createElement(Box, { justifyContent: 'space-between' },
      React.createElement(Text, { color: 'cyan', bold: true }, bilingual('工作流拓扑', 'Workflow Topology')),
      React.createElement(Text, { dimColor: true }, `实时 (LIVE) · 第 ${topology.currentRound || '--'} 轮 (Round)`),
    ),
    React.createElement(Box, { flexDirection: 'row', alignItems: 'center' },
      ...topology.setup.flatMap((item, index) => [
        React.createElement(TopologyNode, { key: item.id, item, width: setupWidth, oneLine: tight }),
        index < topology.setup.length - 1 ? React.createElement(Arrow, { key: `${item.id}-arrow`, label: tight ? '›' : '▶' }) : null,
      ].filter(Boolean)),
    ),
    React.createElement(Box, { marginTop: tight ? 0 : 1 }, React.createElement(CandidateTable, { topology, width, limit: layout.candidateLimit || 5 })),
    React.createElement(Box, { marginTop: tight ? 0 : 1, flexDirection: tight ? 'row' : compact ? 'column' : 'row', alignItems: tight || !compact ? 'center' : 'flex-start' },
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(TopologyNode, { item: currentItem, width: tight ? 22 : compact ? Math.min(width - 4, 48) : 42, current: true, oneLine: tight }),
        current.progressMode === 'activity'
          ? React.createElement(Text, { color: 'cyan' }, `events ${Number(snapshot.state?.agent?.eventCount || 0)} · elapsed ${String(current.meta || '').split(' · elapsed ')[1] || '--'}`)
          : React.createElement(Text, { color: current.status === 'failed' ? 'red' : 'cyan' }, `${progressBar(current.progress, tight ? 12 : compact ? 24 : 32)} ${Math.round(current.progress || 0)}%`),
        !tight && current.meta ? React.createElement(Text, { dimColor: true }, fit(current.meta, compact ? 44 : 40)) : null,
      ),
      compact && !tight ? null : React.createElement(Arrow, { label: tight ? '›' : '▶' }),
      React.createElement(Box, { flexDirection: 'row', alignItems: 'center', marginTop: compact && !tight ? 1 : 0 },
        React.createElement(TopologyNode, { item: flowNodes.test, width: tight ? 12 : compact ? 16 : 18, oneLine: tight }),
        React.createElement(Arrow, { label: tight ? '›' : '▶' }),
        React.createElement(TopologyNode, { item: flowNodes.gate, width: tight ? 13 : compact ? 17 : 19, oneLine: tight }),
        React.createElement(Arrow, { label: tight ? '›' : '▶' }),
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(TopologyNode, { item: flowNodes.adopt, width: tight ? 13 : compact ? 16 : 18, oneLine: tight }),
          React.createElement(TopologyNode, { item: flowNodes.rollback, width: tight ? 13 : compact ? 16 : 18, oneLine: tight }),
        ),
      ),
    ),
  );
};
