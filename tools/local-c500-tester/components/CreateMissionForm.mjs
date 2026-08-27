import React from 'react';
import { Box, Text } from 'ink';
import { fixedOperatorProfiles, getFixedOperatorProfile } from '../../../client-runtime/fixed-operator-profiles.mjs';

const rows = [
  ['profileId', 'Operator'],
  ['researchEnabled', 'Online research'],
  ['requireAuthority', 'Authority check'],
  ['timeBudget', 'Time budget (ms)'],
];

const display = (draft, key) => {
  if (key === 'profileId') return getFixedOperatorProfile(draft.profileId || fixedOperatorProfiles[0].id).title;
  if (key === 'researchEnabled') return draft[key] === false ? 'off' : 'on (non-blocking)';
  if (key === 'requireAuthority') return draft[key] === true ? 'required' : 'off (embedded profile)';
  return draft[key] || 'unlimited';
};

export const CreateMissionForm = ({ draft, fieldIndex = 0, message = '', busy = false }) => (
  React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    React.createElement(Text, { color: 'cyan', bold: true }, 'Publish Production Mission'),
    ...rows.map(([key, label], index) => React.createElement(
      Text,
      { key, color: index === fieldIndex ? 'green' : undefined },
      `${index === fieldIndex ? '>' : ' '} ${label.padEnd(18)} ${display(draft, key)}`,
    )),
    React.createElement(Text, { dimColor: true }, 'Left/Right: select · semantics/tests are fixed by the selected profile'),
    React.createElement(Text, null, ''),
    message ? React.createElement(Text, { color: busy ? 'yellow' : 'red' }, message) : React.createElement(Text, null, ''),
    React.createElement(Text, { inverse: true }, busy ? 'Publishing mission...' : '[Enter] Publish and start  [Tab] Next  [Esc] Cancel'),
  )
);
