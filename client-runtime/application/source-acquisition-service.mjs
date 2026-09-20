// 来源获取端口（§7.3）：把可能长时间重试的 clone/fetch 从状态投影路径中移出，
// 放进迭代推进路径（advanceIteration）执行。状态查询与正常迭代决策因此不再被获取流程拖住。
//
// 这里不做任何状态修改：只负责读取本次 researchRun 的事件、按 acquire 阶段 schema 定位
// 研究员结果、执行受控获取与验证，并把结果（含失败原因）返回给调用方记账。
export const createSourceAcquisitionService = ({ agentRuntime, acquireSelectedSources, sourceMirrorPolicy, readdir = null }) => {
  if (typeof acquireSelectedSources !== 'function') {
    // 效果实现由组合根注入：application 层不得直接 import 具体效果模块。
    throw new TypeError('Source acquisition service requires the injected source acquisition implementation.');
  }
  if (!agentRuntime || typeof agentRuntime.readRunEvents !== 'function') {
    throw new TypeError('Source acquisition service requires an Agent runtime event reader.');
  }
  if (typeof sourceMirrorPolicy !== 'function') {
    throw new TypeError('Source acquisition service requires the source mirror policy loader.');
  }
  // 只把 sourceRoot 中本次获取新建的目录算成本次收获；历史目录只描述注册表规模。
  const newDirectoryCount = async (sourceRoot, baseline) => {
    if (!readdir || !sourceRoot) return null;
    const entries = await readdir(sourceRoot).catch(() => []);
    if (!Array.isArray(entries)) return null;
    return entries.filter((name) => name !== '.git' && !baseline.has(name)).length;
  };
  // 端口必须自己把输入解析齐：调用方（迭代循环）只提供 state / mission / runId，
  // 采集目录与 Source Registry 由 Mission 与本次 researchAgent 推导。缺输入时给出明确
  // 原因码，绝不把 undefined 透传给 path/mkdir 变成不可诊断的 ERR_INVALID_ARG_TYPE。
  const acquireSources = async ({ state = {}, mission = {}, runId, researchDir = null, sourceRoot = null, allowDiscoveredSources = false, allowSemanticFallback = false } = {}) => {
    const startedAtMs = Date.now();
    const resolvedSourceRoot = sourceRoot || mission.sourceRoot || null;
    const resolvedResearchDir = researchDir || state.researchAgent?.researchDir || null;
    if (!resolvedSourceRoot || !resolvedResearchDir) {
      const missing = !resolvedSourceRoot ? 'sourceRoot' : 'researchDir';
      return {
        sources: [],
        failures: [{ code: 'RESEARCH_ACQUISITION_INPUT_MISSING', detail: `采集端口缺少 ${missing}：无法定位 Source Registry 或调研目录。` }],
        reasonCode: 'RESEARCH_ACQUISITION_INPUT_MISSING',
        elapsedMs: Date.now() - startedAtMs,
        newDirectoryCount: 0,
      };
    }
    const baselineEntries = readdir ? await readdir(resolvedSourceRoot).catch(() => []) : [];
    const baseline = new Set(Array.isArray(baselineEntries) ? baselineEntries : []);
    try {
      const events = await agentRuntime.readRunEvents(runId);
      const sources = await acquireSelectedSources({
        events,
        sourceRoot: resolvedSourceRoot,
        researchDir: resolvedResearchDir,
        runId,
        mirrorPolicy: await sourceMirrorPolicy(),
        allowDiscoveredSources,
        allowSemanticFallback,
      });
      return {
        sources,
        failures: [],
        reasonCode: null,
        elapsedMs: Date.now() - startedAtMs,
        newDirectoryCount: await newDirectoryCount(sourceRoot, baseline),
      };
    } catch (error) {
      return {
        sources: [],
        failures: [{ code: error.reasonCode || error.code || 'RESEARCH_SOURCE_ACQUISITION_FAILED', detail: String(error.message || '').slice(0, 800) }],
        reasonCode: error.reasonCode || error.code || null,
        elapsedMs: Date.now() - startedAtMs,
        newDirectoryCount: 0,
      };
    }
  };
  return Object.freeze({ acquireSources });
};
