import React from 'react';
import { Box, Text } from 'ink';
import { Brand, displayWidth, theme } from './chrome.mjs';
import { feedbackText } from '../operation-feedback.mjs';

export const detailCapacity = viewport => Math.max(1, (viewport?.rows || 30) - 7);
export const physicalDetailLines = (lines, viewport = {}) => {
  const width = Math.max(8, (viewport.columns || 80) - 4);
  return lines.flatMap(line => feedbackText(line).split(/\r\n|\r|\n/u).flatMap(part => {
    const rows = []; let row = '';
    for (const char of part) {
      if (row && displayWidth(row + char) > width) { rows.push(row); row = ''; }
      row += char;
    }
    rows.push(row); return rows;
  }));
};

export const OperationDetails = ({ title = '任务说明', lines = [], offset = 0, viewport = {} }) => {
  const physical = physicalDetailLines(lines, viewport), capacity = detailCapacity(viewport);
  const start = Math.max(0, Math.min(offset, Math.max(0, physical.length - capacity)));
  return React.createElement(Box, { flexDirection: 'column', paddingX: 1, height: Math.max(1, (viewport.rows || 30) - 2), overflow: 'hidden' },
    React.createElement(Brand, { suffix: title }),
    React.createElement(Text, { color: theme.muted }, '完整说明 · 只读'),
    ...physical.slice(start, start + capacity).map((line, index) => React.createElement(Text, { key: start + index, wrap: 'truncate-end' }, line || ' ')),
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(Text, { color: theme.muted }, `${start + 1}—${Math.min(physical.length, start + capacity)} / ${physical.length} 行`),
    React.createElement(Text, { color: theme.accent, wrap: 'truncate-end' }, '[↑↓/PgUp/PgDn] 翻页  [Esc] 返回'));
};
