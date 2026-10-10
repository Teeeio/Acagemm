import React from 'react';
import { Box, Text } from 'ink';
import { normalizeOperatorLanguage } from '../../../client-runtime/operator-language.mjs';
import { displayStatus } from '../ui-labels.mjs';
import { deriveTuiViewModel } from '../tui-state.mjs';
import { theme, Brand, HeaderLine, KeyBar } from './chrome.mjs';

// Presentation of persisted Mission identities only. Opening/creating a Mission
// belongs to App and the Production API; rendering this page has no effects.
export const missionEntryRows = (snapshot = {}) => {
  const missions = Array.isArray(snapshot.state?.missions) ? snapshot.state.missions : snapshot.mission ? [snapshot.mission] : [];
  const seen = new Set();
  const drafts = (snapshot.state?.missionDrafts || []).map(({ id, form }) => ({
    id, kind: 'draft', title: form.operator || '未命名草稿', current: false, status: '待配置',
    target: form.target || '目标待定', language: form.language ? normalizeOperatorLanguage(form.language).label : '语言待定',
    operator: form.operator, goal: form.goal, repository: 'Enter 继续配置 · 素材由系统管理',
  }));
  return [...drafts, ...missions.filter(mission => {
    if (typeof mission?.id !== 'string' || !mission.id || seen.has(mission.id)) return false;
    seen.add(mission.id);
    return true;
  }).map(mission => {
    const current = mission.id === snapshot.state?.activeMissionId;
    const terminal = ['completed', 'published', 'failed', 'cancelled', 'stopped', 'archived'].includes(mission.status);
    const view = deriveTuiViewModel({ mission, state: current ? snapshot.state : { ...mission, activeMissionId: mission.id }, tasks: [] });
    const language = typeof mission.implementation === 'string' ? mission.implementation : mission.implementation?.id || mission.implementation?.language;
    return {
      id: mission.id, title: mission.title || mission.goal || '未命名 Mission', current,
      status: terminal ? mission.status : view.statusLabel,
      target: Array.isArray(mission.hardware) ? mission.hardware.join(' / ') || '未指定目标' : mission.hardware || '未指定目标',
      language: language ? normalizeOperatorLanguage(mission.implementation).label : '未指定语言',
      operator: mission.operator || mission.operatorProfile?.operator || '未指定算子',
      repository: mission.repository || '未设置源码仓库', goal: mission.goal || '',
    };
  })];
};

export const focusedMission = (rows, selectedId, activeId) => rows.find(row => row.id === selectedId)
  || rows.find(row => row.id === activeId) || rows[0] || null;

export const MissionEntry = ({ screen = 'home', snapshot = {}, choice = 0, selectedId = null, loaded = false, message = '', busy = false, viewport = {} }) => {
  const rows = missionEntryRows(snapshot);
  const selected = focusedMission(rows, selectedId, snapshot.state?.activeMissionId);
  const height = Math.max(1, (viewport.rows || 30) - 2);
  const compact = height < 16;
  const rowHeight = compact ? 1 : 2;
  const capacity = Math.max(1, Math.floor((height - (compact ? 7 : 11)) / rowHeight));
  const index = Math.max(0, rows.findIndex(row => row.id === selected?.id));
  const start = Math.floor(index / capacity) * capacity;
  const line = (text, props = {}) => React.createElement(Text, { wrap: 'truncate-end', ...props }, text);
  const card = (index, title, detail) => React.createElement(Box, {
    key: index, flexDirection: 'column', borderStyle: 'round', borderColor: choice === index ? theme.accent : theme.muted, paddingX: 1,
  }, line(`${choice === index ? '›' : ' '} ${title}`, { bold: choice === index, color: choice === index ? theme.accent : undefined }),
  !compact ? line(detail, { dimColor: true }) : null);
  return React.createElement(Box, { flexDirection: 'column', height, overflow: 'hidden', paddingX: viewport.columns >= 70 ? 2 : 0 },
    React.createElement(HeaderLine, { left: React.createElement(Brand, { suffix: screen === 'home' ? '任务入口' : '已有 Mission' }) }),
    line(screen === 'home' ? '从一个任务开始' : '选择要进入的任务', { bold: true }),
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      screen === 'home' ? React.createElement(React.Fragment, null,
        card(0, `[1] 进入已有 Mission${loaded ? ` · ${rows.length} 个任务` : ' · 正在连接'}`, '查看进度、候选和测试结果，继续已有工作。'),
        card(1, '[2] 创建新 Mission', '连接源码，填写算子、语言与目标，创建新的开发任务。'),
        !compact && selected ? line(`当前任务  ${selected.title} · ${displayStatus(selected.status)}`, { dimColor: true }) : null,
        !compact && loaded && !rows.length ? line('暂无任务，可以创建你的第一个 Mission。', { dimColor: true }) : null,
      ) : React.createElement(React.Fragment, null,
        line(loaded ? `${rows.length} 个任务 · ${rows.length ? `${index + 1}/${rows.length}` : '列表为空'}` : '正在读取已有任务…', { dimColor: true }),
        ...rows.slice(start, start + capacity).map(row => React.createElement(Box, { key: row.id, flexDirection: 'column' },
          React.createElement(Box, null,
            React.createElement(Box, { width: '72%' }, line(`${row.id === selected?.id ? '›' : ' '} ${row.title}`, { bold: row.id === selected?.id, color: row.id === selected?.id ? theme.accent : undefined })),
            React.createElement(Box, { width: '28%' }, line(displayStatus(row.status), { color: row.status === 'failed' ? theme.error : theme.muted }))),
          !compact ? line(`  ${row.language} · ${row.target}`, { dimColor: true }) : null)),
        loaded && !rows.length ? line('还没有 Mission。按 N 创建新任务。', { dimColor: true }) : null,
        !compact && selected ? React.createElement(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'single', borderColor: theme.muted, paddingX: 1 },
          line(`${selected.id} · ${selected.operator}`, { dimColor: true }),
          line(selected.goal), line(selected.repository, { dimColor: true })) : null,
      )),
    line(message || ' ', { color: busy ? theme.accent : theme.warn }),
    busy ? line('正在打开任务，请稍候…', { color: theme.muted }) : React.createElement(KeyBar, { items: [
      { key: '↑↓', label: '选择' }, { key: 'Enter', label: screen === 'home' ? '进入' : '打开' }, { key: 'N', label: '新建' },
      screen === 'home' ? { key: 'Q', label: '退出' } : { key: 'Esc', label: '返回' }] }),
  );
};
