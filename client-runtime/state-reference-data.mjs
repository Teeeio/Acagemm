// Legacy reference records and metadata; never independent live evidence.

export const knowledgeDrafts = [
  {
    id: 'exp.async-plan-cache', code: 'EXP-01', category: '通用优化经验', title: '短序列下的 Async plan descriptor cache',
    conclusion: '当设备 Kernel 已低于 50μs 时，缓存 plan descriptor 并将 host mirror 移出热路径，可以稳定降低固定开销。',
    scope: 'C550 / CUDA · paged_attention · batch 1–8 · seq_len ≤ 1024', hardware: ['C550', 'CUDA'],
    operator: 'mla_paged_attention', dtype: 'FP16 / BF16', layout: 'paged KV · head_dim 128', shape: 'batch 1–8 · seq_len ≤ 1024', runtime: 'MXMACA 1.4+ / CUDA 12.4',
    trigger: 'Profile 显示 device kernel < 50μs，且 plan 构建、workspace 与 host mirror 合计占端到端延迟 30% 以上。',
    procedure: '按 operator、dtype、layout 与 shape bucket 生成稳定 signature\n缓存 plan descriptor，并为缓存设置容量上限\nhost mirror 仅在缓存未就绪时走异步回退\n环境指纹变化时强制失效并重建缓存',
    expectedGain: '端到端 P50 下降 8%–15%；本 Mission 实测下降 22.3%',
    validation: 'C550 + CUDA · 24 / 24 Correctness · 2 个 Full Benchmark · 最大允许回归 2%',
    constraints: '保留 host mirror fallback；必须通过 24 / 24 Correctness Gate。',
    contraindications: 'shape 基数高且复用率低；环境指纹频繁变化；Kernel 本身仍占端到端延迟 80% 以上。',
    failedAttempts: '仅复用 Workspace 的 Candidate 01 收益 7.8%，未达到 45μs 目标；融合 mirror preparation 的 Candidate 03 出现跨平台回归。',
    evidence: '2 个 Level 3 Run', evidenceLevel: 'Level 3', confidence: '高',
    evidenceRefs: ['MIS_01JH7R', 'run_01JH8T', 'run_01JH91', 'candidate-02', 'commit 8f3a7c2'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'Experience Curator', status: 'validated',
  },
  {
    id: 'exp.c550-plan-cache-boundary', code: 'EXP-02', category: '沐曦 C550 专项准则', title: '沐曦 C550 plan cache 与 host mirror 边界准则',
    conclusion: '在 MXMACA 1.4+ 环境中，descriptor cache 应按 Shape signature 分桶，host mirror 仅在缓存未就绪时回退同步路径。',
    scope: 'MetaX C550 · MXMACA 1.4+ · paged_attention · small batch', hardware: ['C550'],
    operator: 'mla_paged_attention', dtype: 'FP16', layout: 'paged KV · contiguous descriptor', shape: 'batch 1–8 · seq_len 128–1024', runtime: 'MXMACA 1.4.0 · C550 driver 2.7.3',
    trigger: 'C550 时间线中 host plan 与 mirror 准备占比超过 25%，同一 shape signature 在请求间重复出现。',
    procedure: '使用 shape、dtype、layout、head_dim 组成 cache key\n限制每个算子最多保留 64 个 descriptor\n使用 stream event 标记 mirror ready，禁止热路径 host wait\nMXMACA、driver 或编译参数变化时清空缓存',
    expectedGain: 'C550 P50 53.8μs → 41.8μs；固定开销减少 14.6μs',
    validation: 'C550 Production 01 · warmup 50 · repeat 200 · 12/12 correctness · P50/P95',
    constraints: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。',
    contraindications: '动态 descriptor 内容无法由 signature 完整表达；超大 shape corpus 导致命中率低于 60%。',
    failedAttempts: '无界 LRU 在长尾流量中增加 18MB 峰值占用；固定单例 plan 在 head_dim 变化时产生错误结果。',
    evidence: 'C550 41.8μs · Level 3', evidenceLevel: 'Level 3', confidence: '高',
    evidenceRefs: ['MIS_01JH7R', 'env.c550-prod-01@8f3a', 'run_01JH8T', 'candidate-02'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'C550 Kernel Group', status: 'validated',
  },
  {
    id: 'exp.cross-platform-adoption-gate', code: 'EXP-03', category: '跨平台验证准则', title: 'C550 / CUDA 跨平台候选采用门禁',
    conclusion: '跨平台候选只有在 Correctness、目标平台性能和固定环境证据同时通过后，才能替换 current best。',
    scope: 'C550 / CUDA · operator candidate adoption · Full Benchmark', hardware: ['C550', 'CUDA'],
    operator: 'all optimized operators', dtype: 'FP16 / BF16', layout: 'all registered layouts', shape: '完整基准矩阵与边界 shape', runtime: '固定 Environment Snapshot',
    trigger: '候选将替换 current best，或修改跨硬件共享的 runtime、layout、精度和同步路径。',
    procedure: '为每个平台固定 Environment Snapshot\n先运行边界与历史回归 Correctness Matrix\n再运行预热充分的 Full Benchmark\n按平台分别比较 current best，任何关键平台回归均阻止采用',
    expectedGain: '目标平台达到 Mission 门槛，非目标平台回归不超过 2%',
    validation: '24 / 24 Correctness · C550/CUDA Full Benchmark · Environment Diff 为空 · Level 3',
    constraints: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。',
    contraindications: '缺少目标平台 Worker；环境快照不一致；仅有 Probe 或单次 Run；正确性用例未覆盖边界 shape。',
    failedAttempts: 'Candidate 03 在 C550 回退 3.3%、CUDA 回退 10.2%，即使正确性通过也不得采用。',
    evidence: '24 / 24 · 2 个固定环境', evidenceLevel: 'Level 3', confidence: '高',
    evidenceRefs: ['MIS_01JH7R', 'decision.candidate-02', 'run_01JH8T', 'run_01JH91'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02 / 03', sourceCommit: '8f3a7c2', owner: 'Performance Review Board', status: 'validated',
  },
];

export const candidateEvaluations = [
  {
    id: 'candidate-01', label: 'Candidate 01', version: 'cnd.01', date: '08-03 09:36', classification: 'reference', status: '弱候选参考', tone: 'reference', title: 'Workspace pool reuse',
    hypothesis: '重复分配 Workspace 可能是小 Batch 延迟的主要来源。', change: '引入按 Shape 分桶的 Workspace pool，并保留同步 plan 构建。', files: '2 files · +24 −11',
    c550: 49.6, cuda: 41.9, delta: '−7.8%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '保留为弱候选参考',
    decisionReason: '正确性与证据门禁通过，但 C550 未达到 45μs 目标；保留 Workspace pool 的局部复用价值。', knowledge: 'Workspace Allocation Tracker v1.2.0',
    acceptGate: { passed: false, failedRules: ['performance.target.c550'], passedRules: ['correctness', 'runtime.stability', 'evidence.level3'], result: 'reference' },
  },
  {
    id: 'candidate-02', label: 'Candidate 02', version: 'cnd.02', date: '08-03 10:42', classification: 'eligible', status: '等待 Accept Gate', tone: 'eligible', title: 'Async plan descriptor cache',
    hypothesis: '缓存 plan descriptor，并将 host mirror 同步移出热路径。', change: '新增 plan cache 与异步 mirror fallback，保持 API 和回退路径不变。', files: '2 files · +37 −18',
    c550: 41.8, cuda: 36.1, delta: '−22.3%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '等待策略评估',
    decisionReason: '验证完成后由 Accept Gate 自动判断，无需人工确认。', knowledge: '3 assets referenced · fixed versions',
    acceptGate: { passed: true, failedRules: [], passedRules: ['correctness', 'performance.target.c550', 'cross_platform.no_regression', 'runtime.stability', 'evidence.level3'], result: 'eligible' },
  },
  {
    id: 'candidate-03', label: 'Candidate 03', version: 'cnd.03', date: '08-03 11:18', classification: 'reference', status: '弱候选参考', tone: 'reference', title: 'Fuse mirror preparation',
    hypothesis: '将 mirror preparation 与 Kernel 前处理融合可能继续压缩固定开销。', change: '合并两个 host/device 边界，并调整事件同步粒度。', files: '3 files · +61 −35',
    c550: 43.2, cuda: 39.8, delta: '−19.7%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '保留为弱候选参考',
    decisionReason: '相对基线有效，但相对 current best 在 C550 回退 3.3%、CUDA 回退 10.2%；仅保留融合边界的参考价值。', knowledge: '异步流水线 Stall 归因规则 v1.4',
    acceptGate: { passed: false, failedRules: ['current_best.no_regression'], passedRules: ['correctness', 'performance.target.c550', 'runtime.stability', 'evidence.level3'], result: 'reference' },
  },
];

export const failureRecords = [
  {
    id: 'failure.run-04', recordType: 'failure', sourceAttempt: 'Attempt 04', label: 'Failure Record 04', version: 'fail.04', date: '08-03 13:05', status: '已退出候选池', tone: 'failed', title: 'Adaptive tile selection',
    hypothesis: '根据 Batch 与序列长度动态选择 tile，可改善长尾 Shape 的设备利用率。', change: '新增轻量 Shape classifier 和三组预验证 tile 配置。', files: '3 files · +82 −16',
    c550: 40.9, cuda: null, delta: '−24.0%*', correctness: '20 / 24', evidence: 'Probe Run · Level 1', decision: 'Correctness Gate 失败，禁止形成候选',
    decisionReason: '4 个边界 Shape 出现数值偏差，硬门禁失败；代码提案和 worktree 已退出候选生命周期。',
    failure: { gate: 'Correctness Gate', code: 'CORRECTNESS_BOUNDARY_MISMATCH', affectedCases: 4, disposition: 'candidate_removed' },
    retainedArtifacts: ['run.probe.c550.04', 'patch.digest.04', 'error.fingerprint.tile-boundary'],
    extractedExperience: {
      id: 'neg.adaptive-tile-boundary', status: 'extracted', title: 'Adaptive tile 必须先覆盖边界 Shape',
      rule: '动态 tile 选择器在进入性能比较前，必须覆盖 head_dim、seq_len 与尾块不对齐的边界组合；任何数值偏差直接终止候选化。',
      reuse: 'Agent 生成 tile classifier 时自动加入边界 Shape Correctness 前置约束。', evidenceLevel: 'Level 1 · negative evidence',
    },
  },
];

export const agentProfiles = [
  { id: 'profile.operator-orchestrator', name: 'Operator Orchestrator', version: 'v3.2.0', role: '目标拆解与路线调度', status: 'active', tools: 6, skills: 4 },
  { id: 'profile.result-analyst', name: 'Result Analyst', version: 'v2.4.1', role: '证据审查与采用判断', status: 'available', tools: 4, skills: 3 },
  { id: 'profile.experience-curator', name: 'Experience Curator', version: 'v1.8.0', role: '经验提炼与发布治理', status: 'available', tools: 3, skills: 2 },
];

export const capabilityRegistry = {
  skills: [
    { id: 'skill.context-snapshot', name: '仓库上下文快照', version: 'v2.1.0', permission: 'repository:read' },
    { id: 'skill.baseline-resolution', name: 'Baseline Resolver', version: 'v1.0.0', permission: 'repository:read' },
    { id: 'skill.bottleneck-segmentation', name: '性能瓶颈分段分析', version: 'v2.3.1', permission: 'artifact:write' },
    { id: 'skill.candidate-planning', name: '有界候选规划', version: 'v1.9.0', permission: 'candidate:create' },
    { id: 'skill.experience-curation', name: '经验沉淀', version: 'v1.6.0', permission: 'knowledge:draft' },
  ],
  tools: [
    { id: 'tool.repository-inspect', name: 'Repository Inspector', version: 'v1.5.0', permission: 'repository:read', risk: 'low' },
    { id: 'tool.experience-search', name: 'Experience Search', version: 'v2.0.3', permission: 'knowledge:read', risk: 'low' },
    { id: 'tool.profile-timeline', name: 'Profile Timeline', version: 'v1.8.0', permission: 'worker:execute', risk: 'medium' },
    { id: 'tool.patch-workspace', name: 'Patch Workspace', version: 'v1.4.2', permission: 'repository:write', risk: 'medium' },
    { id: 'tool.test-matrix', name: 'Test Matrix Runner', version: 'v2.2.0', permission: 'worker:execute', risk: 'medium' },
    { id: 'tool.evidence-compare', name: 'Evidence Comparator', version: 'v1.7.1', permission: 'artifact:read', risk: 'low' },
  ],
};
