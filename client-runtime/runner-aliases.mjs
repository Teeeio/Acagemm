const normalizeText = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replaceAll('智芯', '')
  .replace(/[·_\-\s/()（）]+/g, '');

const explicitAliases = new Map([
  ['gpuiluvatarmainstream', 'gpu-iluvatar-mainstream'],
  ['iluvatar', 'gpu-iluvatar-mainstream'],
  ['iluvatarmrv100', 'gpu-iluvatar-mainstream'],
  ['mrv100', 'gpu-iluvatar-mainstream'],
  ['天数', 'gpu-iluvatar-mainstream'],
  ['天数iluvatar', 'gpu-iluvatar-mainstream'],
  ['天数mrv100', 'gpu-iluvatar-mainstream'],

  ['npuascend910', 'npu-ascend-910'],
  ['ascend', 'npu-ascend-910'],
  ['ascend910', 'npu-ascend-910'],
  ['昇腾', 'npu-ascend-910'],
  ['昇腾910', 'npu-ascend-910'],
  ['华为昇腾', 'npu-ascend-910'],

  ['gpumuxic500', 'gpu-muxi-c500'],
  ['muxi', 'gpu-muxi-c500'],
  ['metax', 'gpu-muxi-c500'],
  ['metaxc500', 'gpu-muxi-c500'],
  ['c500', 'gpu-muxi-c500'],
  ['沐曦', 'gpu-muxi-c500'],
  ['沐曦c500', 'gpu-muxi-c500'],
  ['模力方舟沐曦', 'gpu-muxi-c500'],

  ['gpucuda', 'gpu-cuda'],
  ['cuda', 'gpu-cuda'],
  ['nvidia', 'gpu-cuda'],
]);

export const normalizeRunnerId = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = normalizeText(raw);
  if (explicitAliases.has(text)) return explicitAliases.get(text);
  if (text.includes('iluvatar') || text.includes('mrv100') || text.includes('天数')) return 'gpu-iluvatar-mainstream';
  if (text.includes('ascend') || text.includes('昇腾') || text.includes('910')) return 'npu-ascend-910';
  if (text.includes('muxi') || text.includes('metax') || text.includes('沐曦') || text.includes('c500')) return 'gpu-muxi-c500';
  if (text.includes('cuda') || text.includes('nvidia')) return 'gpu-cuda';
  return raw.toLowerCase();
};

export const runnerMatches = (left, right) => {
  const normalizedLeft = normalizeRunnerId(left);
  const normalizedRight = normalizeRunnerId(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
};

export const normalizeRunnerList = (values = []) => (Array.isArray(values) ? values : [values])
  .map(normalizeRunnerId)
  .filter(Boolean);
