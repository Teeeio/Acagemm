const domainTerms = [
  '算子', 'kernel', 'cuda', 'c500', '沐曦', 'metax', 'mxmaca', 'gemm', 'attention',
  'paged', 'decode', 'prefill', 'softmax', 'layernorm', 'flashinfer', 'triton', 'torch',
];

const workflowTerms = [
  '优化', '性能', '延迟', '吞吐', '带宽', '访存', '热点', '瓶颈', 'benchmark', 'profile',
  'profiler', 'tracer', 'correctness', '回归', '候选', 'patch', 'diff', '测试', '验证',
  '继续', '重试', '重新运行', '回退', '撤回', '采用', '比较', '分析',
  'rerun', 'retry', 'resume', 'isolation check',
];

const clearlyUnrelatedTerms = [
  '天气', '写诗', '讲笑话', '翻译这段', '订机票', '发邮件', '做饭', '股票', '新闻',
  'weather', 'poem', 'joke', 'translate this', 'book a flight',
];

const destructiveTerms = [
  '删除整个仓库', '清空整个仓库', '删除所有文件', '格式化磁盘', 'rm -rf', 'drop database',
];

export const MLA_OPTIMIZATION_TEST_GOAL = '优化 mla_paged_attention 在沐曦 C500 和 CUDA 参考环境上的 small-batch P50 延迟：主场景为 batch=1、seq_len=512、head_dim=128、FP16；定位 plan、workspace 和 host mirror 固定开销，在隔离 Mission 工作区生成候选 Patch；随后通过串行测试队列运行 Correctness、Benchmark、Tracer 和 Profiler。Accept Gate 要求 C500 P50 < 45 μs、24/24 正确且 CUDA 回归不超过 2%。';

const includesAny = (text, terms) => terms.some((term) => text.includes(term));

const missionContextText = (mission = {}) => [
  mission.title,
  mission.goal,
  mission.repository,
  mission.metric,
  ...(mission.hardware || []),
].filter(Boolean).join(' ').toLowerCase();

export function evaluateMissionIntent(goal, mission = {}) {
  const raw = String(goal || '').trim();
  const text = raw.toLowerCase();
  const context = missionContextText(mission);
  const suggestion = mission.id === 'MIS_01JH7R' || /mla|paged.*attention/.test(context)
    ? MLA_OPTIMIZATION_TEST_GOAL
    : `优化 ${mission.title || '当前算子'} 在 ${(mission.hardware || ['目标硬件']).join(' 和 ')} 上的 ${mission.metric || '目标性能指标'}，说明目标 shape、正确性门禁、性能阈值和允许修改的仓库范围。`;

  if (!raw) {
    return {
      status: 'needs_clarification',
      code: 'MISSION_INTENT_EMPTY',
      title: '还不能启动 Agent',
      message: '请输入算子、目标硬件、性能指标和验收条件。',
      missing: ['算子或 Kernel', '目标硬件', '性能指标', 'Accept Gate'],
      suggestions: [suggestion],
    };
  }

  if (includesAny(text, destructiveTerms)) {
    return {
      status: 'rejected',
      code: 'MISSION_INTENT_UNSAFE',
      title: '高风险指令已拦截',
      message: '该指令要求破坏 Mission 工作区边界，未交给 Coding Agent。请改为针对候选 Patch、检查点或单个文件的可恢复操作。',
      missing: [],
      suggestions: ['撤回当前候选 Patch 并恢复到最近检查点，然后重新分析性能瓶颈。'],
    };
  }

  if (includesAny(text, clearlyUnrelatedTerms)) {
    return {
      status: 'rejected',
      code: 'MISSION_INTENT_OUT_OF_SCOPE',
      title: '这不是算子优化任务',
      message: 'Operator Studio 只接收算子诊断、候选修改、测试验证、效果决策和知识沉淀指令，因此未启动 Agent。',
      missing: [],
      suggestions: [suggestion],
    };
  }

  const hasDomain = includesAny(text, domainTerms) || domainTerms.some((term) => context.includes(term) && text.includes(term));
  const hasWorkflow = includesAny(text, workflowTerms);
  const isContextualFollowUp = /^(继续|重试|重新运行|运行测试|生成\s*patch|回退|撤回|采用|比较候选|rerun|retry|resume)/i.test(raw);

  if ((hasDomain && hasWorkflow) || isContextualFollowUp) {
    return {
      status: 'accepted',
      code: 'MISSION_INTENT_ACCEPTED',
      title: '任务边界检查通过',
      message: '该指令属于当前算子优化 Mission，可以交给 Coding Agent。',
      missing: [],
      suggestions: [],
    };
  }

  return {
    status: 'needs_clarification',
    code: 'MISSION_INTENT_NEEDS_CLARIFICATION',
    title: '目标信息不足',
    message: '当前输入无法同时确认算子对象和优化动作，Agent 尚未启动。请补充目标 shape、指标或验收门禁。',
    missing: [
      ...(hasDomain ? [] : ['算子或 Kernel']),
      ...(hasWorkflow ? [] : ['优化、诊断或验证动作']),
    ],
    suggestions: [suggestion],
  };
}

export function assertMissionIntent(goal, mission) {
  const result = evaluateMissionIntent(goal, mission);
  if (result.status === 'accepted') return result;
  const error = new Error(result.message);
  error.status = 422;
  error.code = result.code;
  error.details = result;
  throw error;
}
