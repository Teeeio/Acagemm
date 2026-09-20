import { classifySourceRegistryIntegrity } from '../source-registry-integrity.mjs';

// 来源根完整性闸门。与 baseline-source-inspection-service 同一形状：判定为不可信时把循环升级成
// needs_human 并留下持久事件，由 detectLoopGuard 停掉自动流转（手动操作不受阻，理由码可查）。
export const createSourceRegistryIntegrityService = ({ inspectSources, appendRuntimeEvent }) => {
  if (typeof inspectSources !== 'function' || typeof appendRuntimeEvent !== 'function') {
    throw new TypeError('Source registry integrity service requires inspectSources and appendRuntimeEvent.');
  }
  // sourceRoot 可以由调用方显式传入：采集路径用的是它自己那个根（researchAgent.sourceRoot），
  // 巡检必须问同一个根，否则可能检查了一个本次运行根本没用的目录。
  const inspect = async ({ state, mission, sourceRoot } = {}) => {
    const target = sourceRoot || mission?.sourceRoot;
    if (!target) return { valid: true, state, verdict: 'skipped', integrity: null };
    // 引用清单传空数组是刻意的：Source Registry 里的历史引用可能带空 path（source-service 注册时写
    // path:''），带上它们会让每次巡检都因引用错误失败，把「来源被改过」的判定淹没。这里只问来源本身。
    const result = await inspectSources(target, []);
    const integrity = classifySourceRegistryIntegrity({ inspection: result });
    if (integrity.verdict === 'clean') return { valid: true, state, verdict: integrity.verdict, integrity };
    state.iterationStats = {
      ...(state.iterationStats || {}),
      loopStatus: 'needs_human',
      loopStatusReason: integrity.reasonCode,
    };
    appendRuntimeEvent(state, 'source_registry.integrity_failed', {
      missionId: state.activeMissionId,
      verdict: integrity.verdict,
      reasonCode: integrity.reasonCode,
      modified: integrity.modified,
      unverifiable: integrity.unverifiable,
      ignoredCodes: integrity.ignoredCodes,
    }, { kind: 'baseline', mode: 'client' });
    return { valid: false, state, verdict: integrity.verdict, integrity };
  };
  return Object.freeze({ inspect });
};
