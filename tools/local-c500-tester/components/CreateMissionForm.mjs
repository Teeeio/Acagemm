import React from 'react';
import { Box, Text } from 'ink';
import { getFixedOperatorProfile, tuiOperatorProfiles } from '../../../client-runtime/fixed-operator-profiles.mjs';

const rows = [
  ['profileId', '算子配置 (Operator)'],
  ['researchEnabled', '在线调研 (Online research)'],
  ['requireAuthority', '权威性检查 (Authority check)'],
  ['timeBudget', '时间预算 (Time budget, ms)'],
];

const display = (draft, key) => {
  if (key === 'profileId') return getFixedOperatorProfile(draft.profileId || tuiOperatorProfiles[0].id).title;
  if (key === 'researchEnabled') return draft[key] === false ? '关闭 (off)' : '开启 (on, non-blocking)';
  if (key === 'requireAuthority') return draft[key] === true ? '必须 (required)' : '关闭 (off, embedded profile)';
  return draft[key] || '不限 (unlimited)';
};

export const CreateMissionForm = ({ draft, fieldIndex = 0, message = '', busy = false }) => (
  React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    React.createElement(Text, { color: 'cyan', bold: true }, '发布生产任务 (Publish Production Mission)'),
    ...rows.map(([key, label], index) => React.createElement(
      Text,
      { key, color: index === fieldIndex ? 'green' : undefined },
      `${index === fieldIndex ? '>' : ' '} ${label.padEnd(18)} ${display(draft, key)}`,
    )),
    React.createElement(Text, { dimColor: true }, '左右键：选择 · 语义和测试由所选配置固定 (semantics/tests fixed by profile)'),
    React.createElement(Text, null, ''),
    message ? React.createElement(Text, { color: busy ? 'yellow' : 'red' }, message) : React.createElement(Text, null, ''),
    React.createElement(Text, { inverse: true }, busy ? '正在发布任务 (Publishing mission...)' : '[Enter] 发布并启动  [Tab] 下一个  [Esc] 取消'),
  )
);
