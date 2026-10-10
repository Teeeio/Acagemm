const statusNames = {
  idle: '空闲',
  pending: '等待中',
  awaiting_backend: '等待测试后端',
  baseline_running: '基线测试中',
  baseline_complete: '基线已完成',
  candidate_running: '候选测试中',
  results_ready: '结果待处理',
  settled: '评价已记录',
  feedback_pending: '等待反馈处理',
  blocked: '推进受阻',
  untested: '未测试',
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
  'WAITING FOR TEST BACKEND': '等待测试后端',
  'FROZEN TEST RESULT': '冻结候选测试结果',
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
  awaiting_backend: '已冻结，等待测试',
};

export const displayDisposition = (value) => {
  const raw = String(value ?? '--');
  const zh = dispositionNames[raw];
  return zh && zh !== raw ? bilingual(zh, raw) : displayStatus(raw);
};

const bannerNames = {
  READY: '就绪',
  'WAITING FOR TEST BACKEND': '等待测试后端',
  'ACTION REQUIRED': '需要操作',
  PAUSED: '已暂停',
  FAILED: '失败',
  COMPLETED: '已完成',
  TESTING: '测试中',
  AGENT: '智能体',
  ACTIVE: '运行中',
};

// Chinese-only banner for the Ink panel: "PAUSED / operator pause" -> "已暂停 · 操作员暂停".
export const displayBannerText = (value) => {
  const [head, ...rest] = String(value ?? '').split(' / ');
  const reason = rest.join(' / ').split(' · ').map((part) => statusNames[part.trim()] || displayValue(part)).filter(Boolean).join(' · ');
  const title = bannerNames[head] || head;
  return reason ? `${title} · ${reason}` : title;
};

export const displayBanner = (value) => {
  const raw = String(value ?? '');
  const match = raw.match(/^([^ /]+(?: [^ /]+)?)\s*\/\s*(.*)$/);
  if (!match || !bannerNames[match[1]]) return raw;
  return `${bannerNames[match[1]]} / ${match[2]} (${raw})`;
};

// Raw runtime values that reach the Chinese work panel (reason codes, kinds,
// test-spec category/profile names). Chinese only; unknown values pass through.
const valueNames = {
  missing: '缺失', complete: '已就绪', ready: '已就绪', frozen: '已冻结', draft: '草稿',
  'operator pause': '操作员暂停', stopped_by_tester: '测试者停止',
  round_budget: '单轮预算用尽', total_budget: '总预算用尽', round_budget_invalid: '单轮预算无效',
  budget_exhausted: '预算用尽', completed_budget: '预算内完成', awaiting_backend: '等待测试后端',
  external_verification: '等待外部验证', patch_policy_rejected: '补丁策略拒绝',
  candidate_generation_failed: '候选生成失败', candidate_generation_cancelled: '候选生成已取消',
  baseline_materializer_failed: '基线生成失败', baseline_test_failed: '基线测试失败',
  baseline_source_unresolved: '基线来源未确定', baseline_source_unverified: '基线来源未核验',
  research_disabled_source_unresolved: '调研已关闭且来源未确定',
  command_recovery_blocked: '命令恢复受阻', state_snapshot_corrupt: '状态快照损坏',
  pytorch_reference: 'PyTorch 参考实现', simulation: '模拟', live: '真机', cpu: 'CPU', mock: '硬件模拟', unknown: '未知',
  blocked: '不可发布', allowed: '可发布', waiting_external_verification: '等待外部验证',
  'publication.execution_not_live': '非真机执行', 'publication.restricted_environment': '受限环境',
  'publication.adoption_not_allowed': '未获采用', 'publication.diagnostics_unavailable': '缺诊断',
  'publication.diagnostics_ineligible': '诊断不合格',
  minimal: '最小', representative: '典型', boundary: '边界', ragged: '不规则', primary: '主档', small: '小规模',
  'fixed-profile': '固定档',
  // Stage details from the workflow topology.
  'source found': '已找到来源', 'run.py ready': 'run.py 已就绪', 'patch committed': '补丁已提交', 'workspace clean': '工作区已清理',
  'discovering source': '查找来源中', 'building run.py': '生成 run.py 中', generating: '生成中', evaluating: '评估中', 'Diff rejected': '差异被拒绝',
  'Diff verified; waiting for patch apply': '差异已核验，等待应用补丁', 'waiting for first runtime event': '等待首个运行事件',
  // Banner reasons and stages.
  'create or import a Mission': '创建或导入任务', working: '工作中', 'simulation only': '仅模拟', 'cpu only': '仅 CPU',
  'human input required': '需要人工输入', diagnosis: '诊断', candidate: '候选', validation: '验证', evidence: '证据',
  baseline: '基线', research: '调研', iteration: '迭代', decision: '决策', recovery: '恢复',
};

export const displayValue = (value) => {
  const raw = String(value ?? '').trim();
  if (valueNames[raw]) return valueNames[raw];
  const coverage = /^(\d+)\/(\d+) runs exact$/.exec(raw);
  if (coverage) return `${coverage[1]}/${coverage[2]} 次精确统计`;
  return raw;
};

const hotkeyNames = {
  Missions: '任务列表',
  Create: '创建',
  Experiences: '经验',
  Publish: '发布',
  Pause: '暂停',
  Resume: '恢复',
  'Submit test': '提交测试',
  'Receive results': '接收结果',
  'Next generation': '继续生成',
  Feedback: '反馈',
  Doctor: '诊断',
  Stop: '停止',
  Export: '导出',
  Quit: '退出',
};

export const displayHotkey = (value) => String(value ?? '').replace(/(\])\s*(Missions|Create|Experiences|Publish|Pause|Resume|Submit test|Receive results|Next generation|Feedback|Doctor|Stop|Export|Quit)$/, (_, close, name) => `${close} ${hotkeyNames[name]} (${name})`);
