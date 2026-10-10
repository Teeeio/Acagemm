import React from 'react';
import { Box, Text } from 'ink';
import { Brand, HeaderLine, KeyBar, clipDisplay, clipDisplayStart, theme } from './chrome.mjs';
export const sourcePickerCapacity = (viewport = {}) => Math.max(1, (viewport.rows || 30) - 12);
export const inheritedSourceSelection = (selections, target) => {
  const normalize = value => String(value).replaceAll('\\', '/').replace(/\/+$/u, '');
  return selections.find(parent => normalize(target).startsWith(`${normalize(parent)}/`)) || null;
};
export const sourcePickerEntries = directory => [
  ...(directory?.parent ? [{ name: '上一级', path: directory.parent, directory: true, parent: true }] : []), ...(directory?.entries || []),
];
export const materialSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
export const sourcePickerActions = purpose => purpose === 'baseline'
  ? [['files', '浏览文件'], ['review', '已导入文件'], ['locations', '常用位置'], ['clear', '移除基线'], ['cancel', '取消']]
  : [['files', '浏览文件'], ['folder', '使用当前文件夹'], ['review', '已选清单'], ['locations', '常用位置'], ['apply', '确认添加'], ['cancel', '取消']];
// Shared read-only projection keeps the rendered and keyboard-selected rows identical.
export const sourcePickerRows = ({ directory, review = false, purpose, selections = [], preview = {}, baselineOptions = [] }) => {
  if (review && purpose === 'baseline') return baselineOptions.filter(option => option.value).map(option => ({ name: option.value, path: option.value, baseline: true }));
  if (review) return [...selections.map(value => ({ name: `移除来源：${value}`, path: value, remove: true })),
    ...(preview.files || []).map(file => ({ ...file, name: file.path, preview: true, canInclude: !!file.includedIgnored })),
    ...(preview.generatedFiles || []).map(file => ({ ...file, name: file.path, preview: true, disabled: true })),
    ...(preview.excludedFiles || []).map(file => ({ ...file, name: file.path, excluded: true, disabled: !file.canInclude }))];
  return sourcePickerEntries(directory).filter(entry => purpose !== 'baseline' || entry.directory || entry.name.endsWith('.py'))
    .map(entry => ({ ...entry, disabled: purpose === 'baseline' && !entry.directory && entry.name.toLowerCase() === 'run.py' }));
};
// Presentation only: no filesystem reads or persisted state mutation.
export const MissionSourcePicker = props => {
  const { directory, index = 0, selections = [], preview = {}, review = false, purpose = 'sources', actionIndex = -1, busy, message, viewport = {} } = props;
  const width = Math.max(20, (viewport.columns || 100) - 4), capacity = sourcePickerCapacity(viewport);
  const entries = sourcePickerRows(props), actions = sourcePickerActions(purpose), start = Math.floor(index / capacity) * capacity;
  const buttons = offset => React.createElement(Text, { wrap: 'truncate-end' }, ...actions.slice(offset, offset + 3).flatMap(([id, label], at) => [at ? '  ' : '',
    React.createElement(Text, { key: id, inverse: actionIndex === at + offset, color: actionIndex === at + offset ? theme.accent : theme.muted }, `[${label}]`)]));
  return React.createElement(Box, { flexDirection: 'column', paddingX: 1, height: Math.max(1, (viewport.rows || 30) - 2), overflow: 'hidden' },
    React.createElement(HeaderLine, { left: React.createElement(Brand, { suffix: purpose === 'baseline' ? '选择独立基线' : '添加源码素材' }), right: React.createElement(Text, { color: theme.muted }, '提交任务时复制') }),
    React.createElement(Text, { color: theme.muted, wrap: 'truncate-end' }, review ? purpose === 'baseline' ? '已导入的基线候选 · Enter 选择' : '确认文件边界 · Enter 移除来源 / 逐项选回依赖' : `位置：${clipDisplayStart(directory?.label || directory?.path || '正在读取…', width - 6)}`),
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      ...entries.slice(start, start + capacity).map((entry, offset) => {
        const selected = selections.includes(entry.path) || inheritedSourceSelection(selections, entry.path), focused = actionIndex < 0 && start + offset === index;
        const icon = entry.parent ? '↰' : entry.generated ? '+' : entry.excluded ? '×' : entry.directory ? '+' : entry.preview ? '✓' : selected ? '●' : '○';
        const tail = entry.generated ? '  系统生成入口 · 未执行/无证据' : entry.excluded ? `  ${entry.canInclude ? '可选回依赖' : '禁止导入'}：${entry.reason}` : entry.includedIgnored ? `  ${materialSize(entry.size)} · 已显式选回` : entry.disabled ? '  不可选：候选实现入口' : entry.preview ? `  ${materialSize(entry.size)}` : entry.directory && !entry.parent ? '/' : '';
        // A system-generated entry and an excluded source may share run.py.
        // Their roles, as well as paths, identify separate visible rows.
        const role = entry.remove ? 'remove' : entry.generated ? 'generated' : entry.excluded ? 'excluded' : entry.preview ? 'included' : 'browse';
        return React.createElement(Text, { key: `${role}:${entry.path}`, color: entry.disabled ? theme.muted : focused ? theme.accent : selected ? theme.ok : undefined, bold: focused, wrap: 'truncate-end' },
          `${focused ? '▌' : ' '} ${icon} ${clipDisplay(entry.name + tail, width - 5)}`);
      }), !entries.length ? React.createElement(Text, { color: theme.muted }, review ? '尚未选择文件。可返回浏览文件。' : '此处没有可选文件。') : null),
    React.createElement(Text, { wrap: 'truncate-end', color: theme.muted }, `${preview.files?.length || 0} 个确认素材 · ${preview.excludedFiles?.length || 0} 项排除 · ${preview.generatedFiles?.length || 0} 个系统入口 · ${materialSize(preview.totalBytes || 0)}${entries.length ? ` · ${start + 1}–${Math.min(entries.length, start + capacity)}/${entries.length}` : ''}`),
    React.createElement(Text, { wrap: 'truncate-end', color: message ? theme.warn : theme.muted }, busy ? '正在检查素材…' : message || (review && entries[index]?.excluded ? `${entries[index].path}：${entries[index].reason}` : null) || (purpose === 'baseline' ? '选中 .py 按 Enter 直接绑定；取消保留原配置。' : 'Space 勾选文件；进入文件夹后可选择“使用当前文件夹”。')),
    buttons(0), buttons(3),
    React.createElement(KeyBar, { items: [{ key: '↑↓', label: '浏览' }, { key: 'Enter', label: '选择' }, { key: 'Tab', label: '切换按钮' }, { key: 'Backspace', label: '上级' }, { key: 'Esc', label: '取消' }] }),
  );
};
