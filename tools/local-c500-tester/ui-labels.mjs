const statusNames = {
  idle: '空闲',
  pending: '等待中',
  queued: '排队中',
  waiting: '等待中',
  running: '运行中',
  executing: '执行中',
  awaiting_action: '等待操作',
  generating: '生成中',
  completed: '已完成',
  published: '已发布',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已停止',
  paused: '已暂停',
  paused_budget: '预算暂停',
  needs_human: '需要人工处理',
  timed_out: '已超时',
  rejected: '已拒绝',
  passed: '通过',
  eligible: '可采用',
  testing: '测试中',
  reference: '参考结果',
  'hard failure': '硬失败',
  FROZEN: '已冻结',
  'READY TO FREEZE': '可冻结',
  'ALIGNMENT REQUIRED': '需要对齐',
  'NO SNAPSHOT': '无语义快照',
};

const titleNames = {
  'SOURCE RESEARCH': '源码调研',
  'SOURCE VERIFY': '源码核验',
  MATERIALIZER: '基线生成',
  'BASELINE MATERIALIZER': '基线生成器',
  'BASELINE TEST': '基线测试',
  CANDIDATE: '候选方案',
  TEST: '候选测试',
  'ACCEPT GATE': '验收门禁',
  ADOPT: '采用',
  ROLLBACK: '回退',
  WAITING: '等待中',
  'ACTION REQUIRED': '需要操作',
  'DIFF READY': '差异已就绪',
};

export const bilingual = (zh, en) => `${zh} (${en})`;

export const displayStatus = (value) => {
  const raw = String(value ?? '--');
  const zh = statusNames[raw];
  return zh && zh !== raw ? bilingual(zh, raw) : raw;
};

export const displayTitle = (value) => {
  const raw = String(value ?? '--');
  const candidate = raw.match(/^(CANDIDATE|AGENT RUN|DIFF READY)(?: · CANDIDATE)?(?: (\d+))?$/);
  if (candidate) {
    const prefix = candidate[1] === 'AGENT RUN' ? '智能体执行' : candidate[1] === 'DIFF READY' ? '差异已就绪' : '候选方案';
    const suffix = candidate[2] ? ` ${candidate[2]}` : '';
    return `${prefix}${suffix}`;
  }
  const zh = titleNames[raw];
  return zh || raw;
};

export const displayOwner = (value) => value === 'Agent' ? '智能体 (Agent)' : value === 'Fixed' ? '固定流程 (Fixed)' : String(value ?? '--');

export const displayBoolean = (value) => value === true ? '是 (yes)' : value === false ? '否 (no)' : String(value ?? '--');

export const displayEvidence = (value) => value === 'simulation' ? '模拟 (simulation)' : value === true ? '是 (yes)' : value === false ? '否 (no)' : String(value ?? '--');

const dispositionNames = {
  adopted: '已采用',
  eligible: '符合条件',
  reference: '仅作参考',
  testing: '测试中',
  pending: '待处理',
  'rollback complete': '已完成回退',
  'correctness repair': '正确性修复',
  'Agent working': '智能体处理中',
  'Diff ready': '差异已就绪',
};

export const displayDisposition = (value) => {
  const raw = String(value ?? '--');
  const zh = dispositionNames[raw];
  return zh && zh !== raw ? bilingual(zh, raw) : displayStatus(raw);
};

const bannerNames = {
  READY: '就绪',
  'ACTION REQUIRED': '需要操作',
  PAUSED: '已暂停',
  FAILED: '失败',
  COMPLETED: '已完成',
  TESTING: '测试中',
  AGENT: '智能体',
  ACTIVE: '运行中',
};

export const displayBanner = (value) => {
  const raw = String(value ?? '');
  const match = raw.match(/^([^ /]+(?: [^ /]+)?)\s*\/\s*(.*)$/);
  if (!match || !bannerNames[match[1]]) return raw;
  return `${bannerNames[match[1]]} / ${match[2]} (${raw})`;
};

const hotkeyNames = {
  Publish: '发布',
  Pause: '暂停',
  Resume: '恢复',
  Feedback: '反馈',
  Doctor: '诊断',
  Stop: '停止',
  Export: '导出',
  Quit: '退出',
};

export const displayHotkey = (value) => String(value ?? '').replace(/(\])\s*(Publish|Pause|Resume|Feedback|Doctor|Stop|Export|Quit)$/, (_, close, name) => `${close} ${hotkeyNames[name]} (${name})`);
