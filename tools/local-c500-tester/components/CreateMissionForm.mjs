import React from 'react';
import { Box, Text } from 'ink';
import { createMissionDraft } from '../mission-form.mjs';
import { deriveMissionConfiguration } from '../mission-configuration.mjs';
import { Brand, HeaderLine, KeyBar, Rule, clipDisplay, clipDisplayStart, displayWidth, theme } from './chrome.mjs';

// Borderless create-Mission form. Presentation only: the draft, focus and
// validation come from mission-form.mjs; submission rules stay in the API.
// Chrome is fixed at 10 lines so deriveMissionForm's rows-11 capacity always
// leaves the key bar visible without Ink repainting the whole terminal.
const glyph = (row) => {
  if (row.selected) return React.createElement(Text, { color: theme.accent, bold: true }, '▌');
  return ' ';
};
const stateMark = (row) => ({
  ok: React.createElement(Text, { color: theme.ok }, '✓'),
  error: React.createElement(Text, { color: theme.error }, '✗'),
  empty: React.createElement(Text, { color: theme.muted }, '○'),
  optional: React.createElement(Text, { color: theme.muted }, '·'),
  inherit: React.createElement(Text, { color: theme.muted }, '·'),
}[row.state] || ' ');

const optionStrip = (options, width) => {
  const parts = options.map((option) => `${option.selected ? '●' : '○'} ${option.label}`);
  if (displayWidth(parts.join('  ')) > width) return null;
  return options.flatMap((option, index) => [
    index ? React.createElement(Text, { key: `gap-${index}` }, '  ') : null,
    React.createElement(Text, { key: option.label, color: option.selected ? theme.accent : theme.muted, bold: option.selected }, parts[index]),
  ]);
};

const choiceValue = (row, width) => {
  const options = row.options || [];
  const current = options.find((option) => option.selected);
  if (row.selected && options.length) {
    const strip = optionStrip(options, width);
    if (strip) return strip;
    const position = current ? `${options.indexOf(current) + 1}/${options.length}` : `0/${options.length}`;
    return [React.createElement(Text, { key: 'value', color: theme.accent, bold: true }, clipDisplay(`‹ ${current?.label || '请选择'} ›`, width - 6)),
      React.createElement(Text, { key: 'pos', color: theme.muted }, ` ${position}`)];
  }
  if (current) return React.createElement(Text, null, clipDisplay(current.label, width));
  if (row.state === 'inherit') return React.createElement(Text, { color: theme.muted }, '沿用规格');
  return React.createElement(Text, { color: theme.warn }, '请选择  ←→');
};

const textValue = (row, width) => {
  const cursor = row.selected ? React.createElement(Text, { key: 'cursor', inverse: true }, ' ') : null;
  if (!row.text && row.selected && row.options?.length) {
    const strip = optionStrip(row.options, width - 2);
    if (strip) return [cursor, ' ', ...strip];
    // Too narrow for the whole strip: keep the example, still say ←→ picks.
    const example = row.placeholder ? `例 ${row.placeholder}` : '';
    return [cursor, React.createElement(Text, { key: 'placeholder', color: theme.muted }, `${clipDisplay(example, width - 14)}  ←→ 有预选项`)];
  }
  if (!row.text) {
    const placeholder = row.placeholder
      ? (/^留空/u.test(row.placeholder) ? row.placeholder : `例 ${row.placeholder}`)
      : '';
    return [cursor, React.createElement(Text, { key: 'placeholder', color: theme.muted }, clipDisplay(placeholder, width - 2))];
  }
  const color = row.state === 'error' ? theme.error : undefined;
  if (row.selected && row.options?.length) {
    // Keep the ←→ hint visible: long template text is clipped from the start.
    const at = row.options.findIndex((option) => option.selected);
    const hint = at >= 0 ? `  ←→ ${at + 1}/${row.options.length}` : '  ←→ 选择';
    const shown = clipDisplayStart(row.text, Math.max(4, width - 2 - displayWidth(hint)));
    return [React.createElement(Text, { key: 'text', color }, shown), cursor, React.createElement(Text, { key: 'hint', color: theme.muted }, hint)];
  }
  const shown = row.selected ? clipDisplayStart(row.text, width - 2) : clipDisplay(row.text, width);
  return [React.createElement(Text, { key: 'text', color }, shown), cursor];
};

// Goal templates: ‹ 模板 › then the number being typed and its unit.
const presetValue = (row, width) => {
  const { label, unit, value } = row.preset;
  if (!row.selected) return React.createElement(Text, { color: row.state === 'error' ? theme.error : undefined }, clipDisplay(row.text || `${label} · 待填数值`, width));
  const head = React.createElement(Text, { key: 'preset', color: theme.accent, bold: true }, `‹ ${label} ›`);
  if (!unit) return [head, React.createElement(Text, { key: 'hint', color: theme.muted }, '  ←→ 切换模板')];
  return [head, ' ',
    React.createElement(Text, { key: 'value', color: row.state === 'error' ? theme.error : undefined }, value),
    React.createElement(Text, { key: 'cursor', inverse: true }, ' '),
    React.createElement(Text, { key: 'unit', color: theme.muted }, ` ${unit}`)];
};

const noteColor = (tone) => ({ ok: theme.ok, warn: theme.warn }[tone] || theme.muted);

const detailLine = (row) => {
  if (!row) return { color: theme.muted, text: '' };
  if (row.note && /^(tensorItem|shapeItem):/u.test(row.field)) return { color: noteColor(row.note.tone), text: row.note.text };
  if (row.field === 'item:delete') return { color: theme.warn, text: '只删除当前项，其他配置保留' };
  if (row.field.startsWith('item:') || row.field === 'configurationReview' || row.field === 'reviewSubmit') return { color: theme.muted, text: row.value };
  if (row.kind === 'summary') return { color: theme.muted, text: '只读预览 · Esc 返回修改 · PgUp/PgDn 翻页' };
  if (row.field === 'shapeAdd') {
    if (row.state === 'error') return { color: theme.error, text: `✗ ${row.problem}` };
    if (row.state === 'empty') return { color: theme.warn, text: `必填 · ${row.problem}` };
    if (row.note) return { color: noteColor(row.note.tone), text: row.note.text };
    return { color: theme.muted, text: 'Enter 添加一个 shape，然后逐个维度输入数值' };
  }
  if (row.field.startsWith('tensorAdd:')) return { color: row.state === 'empty' ? theme.warn : theme.muted, text: 'Enter 添加张量 · 维数、各维大小和布局逐项配置' };
  if (row.field.startsWith('tensorTemplate:')) return { color: theme.muted, text: 'Enter 从模板添加；已有张量不会被覆盖' };
  if (/^tensor:.*:delete$/u.test(row.field)) return { color: theme.warn, text: 'Enter 删除此张量，保留其他项；也可在张量字段按 Ctrl+D' };
  if (row.kind === 'action') return { color: theme.muted, text: 'Enter 打开选择器 · 可多选，也可留空' };
  if (row.field === 'baselineFile' && row.note && row.state !== 'error') return { color: noteColor(row.note.tone), text: row.note.text };
  if (row.state === 'error') return { color: theme.error, text: `✗ ${row.problem}` };
  if (row.state === 'empty') {
    if (row.kind === 'preset') return { color: theme.warn, text: `必填 · ${row.problem}` };
    const how = row.kind === 'choice' ? '用 ←→ 选择一项' : row.options?.length ? '←→ 选择或直接输入' : '直接输入';
    return { color: theme.warn, text: `必填 (required) · ${how}` };
  }
  if (row.note) return { color: noteColor(row.note.tone), text: row.note.text };
  if (row.state === 'optional') return { color: theme.muted, text: '可选 · 留空不影响提交' };
  if (row.state === 'inherit') return { color: theme.muted, text: '留空沿用规格文件中的值' };
  if (row.kind === 'choice' && row.options?.length > 1) return { color: theme.muted, text: '←→ 或空格切换' };
  return { color: theme.ok, text: '✓ 格式正确' };
};

const statusLine = ({ view, message, busy, issue, canSaveDraft, editingTensor }) => {
  if (busy) return React.createElement(Text, { color: theme.warn, wrap: 'truncate-end' }, message || '正在提交…');
  if (issue) return React.createElement(Text, { color: theme.error, wrap: 'truncate-end' }, `✗ ${issue}`);
  if (message) {
    const failed = /[A-Z][A-Z_]{3,}|失败|错误|无效|invalid|failed|error/u.test(message);
    return React.createElement(Text, { color: failed ? theme.error : theme.warn, wrap: 'truncate-end' }, message);
  }
  if (view.ready && view.compact) return React.createElement(Text, { color: theme.ok, wrap: 'truncate-end' }, view.editor === 'review'
    ? '✓ 配置完整 · 浏览摘要后，在“确认提交”创建任务' : '✓ 配置完整 · 在“确认与提交”查看摘要并创建任务');
  if (view.ready) return React.createElement(Text, { color: theme.ok, wrap: 'truncate-end' }, editingTensor
    ? '✓ 配置完整 · 编辑完成后在“提交与预算”页提交任务' : `✓ 可以提交 · 按 Enter ${view.submitLabel}`);
  return React.createElement(Text, { color: theme.muted, wrap: 'truncate-end' },
    view.blocking ? `执行前还需补齐 ${view.blocking} 项${canSaveDraft ? ' · Ctrl+S 保存草稿，稍后继续' : ' · 灰色示例不会被提交'}` : '请检查各项后提交');
};

const Tabs = ({ groups }) => React.createElement(Text, { wrap: 'truncate-end' },
  ...groups.flatMap((group, index) => {
    const complete = group.done === group.total;
    const count = complete ? '✓' : `${group.done}/${group.total}`;
    return [
      index ? React.createElement(Text, { key: `sep-${index}`, color: theme.muted }, '   ') : null,
      React.createElement(Text, {
        key: group.title,
        color: group.active ? theme.accent : complete ? theme.ok : theme.muted,
        bold: group.active,
      }, `${group.active ? '▸ ' : ''}${index + 1} ${group.title} ${count}`),
    ];
  }));

export const CreateMissionForm = ({ draft = createMissionDraft(), fieldIndex = 0, editor = null, message = '', busy = false, issue = '', viewport = {} }) => {
  const view = deriveMissionConfiguration(draft, fieldIndex, viewport, editor);
  const columns = Number.isFinite(viewport.columns) && viewport.columns > 0 ? Math.floor(viewport.columns) : 100;
  const inner = Math.max(20, columns - 4);
  const labelWidth = Math.min(Math.max(...view.rows.map((row) => displayWidth(view.compact ? row.shortLabel : row.label.replace(' / ', ' '))), view.compact ? 16 : 8) + 2, Math.floor(inner * 0.45));
  const valueWidth = Math.max(8, inner - labelWidth - 4);
  const selected = view.rows.find((row) => row.selected);
  const compactEnterLabel = selected?.field === 'item:delete' ? editor?.startsWith('shape:') ? '删除 shape' : '删除张量'
    : selected?.field === 'item:copy' ? '复制一份'
      : selected?.field === 'item:primary' ? '设为主场景'
        : selected?.field === 'item:done' ? '返回总览'
          : selected?.field === 'configurationReview' ? '查看摘要'
            : selected?.field === 'reviewSubmit' ? '确认提交'
              : /^(tensorItem|shapeItem):/u.test(selected?.field || '') ? '编辑'
                : selected?.field.startsWith('tensorTemplate:') ? '按模板添加'
                  : selected?.field.startsWith('tensorAdd:') ? '添加张量'
                    : selected?.field === 'shapeAdd' ? '添加 shape'
                      : selected?.field === 'sourceFiles' ? '选择素材' : selected?.field === 'baselineFile' && draft.sourceMode === 'managed' ? '选择基线' : '下一项';
  const enterLabel = view.compact ? compactEnterLabel : /^tensor:.*:delete$/u.test(selected?.field || '') ? '删除张量'
    : selected?.field.startsWith('tensorTemplate:') ? '按模板添加'
      : selected?.field.startsWith('tensorAdd:') ? '添加张量'
        : selected?.field.startsWith('tensor:') ? selected.field.endsWith(':layout') ? '完成张量' : '下一项'
          : selected?.field === 'shapeAdd' ? '添加 shape' : selected?.kind === 'action' ? '选择素材' : view.submitLabel;
  const detail = detailLine(selected);
  const page = view.pageCount > view.groups.length ? ` · 第 ${view.page} 页` : '';
  const canSaveDraft = draft.mode === 'generic' && draft.inputMode === 'form' && draft.sourceMode === 'managed';

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1, height: view.height, overflow: 'hidden' },
    React.createElement(HeaderLine, {
      left: React.createElement(Brand, { suffix: editor ? editor === 'review' ? '提交预览' : '编辑单项' : draft.draftId ? '继续配置任务' : '创建任务' }),
      right: React.createElement(Text, { color: theme.muted, wrap: 'truncate-end' }, `步骤 ${view.group}${page}`),
    }),
    editor ? React.createElement(Text, { color: theme.accent, wrap: 'truncate-end' }, `配置总览 › ${view.title}`) : React.createElement(Tabs, { groups: view.groups }),
    React.createElement(Rule, { width: inner }),
    // The detail line sits under the focused row; it is one of the 10 chrome lines.
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      ...view.rows.flatMap((row) => {
        const [zh, en] = view.compact ? [row.shortLabel, null] : row.label.split(' / ');
        const labelText = en ? `${zh} ${en}` : zh;
        const line = React.createElement(Text, { key: row.field, wrap: 'truncate-end' },
          glyph(row), ' ', stateMark(row), ' ',
          React.createElement(Text, { color: row.selected ? theme.accent : undefined, bold: row.selected }, zh),
          en ? React.createElement(Text, { color: theme.muted }, ` ${en}`) : null,
          ' '.repeat(Math.max(1, labelWidth - displayWidth(labelText))),
          ...[].concat(row.kind === 'choice' ? choiceValue(row, valueWidth) : row.kind === 'preset' ? presetValue(row, valueWidth) : ['action', 'summary'].includes(row.kind)
            ? React.createElement(Text, { color: row.field === 'item:delete' ? theme.warn : row.selected ? theme.accent : undefined }, clipDisplay(row.value, valueWidth)) : textValue(row, valueWidth)));
        return row.selected
          ? [line, React.createElement(Text, { key: `${row.field}-detail`, color: detail.color, wrap: 'truncate-end' },
            `${' '.repeat(labelWidth + 4)}${detail.text}`)]
          : [line];
      })),
    React.createElement(Rule, { width: inner }),
    React.createElement(Text, { color: theme.muted, wrap: 'truncate-end' }, view.hint),
    statusLine({ view, message, busy, issue, canSaveDraft, editingTensor: selected?.field.startsWith('tensor') }),
    busy
      ? React.createElement(Text, { color: theme.warn, wrap: 'truncate-end' }, '正在提交… 请稍候')
      : React.createElement(KeyBar, { items: [
        { key: 'Enter', label: enterLabel },
        { key: 'Esc', label: editor ? '返回总览' : '返回' },
        { key: 'Tab/↑↓', label: '选择' },
        canSaveDraft ? { key: 'Ctrl+S', label: '存草稿' } : null,
        view.compact ? { key: 'PgUp/Dn', label: editor ? '翻页' : '分组' } : null,
        selected?.options?.length ? { key: '←→', label: '选择' } : selected?.kind === 'text' ? { key: 'Ctrl+U', label: '清空' } : null,
        /^shape:\d+:name$/u.test(selected?.field || '') ? { key: '*', label: '设为主场景' } : null,
        selected?.field === 'requiredCategories' ? { key: '1-4', label: '切换类别' } : null,
        selected?.field === 'semanticConstraints' ? { key: '1-4', label: '切换约束' } : null,
        selected?.field.startsWith('tensor:') ? { key: 'Ctrl+D', label: '删除张量' } : null,
        selected?.field.startsWith('shape:') ? { key: 'Ctrl+D', label: '删除 shape' } : null,
      ] }),
  );
};
