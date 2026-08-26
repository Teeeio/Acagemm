import React from 'react';
import { Box, Text } from 'ink';

const rows = [
  ['goal', 'Goal'],
  ['title', 'Title'],
  ['repository', 'Project'],
  ['metric', 'Metric'],
  ['timeBudget', 'Time budget (ms)'],
];

export const CreateMissionForm = ({ draft, fieldIndex = 0, message = '', busy = false }) => (
  React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    React.createElement(Text, { color: 'cyan', bold: true }, 'Publish Production Mission'),
    ...rows.map(([key, label], index) => React.createElement(
      Text,
      { key, color: index === fieldIndex ? 'green' : undefined },
      `${index === fieldIndex ? '>' : ' '} ${label.padEnd(18)} ${draft[key] || (key === 'title' ? 'optional' : key === 'timeBudget' ? 'unlimited' : '')}`,
    )),
    React.createElement(Text, null, ''),
    message ? React.createElement(Text, { color: busy ? 'yellow' : 'red' }, message) : React.createElement(Text, null, ''),
    React.createElement(Text, { inverse: true }, busy ? 'Publishing mission...' : '[Enter] Publish and start  [Tab] Next  [Esc] Cancel'),
  )
);
