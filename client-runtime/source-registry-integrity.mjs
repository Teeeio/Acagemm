// Source Registry 完整性判定。纯函数叶子模块：不做 I/O、不读时钟、不 import 运行时实现。
//
// 为什么需要它：第三方来源是**固定引用**。一旦来源根被改动，以它为材料基线的自动流转就不再可信，
// 必须停下等人裁决。判定要把两件事分清楚：
//
//  - **modified（有证据证明被改过）**：未提交变更（SOURCE_REPOSITORY_DIRTY），或登记的 tree pin
//    与当前 HEAD tree 不一致（SOURCE_REPOSITORY_TREE_MISMATCH）——后者覆盖「已经别处提交过、
//    工作区反而是干净的」这种看不见的改动。
//  - **unverifiable（读不出来，不能断言任何事）**：不是独立 Git 根、来源根里有非目录条目、
//    路径越界。它同样要停自动流转，但理由不同，不能冒充「被改过」。
//
// 关键约束：判定**只认来源级错误码**，不认引用级错误码（SOURCE_REFERENCE_*）。
// 引用级错误讲的是「某个 mission 声称用了什么」——候选自报来源可能指向未登记的仓库、
// 或指向一个已被上游推进的历史 commit；Source Registry 按 `仓库@commit` 逐条留存，
// 同一个仓库因此可以同时存在多个 commit 条目，而来源根只可能匹配当前 HEAD。
// 把这些当依据，巡检就会因 mission 级声明问题报「来源被改」，把真信号淹成噪声。
// 本闸门只回答「来源根现在还能不能当固定引用」，因此引用级一律不参与判定。

// 有证据证明来源内容被改动过。
export const SOURCE_MODIFIED_CODES = Object.freeze([
  'SOURCE_REPOSITORY_DIRTY',
  'SOURCE_REPOSITORY_TREE_MISMATCH',
]);

// 无法核验来源（结构性故障或读取失败），但**不能**据此声称内容被改过。
export const SOURCE_UNVERIFIABLE_CODES = Object.freeze([
  'SOURCE_REPOSITORY_INVALID',
  'SOURCE_ROOT_ENTRY_INVALID',
  'SOURCE_PATH_OUTSIDE_REGISTRY',
]);

const MODIFIED = new Set(SOURCE_MODIFIED_CODES);
const UNVERIFIABLE = new Set(SOURCE_UNVERIFIABLE_CODES);

// 引用级与其它未知码一律不参与判定，但如实回传，便于诊断时看到「有哪些错误被忽略了」。
const describe = (error) => ({
  code: error?.code || null,
  source: error?.source || null,
  detail: error?.detail || null,
  changedFiles: Array.isArray(error?.changedFiles) ? error.changedFiles : undefined,
  recordedTree: error?.recordedTree,
  tree: error?.tree,
});

export const classifySourceRegistryIntegrity = ({ inspection } = {}) => {
  const errors = Array.isArray(inspection?.errors) ? inspection.errors : [];
  const modified = errors.filter((error) => MODIFIED.has(error?.code)).map(describe);
  const unverifiable = errors.filter((error) => UNVERIFIABLE.has(error?.code)).map(describe);
  const ignored = errors.filter((error) => !MODIFIED.has(error?.code) && !UNVERIFIABLE.has(error?.code)).map(describe);
  // 被改过是**可证**的结论，优先于「读不出来」：两者同时存在时如实报告更强的那个。
  const verdict = modified.length ? 'modified' : unverifiable.length ? 'unverifiable' : 'clean';
  return {
    verdict,
    modified,
    unverifiable,
    ignored,
    ignoredCodes: [...new Set(ignored.map((entry) => entry.code).filter(Boolean))],
    reasonCode: verdict === 'modified' ? 'source_root_modified' : verdict === 'unverifiable' ? 'source_root_unverifiable' : null,
  };
};
