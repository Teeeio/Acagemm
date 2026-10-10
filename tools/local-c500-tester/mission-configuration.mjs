import {
  copyMissionFormItem, deriveMissionForm, editMissionForm, missionDraftIssue, missionDimensionNote,
  missionFieldRow, missionFormFields, missionFormHint, missionSubmitLabel,
} from './mission-form.mjs';

// Presentation navigation only. Editor identity is transient React state; the
// form DTO and its validation/serialization remain owned by mission-form/spec.
const compact = (draft) => draft.mode === 'generic' && draft.inputMode === 'form';
const pending = (row) => ['empty', 'error'].includes(row.state);
const tensorEditor = (field) => /^(tensor:(?:inputs|outputs):\d+):/u.exec(field)?.[1];
const shapeEditor = (field) => /^(shape:\d+):/u.exec(field)?.[1];
const itemField = (editor) => editor.replace(/^tensor:/u, 'tensorItem:').replace(/^shape:/u, 'shapeItem:');
const editorOf = (field) => field.replace(/^tensorItem:/u, 'tensor:').replace(/^shapeItem:/u, 'shape:');
const itemFields = (draft, editor) => missionFormFields(draft).filter((field) => field.startsWith(`${editor}:`) && !field.endsWith(':delete'));
const action = (field, label, value, note) => ({ field, label, shortLabel: label, value, text: value, kind: 'action', state: 'optional', ...(note ? { note: { tone: 'muted', text: note } } : {}) });

const configurationGroups = (draft) => {
  const fields = missionFormFields(draft);
  const semanticStart = fields.findIndex((field) => field.startsWith('tensor'));
  const testStart = fields.indexOf('seed'), submitStart = fields.indexOf('execution');
  const semantic = [...new Set(fields.slice(semanticStart, testStart).filter((field) => !field.startsWith('shape')).map((field) => {
    const editor = tensorEditor(field);
    return editor ? itemField(editor) : field;
  }))];
  const shapes = [...new Set(fields.filter((field) => field.startsWith('shape')).map((field) => {
    const editor = shapeEditor(field);
    return editor ? itemField(editor) : field;
  }))];
  return [
    { title: '任务与素材', fields: fields.slice(0, semanticStart) },
    { title: '张量与语义', fields: semantic },
    { title: '测试与性能', fields: [...shapes, ...fields.slice(testStart, submitStart)] },
    { title: '确认与提交', fields: [...fields.slice(submitStart), 'configurationReview'] },
  ];
};

const itemRow = (draft, field) => {
  const editor = editorOf(field);
  const parts = itemFields(draft, editor).map((name) => missionFieldRow(draft, name));
  const problem = parts.find(pending);
  const dimensionNote = editor.startsWith('tensor:') ? missionDimensionNote(draft, `${editor}:shape`) : null;
  const get = (part) => parts.find((row) => row.field === `${editor}:${part}`)?.text || '';
  let label, value;
  if (editor.startsWith('tensor:')) {
    const [, side, index] = editor.split(':');
    label = `${side === 'inputs' ? '输入' : '输出'} ${Number(index) + 1}`;
    const dims = parts.filter((row) => /:dim:/u.test(row.field)).map((row) => row.text || '?');
    const layout = parts.find((row) => row.field === `${editor}:layout`)?.options?.find((option) => option.selected)?.label || '布局待选';
    value = `${get('name') || '未命名'}  ${get('dtype') || '类型待选'}  [${dims.join(' × ')}]  ${layout}`;
  } else {
    const index = Number(editor.split(':')[1]);
    const name = get('name');
    label = `shape ${index + 1}${name && name.trim() === draft.primaryProfile?.trim() ? ' ★' : ''}`;
    const dims = parts.filter((row) => /:dim:/u.test(row.field)).map((row) => `${row.field.split(':').at(-1)}=${row.text || '?'}`);
    value = `${name || '未命名'}  ${dims.join(' · ')}`;
  }
  return { ...action(field, label, value), state: problem?.state || 'ok', problem: problem?.problem,
    note: problem ? { tone: 'warn', text: `待完善：${problem.shortLabel} · ${problem.problem || '请填写'}` }
      : dimensionNote || { tone: 'muted', text: 'Enter 编辑 · 单项页面中可复制、删除' } };
};

const reviewRows = (draft) => {
  const value = (field) => missionFieldRow(draft, field).value;
  const tensors = ['inputs', 'outputs'].map((side) => configurationGroups(draft)[1].fields.filter((field) => field.startsWith(`tensorItem:${side}:`)).map((field) => itemRow(draft, field)));
  const shapes = draft.benchmarkShapes || [];
  const data = [
    ['任务', `${draft.operator || '未命名'} · ${value('language')} · ${value('target')}`],
    ['目标架构', draft.targetArchitecture ? `${draft.targetArchitecture} · 用户声明，首轮可检索；未经实测确认` : '未指定 · 架构专属经验暂不匹配，仍可开发'],
    ['优化目标', draft.goal || '待填写'],
    ['计算语义', draft.semanticMath || '待填写'],
    ['不变约束', draft.semanticConstraints || '待填写'],
    ['边界行为', draft.semanticBoundaries || '待填写'],
    ...tensors.flatMap((items, side) => items.length ? items.map((row) => [row.label, row.value]) : [[side ? '输出张量' : '输入张量', '尚未添加']]),
    ['正确性', `${draft.requestedCases || '?'} 例 · ${draft.requiredCategories || '类别待选'} · 种子 ${draft.seed || '?'}`],
    ['通用容差', `atol ${draft.atol || '?'} · rtol ${draft.rtol || '?'} · 余弦 < ${draft.cosineTolerance || '?'}`],
    ...Object.entries(draft.dtypeTolerance || {}).filter(([, v]) => String(v).trim()).map(([dtype, v]) => [`${dtype} 容差`, String(v)]),
    ['性能场景', shapes.length ? shapes.map((item) => item.name || '未命名').join('、') : draft.requiredProfiles || '待填写'],
    ...shapes.map((item, index) => [item.name || `shape ${index + 1}`, Object.entries(item.dims || {}).map(([dim, size]) => `${dim}=${size || '?'}`).join(' · ')]),
    ['性能判定', draft.acceptancePolicyMode === 'protected' ? `保护 ${draft.protectedProfiles === 'all' ? '全部已声明场景' : draft.protectedProfiles || '待选'}；延迟退化 ≤ ${draft.maxRegressionPercent || '0'}%；主场景 ${draft.primaryProfile || '待选'} 判断目标` : `primary-only · 主场景 ${draft.primaryProfile || '待选'}`],
    ['采用与达标', draft.acceptancePolicyMode === 'protected' ? '全矩阵正确可用、保护场景通过且严格优于已有最佳才可保留；达到冻结目标另行标记，持平不算优化' : '未启用回退保护；必测场景不是保护场景'],
    ['测量参数', `预热 ${draft.warmup || '?'} · 测量 ${draft.repeats || '?'} · 收敛 ${draft.settleTolerance || '?'} / ${draft.maxSettlements || '?'}`],
    ['参考实现', draft.baselineFile || '未配置 · 可保存，启动前需补齐'],
    ['执行方式', missionSubmitLabel(draft)],
    ['预算', draft.timeBudget ? `${Number(draft.timeBudget) / 60000} 分钟（${draft.timeBudget} ms）` : '未设置总预算'],
  ];
  return [...data.map(([label, value], index) => ({ ...action(`review:${index}`, label, value), kind: 'summary' })),
    action('reviewSubmit', '确认提交', missionSubmitLabel(draft)), action('item:done', '返回修改', '返回配置总览')];
};

export const missionConfigurationFields = (draft, editor = null) => {
  if (!compact(draft)) return missionFormFields(draft);
  if (editor === 'review') return reviewRows(draft).map((row) => row.field);
  if (editor) return [...itemFields(draft, editor), ...(editor.startsWith('shape:') ? ['item:primary'] : []), 'item:done', 'item:copy', 'item:delete'];
  return configurationGroups(draft).flatMap((group) => group.fields);
};

const currentRow = (draft, field, editor) => {
  if (/^(tensorItem|shapeItem):/u.test(field)) return itemRow(draft, field);
  if (field === 'configurationReview') return action(field, '检查并提交', '查看完整配置摘要 →');
  if (field === 'item:done') return action(field, '完成编辑', '返回总览 · 修改保留在草稿中');
  if (field === 'item:copy') return action(field, '复制一份', '保留参数，使用新名称');
  if (field === 'item:delete') return action(field, '删除此项', editor?.startsWith('shape:') ? '删除此 shape' : '删除此张量');
  if (field === 'item:primary') {
    const name = draft.benchmarkShapes?.[Number(editor.split(':')[1])]?.name;
    return action(field, '设为主场景', name && name === draft.primaryProfile ? '★ 当前主场景' : draft.acceptancePolicyMode === 'protected'
      ? '以此 shape 判断成功目标（保护规则仍适用其他场景）' : 'primary-only：其他场景未启用回退保护');
  }
  return missionFieldRow(draft, field);
};

const fieldHint = (draft, field, editor) => {
  if (editor === 'review') return '检查本次配置；仅在“确认提交”执行创建。Esc 返回修改，Ctrl+S 可保存草稿。';
  if (editor) {
    if (field === 'item:primary') return draft.acceptancePolicyMode === 'protected'
      ? '主场景判断成功目标；其他 shape 仍完整测试，并按已声明保护规则限制退化。'
      : '主场景决定性能采用；其他 shape 仍完整测试，但未启用回退保护。';
    if (field.startsWith('item:')) return '修改实时保留在当前草稿中；Esc 返回总览，Ctrl+S 保存草稿。';
    return missionFormHint(draft, field).replace(/Ctrl\+D 删除这个 shape。/gu, 'Esc 返回总览。');
  }
  if (/^(tensorItem|shapeItem):/u.test(field)) return 'Enter 打开单项编辑 · PgUp/PgDn 切换分组 · Ctrl+S 保存草稿';
  if (field === 'configurationReview') return '先查看任务、张量、测试和执行方式，再确认提交。';
  return missionFormHint(draft, field);
};

export const deriveMissionConfiguration = (draft, fieldIndex = 0, viewport = {}, editor = null) => {
  if (!compact(draft)) return deriveMissionForm(draft, fieldIndex, viewport);
  const fields = missionConfigurationFields(draft, editor);
  const index = Math.max(0, Math.min(fields.length - 1, fieldIndex));
  const capacity = Math.max(1, (viewport.rows || 30) - 11);
  const summaryRows = editor === 'review' ? reviewRows(draft) : null;
  const allRows = fields.map((field) => summaryRows?.find((row) => row.field === field) || currentRow(draft, field, editor));
  const groups = editor ? [{ title: editor === 'review' ? '提交预览' : editor.startsWith('shape:') ? '编辑性能 shape' : '编辑张量', fields }] : configurationGroups(draft);
  const groupIndex = groups.findIndex((group) => group.fields.includes(fields[index]));
  const group = groups[groupIndex];
  const within = group.fields.indexOf(fields[index]);
  const start = Math.floor(within / capacity) * capacity;
  const before = groups.slice(0, groupIndex).reduce((sum, item) => sum + Math.ceil(item.fields.length / capacity), 0);
  const total = groups.reduce((sum, item) => sum + Math.ceil(item.fields.length / capacity), 0);
  const issue = missionDraftIssue(draft);
  return {
    height: Math.max(1, (viewport.rows || 30) - 2), compact: true, editor,
    title: editor === 'review' ? '提交预览' : editor ? `${group.title} · ${currentRow(draft, itemField(editor)).value}` : null,
    group: editor ? group.title : `${groupIndex + 1}/${groups.length} · ${group.title}`,
    groups: groups.map((item, at) => ({ title: item.title, total: item.fields.length, done: item.fields.filter((field) => !pending(allRows.find((row) => row.field === field))).length, active: at === groupIndex })),
    rows: group.fields.slice(start, start + capacity).map((field) => ({ ...allRows.find((row) => row.field === field), selected: field === fields[index] })),
    page: `${before + Math.floor(within / capacity) + 1}/${total}`, pageCount: total,
    hint: fieldHint(draft, fields[index], editor), submitLabel: missionSubmitLabel(draft),
    ready: !issue, blocking: missionFormFields(draft).filter((field) => pending(missionFieldRow(draft, field))).length,
  };
};

export const missionConfigurationIssue = (draft) => {
  const issue = missionDraftIssue(draft);
  if (!issue || !compact(draft)) return issue;
  const field = missionFormFields(draft)[issue.fieldIndex];
  const editor = tensorEditor(field || '') || shapeEditor(field || '') || null;
  return { ...issue, editor, fieldIndex: Math.max(0, missionConfigurationFields(draft, editor).indexOf(field)) };
};

export const editMissionConfiguration = ({ draft, fieldIndex = 0, editor = null, input = '', key = {}, viewport = {} }) => {
  if (!compact(draft)) return { ...editMissionForm({ draft, fieldIndex, input, key }), editor: null };
  const fields = missionConfigurationFields(draft, editor);
  const index = Math.max(0, Math.min(fields.length - 1, fieldIndex));
  const field = fields[index];
  const result = { draft, fieldIndex: index, editor, submit: false };
  const close = (nextDraft = draft) => {
    const overview = missionConfigurationFields(nextDraft);
    const wanted = editor === 'review' ? 'configurationReview' : itemField(editor);
    const fallback = editor?.startsWith('shape:') ? 'shapeAdd' : `tensorAdd:${editor?.split(':')[1]}`;
    return { ...result, draft: nextDraft, editor: null, fieldIndex: Math.max(0, overview.indexOf(wanted) >= 0 ? overview.indexOf(wanted) : overview.indexOf(fallback)) };
  };
  const open = (nextDraft, nextEditor, firstField) => ({ ...result, draft: nextDraft, editor: nextEditor, fieldIndex: Math.max(0, missionConfigurationFields(nextDraft, nextEditor).indexOf(firstField)) });
  if (editor && (key.escape || key.return && field === 'item:done')) return close();
  const direction = key.upArrow || key.tab && key.shift ? -1 : key.downArrow || key.tab ? 1 : 0;
  if (direction) return { ...result, fieldIndex: (index + direction + fields.length) % fields.length };
  if (key.pageUp || key.pageDown) {
    if (editor) return { ...result, fieldIndex: Math.max(0, Math.min(fields.length - 1, index + (key.pageDown ? 1 : -1) * Math.max(1, (viewport.rows || 30) - 11))) };
    const groups = configurationGroups(draft), at = groups.findIndex((group) => group.fields.includes(field));
    return { ...result, fieldIndex: fields.indexOf(groups[(at + (key.pageDown ? 1 : -1) + groups.length) % groups.length].fields[0]) };
  }
  if (editor === 'review') return key.return && field === 'reviewSubmit' ? { ...result, submit: true }
    : key.return ? { ...result, fieldIndex: (index + 1) % fields.length } : result;
  if (editor && (key.return && field === 'item:delete' || key.ctrl && input === 'd')) {
    const target = `${editor}:name`;
    const removed = editMissionForm({ draft, fieldIndex: missionFormFields(draft).indexOf(target), key: { ctrl: true }, input: 'd' });
    return close(removed.draft);
  }
  if (editor && key.return && field === 'item:copy') {
    const copied = copyMissionFormItem(draft, editor);
    return copied.issue ? { ...result, issue: copied.issue } : open(copied.draft, copied.editor, `${copied.editor}:name`);
  }
  if (editor && key.return && field === 'item:primary') {
    const name = draft.benchmarkShapes?.[Number(editor.split(':')[1])]?.name?.trim();
    if (!name) return { ...result, issue: '请先填写 shape 名称。' };
    const changed = editMissionForm({ draft, fieldIndex: missionFormFields(draft).indexOf(`${editor}:name`), input: '*' });
    return { ...result, draft: changed.draft };
  }
  if (key.return && /^(tensorItem|shapeItem):/u.test(field)) return open(draft, editorOf(field), `${editorOf(field)}:name`);
  if (key.return && field === 'configurationReview') return open(draft, 'review', 'review:0');
  if (field.startsWith('item:') || /^(tensorItem|shapeItem):/u.test(field) || field === 'configurationReview') return result;
  const baseIndex = missionFormFields(draft).indexOf(field);
  if (key.return && (field.startsWith('tensorAdd:') || field.startsWith('tensorTemplate:') || field === 'shapeAdd')) {
    if (field === 'shapeAdd' && (draft.benchmarkShapes || []).length >= 16) return { ...result, issue: '最多配置 16 个性能 shape。' };
    const added = editMissionForm({ draft, fieldIndex: baseIndex, key });
    const landing = missionFormFields(added.draft)[added.fieldIndex];
    return open(added.draft, tensorEditor(landing) || shapeEditor(landing), landing);
  }
  if (key.return && field === 'baselineFile' && draft.sourceMode === 'managed') return { ...result, browseSources: true, browseBaseline: true };
  if (key.return && field !== 'sourceFiles') return { ...result, fieldIndex: (index + 1) % fields.length };
  const edited = editMissionForm({ draft, fieldIndex: baseIndex, input, key });
  const nextFields = missionConfigurationFields(edited.draft, editor);
  return { ...result, ...edited, editor: compact(edited.draft) ? editor : null, fieldIndex: Math.max(0, nextFields.indexOf(field)) };
};
