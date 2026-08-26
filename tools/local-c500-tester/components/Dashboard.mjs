import React from 'react';
import { Box, Text } from 'ink';
import { deriveTuiViewModel } from '../tui-state.mjs';
import { deriveDashboardLayout } from '../tui-layout.mjs';
import { WorkflowActivityIndicator } from './WorkflowActivityIndicator.mjs';
import { WorkflowTopology } from './WorkflowTopology.mjs';

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
  const events = (state.runtimeEvents || []).slice(-6).reverse();
  const backend = health.testBackend || {};
  const view = deriveTuiViewModel({ state, mission, tasks });
  return React.createElement(Box, { flexDirection: 'column', height: layout.height, overflow: 'hidden' },
    React.createElement(Box, { justifyContent: 'space-between' },
      React.createElement(Text, { bold: true, color: 'green' }, 'C500 Production Workflow Tester'),
      React.createElement(Text, null, `${backend.kind || 'connecting'}${backend.mock ? ' / SIMULATION' : ''}`),
    ),
    React.createElement(Text, { color: view.needsHuman ? 'red' : view.paused ? 'yellow' : view.terminal ? 'green' : 'cyan', bold: true }, view.banner),
    React.createElement(Panel, { title: 'Current Mission' },
      React.createElement(Text, null, `${mission.id || '--'} · ${mission.title || 'No mission published'} · ${view.statusLabel} · ${state.stage || mission.stage || '--'}`),
      layout.showMissionDetail ? React.createElement(Text, null, `Goal: ${mission.goal || '--'}`) : null,
      layout.showMissionDetail ? React.createElement(Text, null, `Agent: ${state.agent?.status || '--'} / ${state.agent?.phase || '--'} · Loop: ${iteration.loopStatus || '--'}${iteration.loopStatusReason ? ` / ${iteration.loopStatusReason}` : ''}`) : null,
    ),
    React.createElement(WorkflowTopology, { snapshot: { state, mission, health, tasks }, layout }),
    layout.showEvidencePanels ? React.createElement(Box, null,
      React.createElement(Panel, { title: 'Evidence', width: 50 },
        React.createElement(Text, null, `baseline    ${state.baseline?.status || '--'} / ${state.baseline?.kind || '--'}`),
        React.createElement(Text, null, `benchmark   ${benchmark.status || '--'} ${benchmark.progress ?? 0}%`),
        React.createElement(Text, null, `task        ${benchmark.testTaskId || '--'}`),
        React.createElement(Text, null, `live C500   ${benchmark.result?.environment?.liveHardware === true ? 'yes' : benchmark.result?.environment?.source === 'simulation' ? 'simulation' : '--'}`),
      ),
      React.createElement(Panel, { title: 'Current Best', width: 40 },
        React.createElement(Text, null, `candidate   ${best.candidateId || '--'}`),
        React.createElement(Text, null, `value       ${show(best.value)}`),
        React.createElement(Text, null, `improvement ${show(best.improvement)}`),
        React.createElement(Text, null, `rounds      ${view.displayedRounds}`),
      ),
    ) : null,
    layout.showCompactSummary ? React.createElement(Text, { dimColor: true }, `Evidence: ${state.baseline?.status || '--'} · ${benchmark.status || '--'} ${benchmark.progress ?? 0}% · Best ${best.candidateId || '--'} ${show(best.value)} · Queue ${view.activeTasks}/${tasks.length}`) : null,
    layout.showEvents ? React.createElement(Panel, { title: `Recent Events / Queue ${view.activeTasks} active / ${tasks.length} total` },
      events.length
        ? events.slice(0, 3).map((event) => React.createElement(Text, { key: event.id || `${event.sequence}-${event.type}` }, `${event.createdAt || event.time || '--'} ${event.type || event.title || 'event'}`))
        : React.createElement(Text, null, '--'),
    ) : null,
    React.createElement(Text, { color: message ? 'yellow' : undefined }, message || ' '),
    React.createElement(Text, { inverse: true }, view.hotkeys.join('  ')),
    React.createElement(WorkflowActivityIndicator, { snapshot: { state, mission, health, tasks } }),
  );
};
