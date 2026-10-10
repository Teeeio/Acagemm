import React from 'react';
import { Box, Text } from 'ink';
import { historyCapacity, historySections, missionHistoryLines } from '../mission-history.mjs';

export const MissionHistory = ({ document, section = 0, offset = 0, viewport, message = '', busy = false }) => {
  const lines = missionHistoryLines(document, section);
  const capacity = historyCapacity(viewport);
  const start = Math.max(0, Math.min(offset, lines.length - capacity));
  const row = (text, props = {}) => React.createElement(Text, { wrap: 'truncate-end', ...props }, text);
  return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    row('轨迹与评价 (Mission History)', { color: 'cyan', bold: true }),
    row(`${document?.report?.missionId || '未知任务'} · 快照 ${document?.report?.source?.snapshotAt || '时间未知'}`, { dimColor: true }),
    React.createElement(Box, { gap: 1 }, ...historySections.map((title, index) => row(`${index + 1} ${title}`, { key: title, inverse: section === index }))),
    ...lines.slice(start, start + capacity).map((line, index) => row(line, { key: start + index })),
    row(message || `${start + 1}—${Math.min(lines.length, start + capacity)} / ${lines.length} 行`, { dimColor: true }),
    row(busy ? '正在处理…' : '[1—5/Tab] 分类 [↑↓/PgUp/PgDn] 翻页 [R] 刷新 [E] 导出 [Esc] 返回', { inverse: true }),
  );
};
