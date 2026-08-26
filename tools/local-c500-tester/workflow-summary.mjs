const measurementFor = (task) => task?.result?.benchmark?.[0] || null;

const row = (stage, executor, action, result, next) => `| ${stage} | ${executor} | ${action} | ${result} | ${next} |`;

export const renderWorkflowSummary = ({ state = {}, tasks = [], initialization = {}, error = null } = {}) => {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const events = state.runtimeEvents || [];
  const baselineTask = tasks.find((task) => task.payload?.purpose === 'baseline');
  const candidateTasks = tasks.filter((task) => task.payload?.purpose === 'candidate');
  const baselineValue = measurementFor(baselineTask)?.value;
  const rollbackEvents = events.filter((event) => event.type === 'workflow.round_rolled_back');
  const research = state.researchAgent || {};
  const materializer = state.baseline?.materializer || {};
  const researchErrorText = String(research.error?.message || '');
  const researchFailure = /UnknownIssuer/i.test(researchErrorText)
    ? 'Agent 网络连接失败（证书链 UnknownIssuer）'
    : research.error?.message
      ? 'Agent 运行失败'
      : null;
  const adoptedEvent = [...events].reverse().find((event) => event.type === 'decision.auto_adopted' && event.payload?.candidate === state.currentBest?.candidateId);
  const completed = state.stage === 'published'
    && candidateTasks.length === 3
    && state.currentBest?.candidateId
    && adoptedEvent?.payload?.gate?.passed === true;
  const blocked = state.iterationStats?.loopStatus === 'needs_human'
    || ['failed', 'timed_out'].includes(research.status)
    || ['failed', 'timed_out'].includes(materializer.status)
    || Boolean(error);
  const overall = completed ? 'PASS (simulation only)' : blocked ? 'BLOCKED' : 'INCOMPLETE';
  const rows = [];

  rows.push(row(
    '项目初始化',
    '固定工作流',
    '创建 Mission 描述、空代码仓库和空 Source Registry',
    `代码文件 ${initialization.codeFiles ?? '待检查'}，Source 条目 ${initialization.sourceEntries ?? '待检查'}`,
    '启动调研',
  ));

  if (research.runId || state.researchNotes?.length) {
    const source = state.researchNotes?.flatMap((note) => note.baselineSources || [])[0];
    rows.push(row(
      'Source 调研',
      'Research Agent',
      '从零查找上游实现并固定 repository、commit、path',
      source ? '权威来源已登记并验证' : researchFailure || `未形成可用来源（${research.phase || research.status || 'unknown'}）`,
      source ? '构建 baseline' : '等待人工处理',
    ));
  }

  if (materializer.runId) {
    rows.push(row(
      'Baseline 构建',
      'Materializer Agent + 固定工作流',
      '读取已验证来源，生成并校验单文件 reference',
      materializer.status === 'completed' ? 'Agent baseline 契约通过' : `${materializer.phase || materializer.status}`,
      materializer.status === 'completed' ? '排队 baseline 测试' : '等待生成完成',
    ));
  }

  if (baselineTask) {
    rows.push(row(
      'Baseline 测试',
      '固定工作流',
      '执行 C500 硬件测量 mock，并保留仿真来源标记',
      baselineTask.status === 'completed' ? `${baselineValue} us（simulation）` : baselineTask.status,
      baselineTask.status === 'completed' ? 'Candidate 1' : '等待测试完成',
    ));
  }

  candidateTasks.forEach((task, index) => {
    const ordinal = index + 1;
    const value = measurementFor(task)?.value;
    const improvement = Number.isFinite(Number(baselineValue)) && Number.isFinite(Number(value))
      ? ((Number(baselineValue) - Number(value)) / Number(baselineValue)) * 100
      : null;
    const passed = improvement != null && improvement >= 20;
    const rolledBack = rollbackEvents.some((event) => event.payload?.candidateDigest === task.payload?.candidate?.digest);
    const result = task.status !== 'completed'
      ? task.error?.message || task.status
      : passed
        ? `${value} us，提升 ${Number(improvement.toFixed(1))}%，达标`
        : `${value} us，提升 ${Number(improvement.toFixed(1))}%，未达标${rolledBack ? '，已回退' : ''}`;
    rows.push(row(
      `Candidate ${ordinal}`,
      'Iteration Agent + 固定工作流',
      '生成独立真实 Diff，执行测试和 Accept Gate',
      result,
      passed ? '自动采纳' : task.status === 'completed' ? `Candidate ${ordinal + 1}` : '停止',
    ));
  });

  if (state.currentBest?.candidateId) {
    rows.push(row(
      '采纳',
      '固定工作流',
      '将达标 Patch 提交到 Iteration Repository，并更新 current best',
      `${state.currentBest.value}（simulation，不可发布）`,
      '完成 Mission',
    ));
  }

  if (completed) {
    rows.push(row('完成', '固定工作流', '终止迭代并检查稳定状态', '三轮结束，未启动第四轮', '无'));
  } else if (blocked) {
    rows.push(row('停止', '固定工作流', '在真实 Agent 或来源硬门禁处停止', researchFailure || error?.message || state.iterationStats?.loopStatusReason || research.phase || materializer.phase || '流程未完成', '修复阻断后重跑'));
  }

  return [
    '# Workflow Summary',
    '',
    `Mission: ${mission.title || 'FlashInfer MLA paged attention on MetaX C500'}`,
    `Result: ${overall}`,
    '',
    '| 阶段 | 执行者 | Workflow 做了什么 | 结果 | 下一步 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '说明：测试结果仅用于验证工作流和 Agent 生成效果，硬件证据均为 simulation，不能用于正式发布。',
    '',
  ].join('\n');
};
