import React from 'react';
import { Box, Text } from 'ink';

// Shared presentation tokens and primitives for the borderless TUI screens.
// Pure rendering: no state, no input handling, no runtime or API access.
export const theme = Object.freeze({
  accent: '#fab283', secondary: '#5c9cf5', muted: 'gray', ok: 'green', warn: 'yellow', error: 'red',
});

const wide = (code) => code >= 0x1100 && (code <= 0x115f
  || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
  || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
  || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd));
const charWidth = (char) => (wide(char.codePointAt(0)) ? 2 : 1);

// Terminal cell width: CJK and full-width characters occupy two cells.
export const displayWidth = (value) => Array.from(String(value ?? '')).reduce((sum, char) => sum + charWidth(char), 0);
export const padDisplay = (value, width) => {
  const text = String(value ?? '');
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
};
export const clipDisplay = (value, width) => {
  const text = String(value ?? '');
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of Array.from(text)) {
    if (used + charWidth(char) > width - 1) break;
    out += char;
    used += charWidth(char);
  }
  return `${out}…`;
};
// Keeps the end visible, for the field currently being typed into.
export const clipDisplayStart = (value, width) => {
  const text = String(value ?? '');
  if (displayWidth(text) <= width) return text;
  const chars = Array.from(text);
  let out = '';
  let used = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    if (used + charWidth(chars[index]) > width - 1) break;
    out = chars[index] + out;
    used += charWidth(chars[index]);
  }
  return `…${out}`;
};

export const Brand = ({ suffix = '' }) => React.createElement(Text, { wrap: 'truncate-end' },
  React.createElement(Text, { color: theme.accent, bold: true }, '◆ Operator Studio'),
  suffix ? React.createElement(Text, { bold: true }, `  ${suffix}`) : null);

// One header line: left content shrinks, right content keeps its width.
export const HeaderLine = ({ left, right }) => React.createElement(Box, { justifyContent: 'space-between', height: 1 },
  React.createElement(Box, { flexShrink: 1, flexGrow: 1, overflow: 'hidden' }, left),
  right ? React.createElement(Box, { flexShrink: 0, marginLeft: 2 }, right) : null);

export const Rule = ({ width = 80 }) => React.createElement(Text, { color: theme.muted, wrap: 'truncate-end' }, '─'.repeat(Math.max(1, width)));

// A bounded region. framed: rounded box with the title set into the top edge
// (`╭─ 标题 · note ────╮`), costing 2 lines. Unframed (tight heights): a titled
// rule line, costing 1. `height` is the total including chrome; content that
// does not fit is clipped. Children receive `panelContentWidth(width, framed)`.
export const panelContentWidth = (width, framed = true) => Math.max(8, width - (framed ? 4 : 2));
export const Panel = ({ title, note = '', width, height, framed = true, color = theme.muted, titleColor = theme.secondary, children }) => {
  const label = ` ${title} `;
  const room = Math.max(0, width - 3 - displayWidth(label));
  const noteText = note && room > 4 ? `${clipDisplay(note, room - 2)} ` : '';
  const fill = Math.max(0, width - 3 - displayWidth(label) - displayWidth(noteText));
  const edge = React.createElement(Text, { wrap: 'truncate-end' },
    React.createElement(Text, { color }, framed ? '╭─' : '──'),
    React.createElement(Text, { color: titleColor, bold: true }, label),
    noteText ? React.createElement(Text, { color: theme.muted }, noteText) : null,
    React.createElement(Text, { color }, `${'─'.repeat(fill)}${framed ? '╮' : '─'}`));
  const body = framed
    ? React.createElement(Box, {
      flexDirection: 'column', width, height: height ? Math.max(1, height - 1) : undefined, overflow: 'hidden',
      borderStyle: 'round', borderColor: color, borderTop: false, paddingX: 1,
    }, children)
    : React.createElement(Box, { flexDirection: 'column', width, height: height ? Math.max(0, height - 1) : undefined, overflow: 'hidden', paddingLeft: 2 }, children);
  return React.createElement(Box, { flexDirection: 'column', width, flexShrink: 0 }, edge, body);
};

// Bottom key bar: `[key] label` chips. Each chip stays contiguous text.
export const KeyBar = ({ items = [] }) => React.createElement(Text, { wrap: 'truncate-end' },
  ...items.filter(Boolean).flatMap((item, index) => [
    index ? '  ' : '',
    React.createElement(Text, { color: theme.accent, bold: true }, `[${item.key}]`),
    React.createElement(Text, { color: theme.muted }, ` ${item.label}`),
  ]));

// Hotkey strings from the view model ("[M] Missions") -> chips with the
// Chinese label only; the English name stays in renderDashboardSnapshot.
export const hotkeyChip = (hotkey, translate = (value) => value) => {
  const match = /^\[([^\]]+)\]\s*(.*)$/u.exec(String(hotkey || ''));
  if (!match) return { key: String(hotkey || ''), label: '' };
  const translated = String(translate(hotkey) || '');
  const label = translated.replace(/^\[[^\]]+\]\s*/u, '').replace(/\s*\([^)]*\)\s*$/u, '');
  return { key: match[1], label: label || match[2] };
};
