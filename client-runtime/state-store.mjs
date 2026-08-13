import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appendRuntimeEvent } from './agent-runtime.mjs';
import {
  dataDir,
  legacyDataDir,
  legacyRuntimeDir,
  projectRoot as rootDir,
  runtimeDir,
  usesManagedStorage,
} from './storage-paths.mjs';
import { copyWorkspaceSnapshot, workspaceManager } from './workspace-manager.mjs';
import { MLA_OPTIMIZATION_TEST_GOAL } from './mission-intent.mjs';

export { runtimeDir } from './storage-paths.mjs';
const statePath = path.join(dataDir, 'mock-db.json');
const workspaceTemplate = path.join(rootDir, 'demo-assets', 'mla-kernels');
export const workspaceDir = path.join(runtimeDir, 'mla-kernels');
const missionWorkspaceRoot = path.join(runtimeDir, 'workspaces');
const workspaceCheckpointRoot = path.join(runtimeDir, 'checkpoints');

const safeMissionId = (missionId) => String(missionId || 'mission').replace(/[^a-zA-Z0-9._-]/g, '_');
export const projectLayoutFor = (repository = '', projectRoot = '', sourceRoot = '') => {
  const iterationRepository = String(repository || '').trim();
  const root = String(projectRoot || '').trim() || (path.isAbsolute(iterationRepository) ? iterationRepository : '');
  const runtimeRoot = root ? path.join(root, '.operator-studio') : runtimeDir;
  return {
    layout: projectRoot ? 'three-layer' : 'legacy-compatible',
    root: root || null,
    repository: iterationRepository,
    sourceRoot: String(sourceRoot || '').trim() || (root ? path.join(root, 'sources') : path.join(runtimeDir, 'sources', projectNameForRepository(iterationRepository))),
    runtimeRoot,
  };
};

export const workspaceDirForMission = (missionId, repository = '', projectRoot = '') => {
  const layout = projectLayoutFor(repository, projectRoot);
  return layout.root
    ? path.join(layout.runtimeRoot, 'workspaces', safeMissionId(missionId), 'repository')
    : path.join(missionWorkspaceRoot, safeMissionId(missionId), 'repository');
};

export const missionRootFor = (missionId, repository = '', projectRoot = '') => path.dirname(workspaceDirForMission(missionId, repository, projectRoot));
export const artifactDirForMission = (missionId, repository = '', projectRoot = '') => {
  const layout = projectLayoutFor(repository, projectRoot);
  return layout.root
    ? path.join(layout.runtimeRoot, 'artifacts', safeMissionId(missionId))
    : path.join(runtimeDir, 'artifacts', safeMissionId(missionId));
};

// 研究员子 Agent 的隔离调研目录：clone 上游库（clones/）与笔记（notes/）都只允许落在这里。
export const researchDirForMission = (missionId, repository = '', projectRoot = '') => path.join(missionRootFor(missionId, repository, projectRoot), 'research');
export const researchNotesDirForMission = (missionId, repository = '', projectRoot = '') => path.join(researchDirForMission(missionId, repository, projectRoot), 'notes');
export const researchClonesDirForMission = (missionId, repository = '', projectRoot = '') => path.join(researchDirForMission(missionId, repository, projectRoot), 'clones');

export async function ensureProjectLayout({ root, repository, sourceRoot, projectId = null }) {
  const layout = projectLayoutFor(repository, root, sourceRoot);
  if (!layout.root) return layout;
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.repository, { recursive: true });
  await mkdir(layout.sourceRoot, { recursive: true });
  await mkdir(path.join(layout.runtimeRoot, 'workspaces'), { recursive: true });
  await mkdir(path.join(layout.runtimeRoot, 'artifacts'), { recursive: true });
  const descriptor = {
    schemaVersion: 1,
    projectId,
    layout: 'three-layer',
    root: layout.root,
    repository: layout.repository,
    sourceRoot: layout.sourceRoot,
    runtimeRoot: layout.runtimeRoot,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(layout.runtimeRoot, 'project.json'), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  const registryPath = path.join(layout.runtimeRoot, 'source-registry.json');
  if (!await exists(registryPath)) await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`, 'utf8');
  return { ...layout, descriptor, registryPath };
}

const projectIdForRepository = (repository = '') => `PRJ_${Buffer.from(String(repository || 'repository')).toString('hex').slice(0, 16).toUpperCase()}`;
const projectNameForRepository = (repository = '') => path.basename(String(repository || 'repository').replaceAll('\\', '/')) || 'repository';
const createProjectRecord = (repository, overrides = {}) => ({
  id: overrides.id || projectIdForRepository(repository),
  name: overrides.name || projectNameForRepository(repository),
  repository: String(repository || '').trim(),
  root: overrides.root || (path.isAbsolute(repository) ? repository : null),
  sourceRoot: overrides.sourceRoot || (path.isAbsolute(repository) ? path.join(repository, '.operator-studio', 'sources') : null),
  runtimeRoot: overrides.runtimeRoot || (path.isAbsolute(repository) ? path.join(repository, '.operator-studio') : null),
  layout: overrides.layout || 'legacy-compatible',
  defaultBranch: overrides.defaultBranch || 'HEAD',
  status: overrides.status || 'active',
  createdAt: overrides.createdAt || new Date().toISOString(),
  updatedAt: overrides.updatedAt || new Date().toISOString(),
});

const ensureProjects = (state) => {
  const existing = Array.isArray(state.projects) ? state.projects : [];
  const byRepository = new Map(existing.map((project) => [project.repository, project]));
  for (const mission of state.missions || []) {
    if (!byRepository.has(mission.repository)) byRepository.set(mission.repository, createProjectRecord(mission.repository));
  }
  state.projects = [...byRepository.values()];
  for (const mission of state.missions || []) {
    const project = state.projects.find((item) => item.id === mission.projectId) || state.projects.find((item) => item.repository === mission.repository);
    if (project) mission.projectId = project.id;
  }
  if (!state.activeProjectId || !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = state.missions?.find((mission) => mission.id === state.activeMissionId)?.projectId || state.projects[0]?.id || null;
  }
  return state;
};

export const knowledgeDrafts = [
  {
    id: 'exp.async-plan-cache', code: 'EXP-01', category: '通用优化经验', title: '短序列下的 Async plan descriptor cache',
    conclusion: '当设备 Kernel 已低于 50μs 时，缓存 plan descriptor 并将 host mirror 移出热路径，可以稳定降低固定开销。',
    scope: 'C500 / CUDA · paged_attention · batch 1–8 · seq_len ≤ 1024', hardware: ['C500', 'CUDA'],
    operator: 'mla_paged_attention', dtype: 'FP16 / BF16', layout: 'paged KV · head_dim 128', shape: 'batch 1–8 · seq_len ≤ 1024', runtime: 'MXMACA 1.4+ / CUDA 12.4',
    trigger: 'Profile 显示 device kernel < 50μs，且 plan 构建、workspace 与 host mirror 合计占端到端延迟 30% 以上。',
    procedure: '按 operator、dtype、layout 与 shape bucket 生成稳定 signature\n缓存 plan descriptor，并为缓存设置容量上限\nhost mirror 仅在缓存未就绪时走异步回退\n环境指纹变化时强制失效并重建缓存',
    expectedGain: '端到端 P50 下降 8%–15%；本 Mission 实测下降 22.3%',
    validation: 'C500 + CUDA · 24 / 24 Correctness · 2 个 Full Benchmark · 最大允许回归 2%',
    constraints: '保留 host mirror fallback；必须通过 24 / 24 Correctness Gate。',
    contraindications: 'shape 基数高且复用率低；环境指纹频繁变化；Kernel 本身仍占端到端延迟 80% 以上。',
    failedAttempts: '仅复用 Workspace 的 Candidate 01 收益 7.8%，未达到 45μs 目标；融合 mirror preparation 的 Candidate 03 出现跨平台回归。',
    evidence: '2 个 Level 3 Run', evidenceLevel: 'Level 3', confidence: '高',
    evidenceRefs: ['MIS_01JH7R', 'run_01JH8T', 'run_01JH91', 'candidate-02', 'commit 8f3a7c2'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'Experience Curator', status: 'validated',
  },
  {
    id: 'exp.c500-plan-cache-boundary', code: 'EXP-02', category: '沐曦 C500 专项准则', title: '沐曦 C500 plan cache 与 host mirror 边界准则',
    conclusion: '在 MXMACA 1.4+ 环境中，descriptor cache 应按 Shape signature 分桶，host mirror 仅在缓存未就绪时回退同步路径。',
    scope: 'MetaX C500 · MXMACA 1.4+ · paged_attention · small batch', hardware: ['C500'],
    operator: 'mla_paged_attention', dtype: 'FP16', layout: 'paged KV · contiguous descriptor', shape: 'batch 1–8 · seq_len 128–1024', runtime: 'MXMACA 1.4.0 · C500 driver 2.7.3',
    trigger: 'C500 时间线中 host plan 与 mirror 准备占比超过 25%，同一 shape signature 在请求间重复出现。',
    procedure: '使用 shape、dtype、layout、head_dim 组成 cache key\n限制每个算子最多保留 64 个 descriptor\n使用 stream event 标记 mirror ready，禁止热路径 host wait\nMXMACA、driver 或编译参数变化时清空缓存',
    expectedGain: 'C500 P50 53.8μs → 41.8μs；固定开销减少 14.6μs',
    validation: 'C500 Production 01 · warmup 50 · repeat 200 · 12/12 correctness · P50/P95',
    constraints: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。',
    contraindications: '动态 descriptor 内容无法由 signature 完整表达；超大 shape corpus 导致命中率低于 60%。',
    failedAttempts: '无界 LRU 在长尾流量中增加 18MB 峰值占用；固定单例 plan 在 head_dim 变化时产生错误结果。',
    evidence: 'C500 41.8μs · Level 3', evidenceLevel: 'Level 3', confidence: '高',
    evidenceRefs: ['MIS_01JH7R', 'env.c500-prod-01@8f3a', 'run_01JH8T', 'candidate-02'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'C500 Kernel Group', status: 'validated',
  },
  {
    id: 'exp.cross-platform-adoption-gate', code: 'EXP-03', category: '跨平台验证准则', title: 'C500 / CUDA 跨平台候选采用门禁',
    conclusion: '跨平台候选只有在 Correctness、目标平台性能和固定环境证据同时通过后，才能替换 current best。',
    scope: 'C500 / CUDA · operator candidate adoption · Full Benchmark', hardware: ['C500', 'CUDA'],
    operator: 'all optimized operators', dtype: 'FP16 / BF16', layout: 'all registered layouts', shape: '完整基准矩阵与边界 shape', runtime: '固定 Environment Snapshot',
    trigger: '候选将替换 current best，或修改跨硬件共享的 runtime、layout、精度和同步路径。',
    procedure: '为每个平台固定 Environment Snapshot\n先运行边界与历史回归 Correctness Matrix\n再运行预热充分的 Full Benchmark\n按平台分别比较 current best，任何关键平台回归均阻止采用',
    expectedGain: '目标平台达到 Mission 门槛，非目标平台回归不超过 2%',
    validation: '24 / 24 Correctness · C500/CUDA Full Benchmark · Environment Diff 为空 · Level 3',
    constraints: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。',
    contraindications: '缺少目标平台 Worker；环境快照不一致；仅有 Probe 或单次 Run；正确性用例未覆盖边界 shape。',
    failedAttempts: 'Candidate 03 在 C500 回退 3.3%、CUDA 回退 10.2%，即使正确性通过也不得采用。',
    evidence: '24 / 24 · 2 个固定环境', evidenceLevel: 'Level 3', confidence: '高',
    evidenceRefs: ['MIS_01JH7R', 'decision.candidate-02', 'run_01JH8T', 'run_01JH91'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02 / 03', sourceCommit: '8f3a7c2', owner: 'Performance Review Board', status: 'validated',
  },
];

export const candidateEvaluations = [
  {
    id: 'candidate-01', label: 'Candidate 01', version: 'cnd.01', date: '08-03 09:36', classification: 'reference', status: '弱候选参考', tone: 'reference', title: 'Workspace pool reuse',
    hypothesis: '重复分配 Workspace 可能是小 Batch 延迟的主要来源。', change: '引入按 Shape 分桶的 Workspace pool，并保留同步 plan 构建。', files: '2 files · +24 −11',
    c500: 49.6, cuda: 41.9, delta: '−7.8%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '保留为弱候选参考',
    decisionReason: '正确性与证据门禁通过，但 C500 未达到 45μs 目标；保留 Workspace pool 的局部复用价值。', knowledge: 'Workspace Allocation Tracker v1.2.0',
    acceptGate: { passed: false, failedRules: ['performance.target.c500'], passedRules: ['correctness', 'runtime.stability', 'evidence.level3'], result: 'reference' },
  },
  {
    id: 'candidate-02', label: 'Candidate 02', version: 'cnd.02', date: '08-03 10:42', classification: 'eligible', status: '等待 Accept Gate', tone: 'eligible', title: 'Async plan descriptor cache',
    hypothesis: '缓存 plan descriptor，并将 host mirror 同步移出热路径。', change: '新增 plan cache 与异步 mirror fallback，保持 API 和回退路径不变。', files: '2 files · +37 −18',
    c500: 41.8, cuda: 36.1, delta: '−22.3%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '等待策略评估',
    decisionReason: '验证完成后由 Accept Gate 自动判断，无需人工确认。', knowledge: '3 assets referenced · fixed versions',
    acceptGate: { passed: true, failedRules: [], passedRules: ['correctness', 'performance.target.c500', 'cross_platform.no_regression', 'runtime.stability', 'evidence.level3'], result: 'eligible' },
  },
  {
    id: 'candidate-03', label: 'Candidate 03', version: 'cnd.03', date: '08-03 11:18', classification: 'reference', status: '弱候选参考', tone: 'reference', title: 'Fuse mirror preparation',
    hypothesis: '将 mirror preparation 与 Kernel 前处理融合可能继续压缩固定开销。', change: '合并两个 host/device 边界，并调整事件同步粒度。', files: '3 files · +61 −35',
    c500: 43.2, cuda: 39.8, delta: '−19.7%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '保留为弱候选参考',
    decisionReason: '相对基线有效，但相对 current best 在 C500 回退 3.3%、CUDA 回退 10.2%；仅保留融合边界的参考价值。', knowledge: '异步流水线 Stall 归因规则 v1.4',
    acceptGate: { passed: false, failedRules: ['current_best.no_regression'], passedRules: ['correctness', 'performance.target.c500', 'runtime.stability', 'evidence.level3'], result: 'reference' },
  },
];

export const failureRecords = [
  {
    id: 'failure.run-04', recordType: 'failure', sourceAttempt: 'Attempt 04', label: 'Failure Record 04', version: 'fail.04', date: '08-03 13:05', status: '已退出候选池', tone: 'failed', title: 'Adaptive tile selection',
    hypothesis: '根据 Batch 与序列长度动态选择 tile，可改善长尾 Shape 的设备利用率。', change: '新增轻量 Shape classifier 和三组预验证 tile 配置。', files: '3 files · +82 −16',
    c500: 40.9, cuda: null, delta: '−24.0%*', correctness: '20 / 24', evidence: 'Probe Run · Level 1', decision: 'Correctness Gate 失败，禁止形成候选',
    decisionReason: '4 个边界 Shape 出现数值偏差，硬门禁失败；代码提案和 worktree 已退出候选生命周期。',
    failure: { gate: 'Correctness Gate', code: 'CORRECTNESS_BOUNDARY_MISMATCH', affectedCases: 4, disposition: 'candidate_removed' },
    retainedArtifacts: ['run.probe.c500.04', 'patch.digest.04', 'error.fingerprint.tile-boundary'],
    extractedExperience: {
      id: 'neg.adaptive-tile-boundary', status: 'extracted', title: 'Adaptive tile 必须先覆盖边界 Shape',
      rule: '动态 tile 选择器在进入性能比较前，必须覆盖 head_dim、seq_len 与尾块不对齐的边界组合；任何数值偏差直接终止候选化。',
      reuse: 'Agent 生成 tile classifier 时自动加入边界 Shape Correctness 前置约束。', evidenceLevel: 'Level 1 · negative evidence',
    },
  },
];

const knowledgeChangePlan = [
  { draftId: 'exp.async-plan-cache', action: 'update', targetId: 'exp.fixed-overhead', targetTitle: '短序列下优先量化固定开销', previousVersion: 'v1.2', nextVersion: 'v1.3', scopeDelta: '适用范围未扩大', reason: '命中已有固定开销经验，补充 plan cache、host mirror 与双平台证据。' },
  { draftId: 'exp.c500-plan-cache-boundary', action: 'create', targetId: 'exp.c500-plan-cache-boundary', targetTitle: '沐曦 C500 plan cache 与 host mirror 边界准则', previousVersion: null, nextVersion: 'v1.0', scopeDelta: 'C500 专项范围', reason: '未发现等价硬件专项经验，创建新的 C500 经验资产。' },
  { draftId: 'exp.cross-platform-adoption-gate', action: 'update', targetId: 'policy.cross-platform-adoption-gate', targetTitle: 'C500 / CUDA 跨平台候选采用门禁', previousVersion: 'v2.3', nextVersion: 'v2.4', scopeDelta: '策略适用范围未扩大', reason: '合并本次失败候选与 Level 3 双平台验证证据。' },
];

export const createKnowledgeMaintenanceState = (status = 'idle') => {
  const completed = status === 'completed';
  const ready = status === 'ready';
  return {
    status,
    trigger: 'decision.adopted',
    triggerLabel: status === 'idle' ? '等待效果决策' : '效果决策 · Candidate 02 已采用',
    policy: {
      id: 'policy.knowledge.level3.same-scope',
      label: 'Level 3 同范围自动发布',
      version: 'v2.1',
      rule: 'evidence.level = 3 AND scope.expanded = false',
      exception: '适用范围扩大、证据降级或发生冲突时转人工治理',
    },
    startedAt: completed ? new Date().toISOString() : null,
    completedAt: completed ? new Date().toISOString() : null,
    summary: { extracted: completed ? 3 : 0, matched: completed ? 2 : 0, created: completed ? 1 : 0, autoPublished: completed ? 3 : 0, reviewRequired: 0 },
    steps: [
      { id: 'extract', label: '经验提取', detail: completed ? '3 个结构化经验对象' : '等待效果决策', status: completed ? 'completed' : (ready ? 'queued' : 'idle') },
      { id: 'deduplicate', label: '查重与合并', detail: completed ? '2 条合并 · 1 条新建' : '等待经验提取', status: completed ? 'completed' : 'idle' },
      { id: 'evidence', label: '证据与边界校验', detail: completed ? 'Level 3 · 13 个证据引用' : '等待匹配结果', status: completed ? 'completed' : 'idle' },
      { id: 'publish', label: '策略发布', detail: completed ? '3 条自动发布 · 0 条需复核' : '等待策略判定', status: completed ? 'completed' : 'idle' },
    ],
    changes: completed ? knowledgeChangePlan.map((change) => ({ ...change, outcome: 'auto_published' })) : knowledgeChangePlan.map((change) => ({ ...change, outcome: 'pending' })),
  };
};

export const createDecisionReviewState = (status = 'idle') => ({
  policy: {
    id: 'policy.decision.conditional-review',
    label: '条件式人工复核',
    version: 'v1.0',
    rule: '证据完整且无风险信号时按策略继续；人工意见或风险信号出现时阻塞。',
  },
  status,
  recommendation: status === 'auto_ready' || status === 'resolved' ? 'adopt' : null,
  requiresApproval: status === 'awaiting_review',
  signals: [
    { id: 'evidence-conflict', label: '证据冲突', value: '未发现', triggered: false },
    { id: 'cross-platform-regression', label: '跨平台回归', value: '0 个平台', triggered: false },
    { id: 'scope-expansion', label: '影响范围扩大', value: '否', triggered: false },
  ],
  request: null,
  resolution: status === 'resolved' ? { outcome: 'adopt', source: 'policy' } : null,
  requestedAt: null,
  resolvedAt: status === 'resolved' ? new Date().toISOString() : null,
});

export const createWorkflowRecoveryState = (missionId = '', repository = '', projectRoot = '') => ({
  worktree: {
    id: missionId ? `workspace.${missionId}` : 'workspace.unassigned',
    candidateId: null,
    path: path.relative(rootDir, missionId ? workspaceDirForMission(missionId, repository, projectRoot) : workspaceDir).replaceAll('\\', '/'),
    status: 'clean',
  },
  checkpoints: [],
  lastRecovery: null,
  invalidatedArtifacts: [],
});

export const createCurrentBestState = (candidateId = 'candidate-01') => candidateId === 'candidate-02'
  ? { candidateId: 'candidate-02', version: 'cnd.02', value: '41.8 μs', improvement: '−22.3%', status: 'active' }
  : { candidateId: 'candidate-01', version: 'cnd.01', value: '49.6 μs', improvement: '−7.8%', status: 'active' };

export const createResearchAgentState = () => ({
  status: 'idle', phase: '待调研', progress: 0, missionId: null, runId: null,
  runtimeKind: null, threadId: null, direction: null, researchDir: null,
  startedAt: null, completedAt: null, budgetMs: 20 * 60 * 1000,
  notes: [], messages: [], artifacts: [], injected: false,
});

export const createIterationStats = () => ({
  round: 0, consecutiveNoAdopt: 0, lastRoundOutcome: null,
  lastCountedRunId: null, researchRounds: 0, lastResearchRunId: null,
  pendingInjection: null,
});

export const createResearchNote = ({ runId, direction, content, summary, findings = [], suggestedDirections = [], sources = [], researchDir, startedAt, completedAt, value = null }) => ({
  id: `note_${runId}`,
  runId, direction, content, summary, findings, suggestedDirections, sources,
  researchDir, startedAt, completedAt, value,
});

export function appendResearchNote(state, note) {
  state.researchNotes = [note, ...(state.researchNotes || []).filter((n) => n.runId !== note.runId)].slice(0, 50);
  return note;
}

export const toPublishedKnowledgeAsset = (draft, version = 'v1.0') => {
  const hardwareKeys = draft.hardware.map((item) => ({ C500: 'c500', CUDA: 'nvidia', 'ROCm MI300': 'amd' }[item])).filter(Boolean);
  const publishable = draft.status === 'validated' && draft.evidenceLevel === 'Level 3';
  return {
    ...draft,
    kind: 'Experience',
    version,
    description: draft.conclusion,
    tags: [draft.category, draft.operator, draft.dtype, ...draft.hardware, draft.evidenceLevel].filter(Boolean),
    tone: 'ochre',
    icon: 'Lightbulb',
    hardwareKeys,
    permissions: 'organization:read',
    status: publishable ? 'published' : 'simulation',
    updated: new Date().toISOString().slice(0, 10),
  };
};

export function runKnowledgeMaintenance(state) {
  const liveEvidence = state.benchmark?.result?.environment?.liveHardware === true;
  const expectedAssetStatus = liveEvidence ? 'published' : 'simulation';
  if (state.knowledgeMaintenance?.status === 'completed'
    && state.publishedAssets?.length === state.knowledgeDrafts?.length
    && state.publishedAssets.every((asset) => asset.status === expectedAssetStatus)) return state;
  const startedAt = new Date().toISOString();
  const activeCandidateId = state.appliedCandidateId || state.currentBest?.candidateId || 'candidate';
  const maintainedDrafts = (state.knowledgeDrafts || []).map((draft) => liveEvidence ? draft : {
    ...draft,
    evidenceLevel: '模拟证据',
    confidence: '仅供流程验证',
    status: 'simulation',
    evidence: `${state.benchmark?.runId || 'mock-run'} · Mock Benchmark / Tracer / Profiler`,
  });
  state.knowledgeDrafts = maintainedDrafts;
  const activeChanges = maintainedDrafts.map((draft) => knowledgeChangePlan.find((change) => change.draftId === draft.id) || {
    draftId: draft.id,
    action: 'create',
    targetId: draft.id,
    targetTitle: draft.title,
    previousVersion: null,
    nextVersion: 'v1.0',
    scopeDelta: '当前 Mission 验证范围',
    reason: `由 ${activeCandidateId} 的 Patch 与测试证据自动提取。`,
  });
  const versionByDraft = new Map(activeChanges.map((change) => [change.draftId, change.nextVersion]));
  state.publishedAssets = maintainedDrafts.map((draft) => toPublishedKnowledgeAsset(draft, versionByDraft.get(draft.id) || 'v1.0'));
  const publishedCount = state.publishedAssets.filter((asset) => asset.status === 'published').length;
  const simulationCount = state.publishedAssets.length - publishedCount;
  state.knowledgeMaintenance = {
    ...createKnowledgeMaintenanceState('completed'),
    startedAt,
    completedAt: new Date().toISOString(),
    summary: {
      extracted: state.knowledgeDrafts.length,
      matched: activeChanges.filter((change) => change.action === 'update').length,
      created: activeChanges.filter((change) => change.action === 'create').length,
      autoPublished: publishedCount,
      reviewRequired: simulationCount,
    },
    changes: activeChanges.map((change) => ({ ...change, outcome: liveEvidence ? 'auto_published' : 'simulation_only' })),
    triggerLabel: liveEvidence
      ? `效果决策 · ${activeCandidateId} 已采用`
      : `仿真闭环 · ${activeCandidateId} 仅生成预览资产`,
  };
  state.stage = 'published';
  state.decisionReview = {
    ...(state.decisionReview || createDecisionReviewState('resolved')),
    status: 'resolved',
    requiresApproval: false,
    recommendation: 'adopt',
    resolution: state.decisionReview?.resolution || { outcome: 'adopt', source: 'policy' },
    resolvedAt: state.decisionReview?.resolvedAt || new Date().toISOString(),
  };
  state.agent = {
    ...state.agent,
    status: 'completed',
    phase: '知识自动维护完成',
    progress: 100,
    currentAction: null,
    messages: [...(state.agent?.messages || []), { id: `knowledge-${Date.now()}`, phase: 'knowledge', status: 'completed', title: liveEvidence ? '知识资产已自动维护' : '仿真经验预览已生成', detail: liveEvidence ? `${publishedCount} 条经验已完成查重、版本化和策略发布。` : `${simulationCount} 条经验仅用于验证客户端闭环，不会进入正式知识资产库。`, time: '刚刚' }],
  };
  appendRuntimeEvent(state, 'knowledge.maintenance_completed', { policyId: state.knowledgeMaintenance.policy.id, summary: state.knowledgeMaintenance.summary, changes: state.knowledgeMaintenance.changes, liveEvidence }, { kind: 'knowledge', mode: 'client' });
  addAuditEvent(state, liveEvidence ? '知识资产已按策略自动维护' : '仿真经验预览已生成', `${state.publishedAssets.length} Experiences · ${state.knowledgeMaintenance.policy.version} · ${simulationCount} simulation only`, liveEvidence ? 'green' : 'warning', 'BookOpen');
  return state;
}

export function markCandidateAccepted(state, note, source = 'policy') {
  const acceptedAt = new Date().toISOString();
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId || 'candidate-02';
  state.candidateEvaluations = (state.candidateEvaluations || candidateEvaluations).map((candidate) => candidate.id === candidateId
    ? {
        ...candidate,
        classification: 'accepted',
        status: source === 'human_review' ? '已按人工处置采用' : '已自动采用',
        tone: 'adopted',
        decision: source === 'human_review' ? '人工介入采用为 current best' : '策略自动采用为 current best',
        decisionReason: note,
        acceptedAt,
        acceptGate: { ...candidate.acceptGate, passed: true, result: 'accepted' },
      }
    : candidate);
  return acceptedAt;
}

export function runAutomaticAdoption(state, note = 'Accept Gate 全部通过，策略自动采用 Candidate 02。') {
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const isCodexCandidate = state.agent?.runtimeKind === 'codex-cli';
  const gate = state.decisionReview?.gate || candidate?.acceptGate || { passed: true, passedRules: [], evaluatedRules: 0 };
  if (state.decisionReview?.status === 'awaiting_review' || !candidateId || (isCodexCandidate && (!candidate?.patchDigest || gate?.passed !== true))) return state;
  const resolvedAt = markCandidateAccepted(state, note, 'policy');
  state.stage = 'curation';
  const primaryMeasurement = state.benchmark?.result?.benchmark?.[0];
  state.currentBest = {
    candidateId,
    version: candidate.version || 'agent.1',
    value: primaryMeasurement ? `${primaryMeasurement.value} ${primaryMeasurement.unit}` : '--',
    improvement: candidate.delta || 'new',
    status: 'active',
    evidenceSource: gate.evidenceSource || 'unknown',
    verified: gate.publishable === true,
  };
  state.decisionReview = {
    ...createDecisionReviewState('resolved'),
    recommendation: 'adopt',
    resolution: { outcome: 'adopt', source: 'policy', note, resolvedAt },
    resolvedAt,
  };
  state.knowledgeMaintenance = createKnowledgeMaintenanceState('ready');
  state.agent = {
    ...state.agent,
    status: 'executing',
    phase: 'Accept Gate 自动采用',
    currentAction: null,
    messages: [...(state.agent?.messages || []), { id: `auto-adopt-${Date.now()}`, phase: 'decision', status: 'completed', title: `Accept Gate 已自动采用 ${candidateId}`, detail: `${gate.passedRules?.length || 0} / ${gate.evaluatedRules || gate.passedRules?.length || 0} 条必需规则通过 · current best 已更新`, time: '刚刚' }],
  };
  appendRuntimeEvent(state, 'decision.auto_adopted', { candidate: candidateId, policyId: state.decisionReview.policy.id, passedRules: gate.passedRules || [], gate }, { kind: 'policy', mode: 'client' });
  addAuditEvent(state, 'Accept Gate 自动采用候选', `${candidateId} · ${gate.passedRules?.length || 0}/${gate.evaluatedRules || gate.passedRules?.length || 0} required rules passed`, 'green', 'ShieldCheck');
  return state;
}

const agentProfiles = [
  { id: 'profile.operator-orchestrator', name: 'Operator Orchestrator', version: 'v3.2.0', role: '目标拆解与路线调度', status: 'active', tools: 6, skills: 4 },
  { id: 'profile.result-analyst', name: 'Result Analyst', version: 'v2.4.1', role: '证据审查与采用判断', status: 'available', tools: 4, skills: 3 },
  { id: 'profile.experience-curator', name: 'Experience Curator', version: 'v1.8.0', role: '经验提炼与发布治理', status: 'available', tools: 3, skills: 2 },
];

const capabilityRegistry = {
  skills: [
    { id: 'skill.context-snapshot', name: '仓库上下文快照', version: 'v2.1.0', permission: 'repository:read' },
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

const createIdleAgent = (missionId = 'MIS_01JH7R', goal = '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟') => ({
  status: 'idle', phase: '待启动', progress: 0, missionId, runId: null, profileId: 'profile.operator-orchestrator', goal, startedAt: null, durationMs: 7200, currentAction: null, toolCalls: [],
  messages: [{ id: `agent-ready-${missionId}`, phase: 'Mission', status: 'ready', title: 'Mission 已准备就绪', detail: '目标、仓库和验证边界已固定。', time: '刚刚' }],
  artifacts: [
    { id: 'artifact-context', kind: 'Context Snapshot', title: 'Mission context', status: 'ready', meta: 'repository · constraints · baseline' },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: '3 条相关 Experience', status: 'ready', meta: 'C500 · paged_attention · validated' },
  ],
});

const createAwaitingAgent = (missionId, goal, candidateName, hardware = 'C500') => ({
  ...createIdleAgent(missionId, goal),
  status: 'awaiting_action',
  phase: '等待自动策略检查',
  progress: 100,
  currentAction: {
    id: 'action.candidate-02',
    type: 'candidate.plan',
    title: `自动检查 Candidate 02 · ${candidateName}`,
    reason: '已完成上下文、知识和性能证据对齐，候选变更限定在受控工作区。',
    expectedOutput: '2 个文件 · 受控 Patch · Correctness Matrix',
    risk: 'medium',
    approvalRequired: false,
    approvalPolicy: 'client-controlled',
  },
  messages: [
    { id: `agent-context-${missionId}`, phase: 'context', status: 'completed', title: '上下文读取完成', detail: '已固定仓库、基线和验证边界。', time: '7 分钟前' },
    { id: `agent-research-${missionId}`, phase: 'research', status: 'completed', title: '知识检索完成', detail: `已引用 3 条 ${hardware} 相关 Experience。`, time: '6 分钟前' },
    { id: `agent-diagnosis-${missionId}`, phase: 'diagnosis', status: 'completed', title: '瓶颈分析完成', detail: '已生成可审阅的候选变更范围。', time: '4 分钟前' },
    { id: `agent-approval-${missionId}`, phase: 'candidate', status: 'waiting', title: '等待自动策略检查', detail: '候选方案已经准备好，将先检查变更边界、工作区状态和风险策略。', time: '刚刚' },
  ],
  artifacts: [
    { id: 'artifact-context', kind: 'Context Snapshot', title: `${candidateName} / context`, status: 'ready', meta: 'repository · constraints · baseline' },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: `3 条 ${hardware} 相关 Experience`, status: 'ready', meta: `${hardware} · validated` },
    { id: 'artifact-candidate', kind: 'Candidate Plan', title: `Candidate 02 · ${candidateName}`, status: 'ready', meta: '2 files · +37 −18 · digest recorded' },
  ],
  toolCalls: [
    { id: `tool.repository-inspect-${missionId}`, toolId: 'tool.repository-inspect', name: 'Repository Inspector', version: 'v1.5.0', skillId: 'skill.context-snapshot', status: 'completed', summary: '读取仓库、Git 状态和当前最佳', permission: 'repository:read' },
    { id: `tool.experience-search-${missionId}`, toolId: 'tool.experience-search', name: 'Experience Search', version: 'v2.0.3', skillId: 'skill.context-snapshot', status: 'completed', summary: `检索到 3 条 ${hardware} 相关经验`, permission: 'knowledge:read' },
    { id: `tool.profile-timeline-${missionId}`, toolId: 'tool.profile-timeline', name: 'Profile Timeline', version: 'v1.8.0', skillId: 'skill.bottleneck-segmentation', status: 'completed', summary: '定位固定开销和关键时间线', permission: 'worker:execute' },
    { id: `tool.patch-workspace-${missionId}`, toolId: 'tool.patch-workspace', name: 'Patch Workspace', version: 'v1.4.2', skillId: 'skill.candidate-planning', status: 'completed', summary: '生成有界候选变更计划', permission: 'repository:write' },
  ],
});

const createMissionDomainState = (missionId, stage = 'diagnosis') => {
  const published = stage === 'published';
  const state = {
    testMatrix: { environments: ['C500', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] },
    runtimeEvents: [],
    knowledgeDrafts: structuredClone(knowledgeDrafts),
    candidateEvaluations: structuredClone(candidateEvaluations),
    failureRecords: structuredClone(failureRecords),
    publishedAssets: [],
    knowledgeMaintenance: createKnowledgeMaintenanceState(published ? 'completed' : 'idle'),
    decisionReview: createDecisionReviewState(published ? 'resolved' : 'idle'),
    workflowRecovery: createWorkflowRecoveryState(missionId),
    currentBest: createCurrentBestState(published ? 'candidate-02' : 'candidate-01'),
    knowledgeReferences: [],
    auditEvents: [],
    runHistory: [],
    missionPaused: false,
    researchNotes: [],
    researchAgent: createResearchAgentState(),
    iterationStats: createIterationStats(),
  };
  if (published) {
    markCandidateAccepted(state, '历史 Mission 已完成采用。', 'policy');
    state.publishedAssets = state.knowledgeDrafts.map((draft) => toPublishedKnowledgeAsset(draft, 'v1.0'));
  }
  return state;
};

const createSeedMissions = () => [
  { id: 'MIS_01JH7R', ...createMissionDomainState('MIS_01JH7R', 'candidate'), title: 'MLA Paged KV Cache', goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C500', 'CUDA'], metric: 'latency p50', stage: 'candidate', status: 'awaiting_approval', updatedLabel: '刚刚', result: { value: '41.8 μs', improvement: '−22.3%' }, patchApplied: false, benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] }, agent: createAwaitingAgent('MIS_01JH7R', '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', 'Async plan descriptor cache') },
  { id: 'MIS_01JGA4', ...createMissionDomainState('MIS_01JGA4', 'validation'), title: 'Paged Decode Shape Fast Path', goal: '降低 Paged Decode 在 C500 长尾 shape 下的 P95 延迟', repository: 'flashinfer-c500', hardware: ['C500'], metric: 'latency p95', stage: 'validation', status: 'awaiting_approval', updatedLabel: '18 分钟前', result: { value: '2.87 ms', improvement: '−8.6%' }, patchApplied: true, benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] }, agent: { ...createAwaitingAgent('MIS_01JGA4', '降低 Paged Decode 在 C500 长尾 shape 下的 P95 延迟', 'Decode shape fast path'), phase: '异构验证', currentAction: { id: 'action.decode-validation', type: 'test.plan', title: '运行 C500 Full Benchmark', reason: '30 / 30 Correctness 已通过，需要确认长尾收益。', expectedOutput: 'Full Benchmark · P50 / P95 compare', risk: 'medium', approvalRequired: true } } },
  { id: 'MIS_01JDX9', ...createMissionDomainState('MIS_01JDX9', 'published'), title: 'Ragged Prefill Vector Layout', goal: '优化 Ragged Prefill 的向量化访存和片上复用', repository: 'flashinfer-c500', hardware: ['C500'], metric: 'throughput', stage: 'published', status: 'completed', updatedLabel: '昨天', result: { value: '1.42×', improvement: '+42.1%' }, patchApplied: true, benchmark: { status: 'complete', progress: 100, runId: 'run_ARCHIVED', startedAt: null, durationMs: 2600, logs: [] }, agent: { ...createAwaitingAgent('MIS_01JDX9', '优化 Ragged Prefill 的向量化访存和片上复用', 'Vector layout reuse'), status: 'completed', phase: 'Mission 完成', progress: 100, currentAction: null } },
];

export const createSeedState = () => {
  const missions = createSeedMissions();
  const activeMission = missions[0];
  return {
  schemaVersion: 5,
  updatedAt: new Date().toISOString(),
  stage: activeMission.stage,
  patchApplied: activeMission.patchApplied,
  agent: structuredClone(activeMission.agent),
  activeMissionId: activeMission.id,
  missions,
  agentProfiles: structuredClone(agentProfiles),
  capabilityRegistry: structuredClone(capabilityRegistry),
  runtimeEvents: structuredClone(activeMission.runtimeEvents),
  benchmark: structuredClone(activeMission.benchmark),
  testMatrix: structuredClone(activeMission.testMatrix),
  knowledgeDrafts: structuredClone(activeMission.knowledgeDrafts),
  candidateEvaluations: structuredClone(activeMission.candidateEvaluations),
  failureRecords: structuredClone(activeMission.failureRecords),
  publishedAssets: structuredClone(activeMission.publishedAssets),
  knowledgeMaintenance: structuredClone(activeMission.knowledgeMaintenance),
  decisionReview: structuredClone(activeMission.decisionReview),
  workflowRecovery: structuredClone(activeMission.workflowRecovery),
  currentBest: structuredClone(activeMission.currentBest),
  runHistory: [],
  knowledgeReferences: [
    { assetId: 'exp.fixed-overhead', missionId: activeMission.id, version: 'v1.2', referencedAt: '2026-08-03T10:42:11.000Z', reason: '短序列固定开销与当前 Profile 症状一致' },
    { assetId: 'skill.segmentation', missionId: activeMission.id, version: 'v2.3.1', referencedAt: '2026-08-03T10:42:12.000Z', reason: '用于拆分 host/device 时间线' },
    { assetId: 'tool.profile-timeline', missionId: activeMission.id, version: 'v1.8.0', referencedAt: '2026-08-03T10:42:13.000Z', reason: '用于生成可审计 Profile 工件' },
  ],
  workspace: 'Matrix Lab',
  unreadCount: 2,
  missionPaused: false,
  researchNotes: structuredClone(activeMission.researchNotes || []),
  researchAgent: structuredClone(activeMission.researchAgent || createResearchAgentState()),
  iterationStats: structuredClone(activeMission.iterationStats || createIterationStats()),
  auditEvents: [
    { time: '10:42:23', title: 'Policy Engine 等待代码审批', detail: 'approval.apl_01JH7R · patch apply', tone: 'warning', icon: 'ShieldCheck' },
    { time: '10:42:19', title: 'Candidate Agent 生成 Candidate 02', detail: '2 files · +37 −18 · digest recorded', tone: 'blue', icon: 'Code2' },
    { time: '10:42:11', title: 'Research Agent 引用固定开销 Experience', detail: 'exp.short-seq.fixed-overhead@1.2 · validated', tone: 'green', icon: 'Search' },
  ],
  };
};

export const createProductState = () => {
  const fixture = createSeedState();
  const missionId = 'MIS_01JH7R';
  const goal = MLA_OPTIMIZATION_TEST_GOAL;
  const agent = {
    ...createIdleAgent(missionId, goal),
    phase: '等待启动实际优化任务',
    messages: [{ id: `agent-ready-${missionId}`, phase: 'Mission', status: 'ready', title: '实际优化测试例已就绪', detail: '任务已固定算子、Shape、目标硬件、指标、测试矩阵和 Accept Gate。', time: '刚刚' }],
    artifacts: [],
    toolCalls: [],
  };
  const domain = createMissionDomainState(missionId, 'diagnosis');
  const mission = {
    id: missionId,
    ...domain,
    title: 'MLA Paged KV Cache',
    goal,
    repository: 'mla-kernels',
    hardware: ['C500', 'CUDA'],
    metric: 'latency p50',
    stage: 'diagnosis',
    status: 'ready',
    updatedLabel: 'new',
    result: { value: '—', improvement: '—' },
    patchApplied: false,
    benchmark: { status: 'idle', progress: 0, runId: null, testTaskId: null, startedAt: null, completedAt: null, durationMs: 0, logs: [], result: null },
    agent,
    knowledgeDrafts: [],
    candidateEvaluations: [],
    failureRecords: [],
    publishedAssets: [],
    knowledgeReferences: [],
    runtimeEvents: [],
    auditEvents: [],
    currentBest: { candidateId: null, version: null, value: '—', improvement: '—', status: 'empty' },
  };
  return {
    ...fixture,
    stage: mission.stage,
    patchApplied: false,
    agent: structuredClone(agent),
    activeMissionId: missionId,
    missions: [mission],
    runtimeEvents: [],
    benchmark: structuredClone(mission.benchmark),
    testMatrix: structuredClone(mission.testMatrix),
    knowledgeDrafts: [],
    candidateEvaluations: [],
    failureRecords: [],
    publishedAssets: [],
    knowledgeMaintenance: structuredClone(mission.knowledgeMaintenance),
    decisionReview: structuredClone(mission.decisionReview),
    workflowRecovery: structuredClone(mission.workflowRecovery),
    currentBest: { candidateId: null, version: null, value: '—', improvement: '—', status: 'empty' },
    runHistory: [],
    knowledgeReferences: [],
    unreadCount: 0,
    auditEvents: [],
    researchNotes: [],
    researchAgent: createResearchAgentState(),
    iterationStats: createIterationStats(),
  };
};

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

export async function ensureMissionWorkspace(missionId, repository = '') {
  let sourceRepository = String(repository || '').trim();
  let projectRoot = '';
  let sourceRoot = '';
  if (!sourceRepository && await exists(statePath)) {
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      const mission = stored.missions?.find((item) => item.id === missionId);
      const project = stored.projects?.find((item) => item.id === mission?.projectId);
      sourceRepository = mission?.repository || project?.repository || '';
      projectRoot = mission?.projectRoot || project?.root || '';
      sourceRoot = mission?.sourceRoot || project?.sourceRoot || '';
    } catch { /* state loading reports malformed JSON separately */ }
  }
  if ((!projectRoot || !sourceRoot) && await exists(statePath)) {
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      const mission = stored.missions?.find((item) => item.id === missionId);
      const project = stored.projects?.find((item) => item.id === mission?.projectId);
      projectRoot ||= mission?.projectRoot || project?.root || '';
      sourceRoot ||= mission?.sourceRoot || project?.sourceRoot || '';
    } catch { /* state loading reports malformed JSON separately */ }
  }
  if (projectRoot) await ensureProjectLayout({ root: projectRoot, repository: sourceRepository, sourceRoot });
  const target = workspaceDirForMission(missionId, sourceRepository, projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  if (path.isAbsolute(sourceRepository) && await exists(sourceRepository)) {
    await workspaceManager.excludeProjectRuntime(sourceRepository);
  }
  await recoverWorkspaceSwap(target);
  const entries = await readdir(path.dirname(target));
  const legacyExists = await exists(workspaceDir);
  const template = !await exists(target) && !entries.length && legacyExists ? workspaceDir : workspaceTemplate;
  const inspection = await workspaceManager.ensure({ missionId, target, repository: sourceRepository, template, mode: 'snapshot' });
  if (!inspection.ready) {
    const error = new Error(inspection.detail || 'Mission 工作区预检失败。');
    error.code = inspection.code || 'WORKSPACE_NOT_READY';
    error.status = 503;
    throw error;
  }
  return target;
}

async function recoverWorkspaceSwap(target) {
  const parent = path.dirname(target);
  if (!(await exists(parent))) return;
  const targetName = path.basename(target);
  const entries = await readdir(parent);
  const backups = entries.filter((name) => name.startsWith(`${targetName}.backup-`)).sort().reverse();
  const stages = entries.filter((name) => name.startsWith(`${targetName}.stage-`));
  if (!(await exists(target)) && backups.length) await rename(path.join(parent, backups[0]), target);
  if (await exists(target)) await Promise.all(backups.map((name) => rm(path.join(parent, name), { recursive: true, force: true })));
  await Promise.all(stages.map((name) => rm(path.join(parent, name), { recursive: true, force: true })));
}

export async function ensureStorage({ ensureWorkspace = true } = {}) {
  if (usesManagedStorage) {
    await mkdir(path.dirname(dataDir), { recursive: true });
    if (!(await exists(statePath)) && await exists(path.join(legacyDataDir, 'mock-db.json'))) {
      await cp(legacyDataDir, dataDir, { recursive: true });
    }
    const migrationMarker = path.join(dataDir, 'storage-migration-v1.json');
    if (!(await exists(migrationMarker)) && await exists(legacyRuntimeDir)) {
      await mkdir(runtimeDir, { recursive: true });
      const retainedRuntimeEntries = ['agent-bridge', 'checkpoints', 'workspaces', 'operator-test-queue.jsonl'];
      for (const name of retainedRuntimeEntries) {
        const source = path.join(legacyRuntimeDir, name);
        const target = path.join(runtimeDir, name);
        if (await exists(source) && !(await exists(target))) {
          await cp(source, target, {
            recursive: true,
            filter: (entry) => path.basename(entry).toLowerCase() !== '.git',
          });
        }
      }
      await writeFile(migrationMarker, `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), retainedRuntimeEntries }, null, 2)}\n`, 'utf8');
    }
  }
  await mkdir(dataDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  let missionId = 'MIS_01JH7R';
  let repository = 'mla-kernels';
  if (!(await exists(statePath))) {
    const seed = process.env.OPERATOR_RUNTIME_MODE === 'reference-fixture' ? createSeedState() : createProductState();
    missionId = seed.activeMissionId;
    repository = seed.missions.find((mission) => mission.id === missionId)?.repository || repository;
    await saveState(seed);
  } else {
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      missionId = stored.activeMissionId || missionId;
      repository = stored.missions?.find((mission) => mission.id === missionId)?.repository || repository;
    } catch { /* loadState reports malformed JSON separately */ }
  }
  if (ensureWorkspace) await ensureMissionWorkspace(missionId, repository);
}

function ensureDomainState(state) {
  ensureProjects(state);
  if (!Array.isArray(state.missions) || !state.missions.length) {
    const fallback = { id: state.agent?.missionId || 'MIS_01JH7R', title: 'MLA Paged KV Cache', goal: state.agent?.goal || '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C500', 'CUDA'], metric: 'latency p50', stage: state.stage || 'diagnosis', status: state.agent?.status || 'ready', updatedLabel: '刚刚', result: { value: '41.8 μs', improvement: '−22.3%' }, patchApplied: Boolean(state.patchApplied), benchmark: structuredClone(state.benchmark || {}), agent: structuredClone(state.agent || createIdleAgent()) };
    state.missions = [fallback];
    state.activeMissionId = fallback.id;
  }
  if (!state.activeMissionId || !state.missions.some((mission) => mission.id === state.activeMissionId)) state.activeMissionId = state.missions[0].id;
  const activeMission = state.missions.find((mission) => mission.id === state.activeMissionId);
  const staleConnectionProbe = /OPERATOR_STUDIO_CODEX_OK|只读验证.*Codex|Connect an Agent and define an operator optimization goal/i.test(`${activeMission?.goal || ''} ${state.agent?.goal || ''}`);
  if (staleConnectionProbe && !state.missions.some((mission) => mission.id === 'MIS_REAL_MLA')) {
    const missionId = 'MIS_REAL_MLA';
    const domain = createMissionDomainState(missionId, 'diagnosis');
    const realMission = {
      id: missionId,
      ...domain,
      title: 'MLA Paged KV Cache / C500 P50 优化',
      goal: MLA_OPTIMIZATION_TEST_GOAL,
      repository: 'mla-kernels',
      hardware: ['C500', 'CUDA'],
      metric: 'latency p50',
      stage: 'diagnosis',
      status: 'ready',
      updatedLabel: '刚刚',
      result: { value: '--', improvement: 'new' },
      patchApplied: false,
      benchmark: { status: 'idle', progress: 0, runId: null, testTaskId: null, startedAt: null, completedAt: null, durationMs: 0, logs: [], result: null },
      knowledgeDrafts: [], candidateEvaluations: [], failureRecords: [], publishedAssets: [], knowledgeReferences: [],
      currentBest: { candidateId: null, version: null, value: '--', improvement: '--', status: 'empty' },
      runtimeEvents: [], auditEvents: [], runHistory: [],
      agent: createIdleAgent(missionId, MLA_OPTIMIZATION_TEST_GOAL),
    };
    state.missions = [realMission, ...state.missions];
    state.activeMissionId = missionId;
    state.stage = 'diagnosis';
    state.patchApplied = false;
    state.agent = structuredClone(realMission.agent);
    state.benchmark = structuredClone(realMission.benchmark);
    state.candidateEvaluations = [];
    state.failureRecords = [];
    state.knowledgeDrafts = [];
    state.publishedAssets = [];
    state.currentBest = structuredClone(realMission.currentBest);
  }
  if (!Array.isArray(state.agentProfiles)) state.agentProfiles = structuredClone(agentProfiles);
  if (!state.capabilityRegistry) state.capabilityRegistry = structuredClone(capabilityRegistry);
  if (!Array.isArray(state.runtimeEvents)) state.runtimeEvents = [];
  if (!state.testMatrix?.environments?.length || !state.testMatrix?.stages?.length) state.testMatrix = { environments: ['C500', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] };
  if (!Array.isArray(state.agent?.toolCalls)) state.agent = { ...state.agent, toolCalls: [] };
  const seedDrafts = new Map(knowledgeDrafts.map((draft) => [draft.id, draft]));
  state.knowledgeDrafts = Array.isArray(state.knowledgeDrafts)
    ? state.knowledgeDrafts.map((draft) => ({ ...(seedDrafts.get(draft.id) || {}), ...draft }))
    : structuredClone(knowledgeDrafts);
  if (!Array.isArray(state.publishedAssets)) state.publishedAssets = [];
  if (!Array.isArray(state.candidateEvaluations)) state.candidateEvaluations = structuredClone(candidateEvaluations);
  if (!Array.isArray(state.failureRecords)) state.failureRecords = structuredClone(failureRecords);
  if (!state.knowledgeMaintenance?.policy) {
    const maintenanceStatus = state.stage === 'curation' ? 'ready' : (state.stage === 'published' && state.publishedAssets.length ? 'completed' : 'idle');
    state.knowledgeMaintenance = createKnowledgeMaintenanceState(maintenanceStatus);
  }
  if (!Array.isArray(state.knowledgeReferences)) state.knowledgeReferences = [];
  if (!Array.isArray(state.runHistory)) state.runHistory = [];
  if (typeof state.missionPaused !== 'boolean') state.missionPaused = false;
  if (!Array.isArray(state.researchNotes)) state.researchNotes = [];
  if (!state.researchAgent) state.researchAgent = createResearchAgentState();
  if (!state.iterationStats) state.iterationStats = createIterationStats();
  if (!state.decisionReview?.policy) {
    const reviewStatus = state.stage === 'evidence' ? 'auto_ready' : (['curation', 'published'].includes(state.stage) ? 'resolved' : 'idle');
    state.decisionReview = createDecisionReviewState(reviewStatus);
  }
  const activeMissionRecord = state.missions.find((mission) => mission.id === state.activeMissionId);
  const expectedWorkspacePath = path.relative(rootDir, workspaceDirForMission(state.activeMissionId, activeMissionRecord?.repository, activeMissionRecord?.projectRoot)).replaceAll('\\', '/');
  if (!state.workflowRecovery?.worktree) state.workflowRecovery = createWorkflowRecoveryState(state.activeMissionId, activeMissionRecord?.repository, activeMissionRecord?.projectRoot);
  else state.workflowRecovery.worktree.path = expectedWorkspacePath;
  if (!state.currentBest || !Object.hasOwn(state.currentBest, 'candidateId')) state.currentBest = createCurrentBestState(state.stage === 'published' ? 'candidate-02' : 'candidate-01');
  state.missions = state.missions.map((mission) => {
    const defaults = createMissionDomainState(mission.id, mission.stage || 'diagnosis');
    const next = { ...defaults, ...mission };
    if (mission.id !== state.activeMissionId) return next;
    return {
      ...next,
      testMatrix: structuredClone(state.testMatrix),
      decisionReview: structuredClone(state.decisionReview),
      workflowRecovery: structuredClone(state.workflowRecovery),
      currentBest: structuredClone(state.currentBest),
      knowledgeDrafts: structuredClone(state.knowledgeDrafts),
      candidateEvaluations: structuredClone(state.candidateEvaluations),
      failureRecords: structuredClone(state.failureRecords),
      publishedAssets: structuredClone(state.publishedAssets),
      knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
      knowledgeReferences: structuredClone(state.knowledgeReferences),
      runtimeEvents: structuredClone(state.runtimeEvents),
      auditEvents: structuredClone(state.auditEvents || []),
      runHistory: structuredClone(state.runHistory || []),
      missionPaused: Boolean(state.missionPaused),
      researchNotes: structuredClone(state.researchNotes || []),
      researchAgent: structuredClone(state.researchAgent || createResearchAgentState()),
      iterationStats: structuredClone(state.iterationStats || createIterationStats()),
    };
  });
  ensureProjects(state);
  state.schemaVersion = 5;
  return state;
}

function projectActiveMission(state) {
  if (!Array.isArray(state.missions)) return state;
  const index = state.missions.findIndex((mission) => mission.id === state.activeMissionId);
  if (index === -1) return state;
  const deriveMissionStatus = () => {
    if (state.agent?.status === 'awaiting_approval') return 'awaiting_approval';
    if (['running', 'executing', 'cancel_requested'].includes(state.agent?.status)) return 'running';
    if (state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed') return 'completed';
    return 'ready';
  };
  state.missions[index] = {
    ...state.missions[index],
    goal: state.agent?.goal || state.missions[index].goal,
    stage: state.stage,
    status: deriveMissionStatus(),
    patchApplied: state.patchApplied,
    benchmark: structuredClone(state.benchmark),
    testMatrix: structuredClone(state.testMatrix),
    decisionReview: structuredClone(state.decisionReview),
    workflowRecovery: structuredClone(state.workflowRecovery),
    currentBest: structuredClone(state.currentBest),
    knowledgeDrafts: structuredClone(state.knowledgeDrafts),
    candidateEvaluations: structuredClone(state.candidateEvaluations),
    failureRecords: structuredClone(state.failureRecords),
    publishedAssets: structuredClone(state.publishedAssets),
    knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
    knowledgeReferences: structuredClone(state.knowledgeReferences),
    runtimeEvents: structuredClone(state.runtimeEvents),
    auditEvents: structuredClone(state.auditEvents),
    runHistory: structuredClone(state.runHistory || []),
    missionPaused: Boolean(state.missionPaused),
    researchNotes: structuredClone(state.researchNotes || []),
    researchAgent: structuredClone(state.researchAgent || createResearchAgentState()),
    iterationStats: structuredClone(state.iterationStats || createIterationStats()),
    agent: structuredClone(state.agent),
    updatedLabel: '刚刚',
  };
  return state;
}

export function selectMission(state, missionId) {
  projectActiveMission(state);
  const mission = state.missions.find((item) => item.id === missionId);
  if (!mission) {
    const error = new Error('Mission 不存在。');
    error.status = 404;
    throw error;
  }
  const defaults = createMissionDomainState(mission.id, mission.stage || 'diagnosis');
  state.activeMissionId = mission.id;
  state.activeProjectId = mission.projectId || state.projects?.find((project) => project.repository === mission.repository)?.id || state.activeProjectId;
  state.stage = mission.stage || 'diagnosis';
  state.patchApplied = Boolean(mission.patchApplied);
  state.benchmark = structuredClone(mission.benchmark || { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] });
  state.testMatrix = structuredClone(mission.testMatrix || defaults.testMatrix);
  state.decisionReview = structuredClone(mission.decisionReview || defaults.decisionReview);
  state.workflowRecovery = structuredClone(mission.workflowRecovery || defaults.workflowRecovery);
  state.currentBest = structuredClone(mission.currentBest || defaults.currentBest);
  state.knowledgeDrafts = structuredClone(mission.knowledgeDrafts || defaults.knowledgeDrafts);
  state.candidateEvaluations = structuredClone(mission.candidateEvaluations || defaults.candidateEvaluations);
  state.failureRecords = structuredClone(mission.failureRecords || defaults.failureRecords);
  state.publishedAssets = structuredClone(mission.publishedAssets || defaults.publishedAssets);
  state.knowledgeMaintenance = structuredClone(mission.knowledgeMaintenance || defaults.knowledgeMaintenance);
  state.knowledgeReferences = structuredClone(mission.knowledgeReferences || defaults.knowledgeReferences);
  state.runtimeEvents = structuredClone(mission.runtimeEvents || defaults.runtimeEvents);
  state.auditEvents = structuredClone(mission.auditEvents || defaults.auditEvents);
  state.runHistory = structuredClone(mission.runHistory || defaults.runHistory);
  state.missionPaused = Boolean(mission.missionPaused ?? false);
  state.researchNotes = structuredClone(mission.researchNotes || defaults.researchNotes || []);
  state.researchAgent = structuredClone(mission.researchAgent || defaults.researchAgent || createResearchAgentState());
  state.iterationStats = structuredClone(mission.iterationStats || defaults.iterationStats || createIterationStats());
  state.agent = structuredClone(mission.agent || createIdleAgent(mission.id, mission.goal));
  addAuditEvent(state, 'Mission 已切换', `${mission.id} · ${mission.title}`, 'blue', 'GitBranch');
  return state;
}

export function selectProject(state, projectId) {
  projectActiveMission(state);
  const project = state.projects?.find((item) => item.id === projectId);
  if (!project) { const error = new Error('项目不存在。'); error.status = 404; throw error; }
  state.activeProjectId = project.id;
  const linkedMissions = state.missions.filter((mission) => mission.projectId === project.id || mission.repository === project.repository);
  const selectedMission = linkedMissions.find((mission) => mission.status === 'running')
    || linkedMissions.find((mission) => mission.status !== 'completed')
    || linkedMissions[0]
    || null;
  if (selectedMission) selectMission(state, selectedMission.id);
  else addAuditEvent(state, '项目已切换', `${project.name} · 尚未创建 Mission`, 'blue', 'FolderGit2');
  return { project, selectedMission };
}

export function createMission(state, input) {
  projectActiveMission(state);
  const id = `MIS_${Date.now().toString(36).toUpperCase()}`;
  const title = input.title?.trim() || input.goal.trim().slice(0, 30);
  const hardware = Array.isArray(input.hardware) && input.hardware.length ? input.hardware : ['C500'];
  const project = state.projects?.find((item) => item.id === input.projectId) || state.projects?.find((item) => item.repository === input.repository);
  const repository = project?.repository || input.repository?.trim() || 'mla-kernels';
  const mission = {
    id,
    ...createMissionDomainState(id, 'diagnosis'),
    title,
    goal: input.goal.trim(),
    projectId: project?.id || projectIdForRepository(repository),
    repository,
    projectRoot: project?.root || input.projectRoot || null,
    sourceRoot: project?.sourceRoot || input.sourceRoot || null,
    hardware,
    metric: input.metric?.trim() || 'latency p50',
    stage: 'diagnosis',
    status: 'ready',
    updatedLabel: '刚刚',
    result: { value: '—', improvement: 'new' },
    patchApplied: false,
    benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] },
    knowledgeDrafts: [],
    candidateEvaluations: [],
    failureRecords: [],
    publishedAssets: [],
    knowledgeReferences: [],
    currentBest: { candidateId: null, version: null, value: '--', improvement: '--', status: 'empty' },
    agent: createIdleAgent(id, input.goal.trim()),
  };
  mission.workflowRecovery = createWorkflowRecoveryState(id, repository, mission.projectRoot);
  state.missions = [mission, ...state.missions];
  if (!state.projects?.some((item) => item.id === mission.projectId)) state.projects = [createProjectRecord(repository, { id: mission.projectId }), ...(state.projects || [])];
  state.activeProjectId = mission.projectId;
  return selectMission(state, id);
}

export function createProject(state, input) {
  const repository = String(input.repository || '').trim();
  if (!repository) { const error = new Error('请选择或输入本地 Git 仓库路径。'); error.status = 400; throw error; }
  if (state.projects?.some((project) => project.repository.toLowerCase() === repository.toLowerCase())) { const error = new Error('该仓库已经登记为项目。'); error.status = 409; throw error; }
  const project = createProjectRecord(repository, {
    name: String(input.name || '').trim() || projectNameForRepository(input.root || repository),
    defaultBranch: String(input.defaultBranch || '').trim() || 'HEAD',
    root: input.root || null,
    sourceRoot: input.sourceRoot || null,
    runtimeRoot: input.runtimeRoot || null,
    layout: input.layout || 'legacy-compatible',
  });
  state.projects = [project, ...(state.projects || [])];
  state.activeProjectId = project.id;
  return project;
}

export function updateProject(state, projectId, input) {
  const project = state.projects?.find((item) => item.id === projectId);
  if (!project) { const error = new Error('项目不存在。'); error.status = 404; throw error; }
  if (input.repository && input.repository !== project.repository && state.missions.some((mission) => mission.projectId === projectId)) { const error = new Error('项目已有 Mission，不能直接更换仓库路径；请新建项目。'); error.status = 409; throw error; }
  if (input.name !== undefined) project.name = String(input.name).trim() || project.name;
  if (input.defaultBranch !== undefined) project.defaultBranch = String(input.defaultBranch).trim() || 'HEAD';
  if (input.status !== undefined) {
    if (!['active', 'archived'].includes(input.status)) { const error = new Error('项目状态无效。'); error.status = 400; throw error; }
    const running = state.missions.some((mission) => mission.projectId === projectId && mission.status === 'running');
    if (input.status === 'archived' && running) { const error = new Error('项目仍有运行中的 Mission，不能归档。'); error.status = 409; throw error; }
    project.status = input.status;
  }
  project.updatedAt = new Date().toISOString();
  return project;
}

export function deleteProject(state, projectId) {
  const project = state.projects?.find((item) => item.id === projectId);
  if (!project) { const error = new Error('项目不存在。'); error.status = 404; throw error; }
  const linked = state.missions.filter((mission) => mission.projectId === projectId);
  if (linked.length) { const error = new Error(`项目仍关联 ${linked.length} 个 Mission，请先保留为归档项目。`); error.status = 409; throw error; }
  state.projects = state.projects.filter((item) => item.id !== projectId);
  if (state.activeProjectId === projectId) state.activeProjectId = state.projects.find((item) => item.status === 'active')?.id || state.projects[0]?.id || null;
  return project;
}

export async function loadState({ runtimeMode, ensureWorkspace = true } = {}) {
  await ensureStorage({ ensureWorkspace });
  let state = JSON.parse(await readFile(statePath, 'utf8'));
  const needsMigration = state.schemaVersion !== 5 || !Array.isArray(state.projects) || !Array.isArray(state.missions) || !state.capabilityRegistry || !Array.isArray(state.agent?.toolCalls) || !Array.isArray(state.knowledgeReferences) || !state.knowledgeMaintenance?.policy || !state.decisionReview?.policy || !Array.isArray(state.candidateEvaluations) || !Array.isArray(state.failureRecords) || state.missions.some((mission) => !mission.workflowRecovery || !mission.testMatrix || !Array.isArray(mission.knowledgeDrafts) || !Array.isArray(mission.candidateEvaluations) || !Array.isArray(mission.failureRecords) || !Array.isArray(mission.publishedAssets) || !mission.knowledgeMaintenance?.policy || !mission.decisionReview?.policy || !Array.isArray(mission.runtimeEvents) || !Array.isArray(mission.runHistory));
  state = ensureDomainState(state);
  const effectiveRuntimeMode = runtimeMode || process.env.OPERATOR_RUNTIME_MODE || 'unavailable';
  const usesReferenceRuntime = effectiveRuntimeMode === 'reference-fixture' && !state.agent?.runId?.startsWith('cli_');
  const usesVerifiedCodexRuntime = effectiveRuntimeMode === 'codex-cli' && state.agent?.runtimeKind === 'codex-cli';
  const staleMockPublication = state.benchmark?.result?.environment?.liveHardware === false
    && state.knowledgeMaintenance?.status === 'completed'
    && state.publishedAssets?.some((asset) => asset.status === 'published');
  const knowledgeChanged = (usesReferenceRuntime || usesVerifiedCodexRuntime)
    && ((state.stage === 'curation' && state.knowledgeMaintenance.status === 'ready') || staleMockPublication);
  if (knowledgeChanged) state = runKnowledgeMaintenance(state);
  const referenceAutoAdoption = usesReferenceRuntime && state.stage === 'evidence' && state.benchmark?.status === 'complete' && state.decisionReview?.status !== 'awaiting_review';
  const activeMissionForAdoption = state.missions?.find((mission) => mission.id === state.activeMissionId);
  // Three-layer projects must commit the verified patch to the Iteration
  // Repository in the client runtime before policy adoption is recorded.
  const codexAutoAdoption = usesVerifiedCodexRuntime
    && !activeMissionForAdoption?.projectRoot
    && state.stage === 'evidence'
    && state.benchmark?.status === 'complete'
    && state.decisionReview?.status === 'auto_ready'
    && state.decisionReview?.recommendation === 'adopt'
    && state.decisionReview?.gate?.passed === true
    && state.decisionReview?.status !== 'awaiting_review';
  const policyAutoAdopted = referenceAutoAdoption || codexAutoAdoption;
  if (policyAutoAdopted) state = runAutomaticAdoption(state);
  const benchmarkBefore = JSON.stringify(state.benchmark);
  if (usesReferenceRuntime && !state.benchmark?.testTaskId) state = refreshBenchmark(state);
  const refreshedAgent = usesReferenceRuntime ? refreshAgent(state) : { state, changed: false };
  if (needsMigration || policyAutoAdopted || knowledgeChanged || refreshedAgent.changed || benchmarkBefore !== JSON.stringify(state.benchmark)) return saveState(refreshedAgent.state);
  return state;
}

export async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  const next = { ...projectActiveMission(ensureDomainState(state)), updatedAt: new Date().toISOString() };
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, statePath);
      break;
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      await delay(20 * (attempt + 1));
    }
  }
  return next;
}

export async function resetDemoData() {
  const state = await saveState(createSeedState());
  if (await exists(missionWorkspaceRoot)) await rm(missionWorkspaceRoot, { recursive: true, force: true });
  if (await exists(workspaceDir)) await rm(workspaceDir, { recursive: true, force: true });
  if (await exists(workspaceCheckpointRoot)) await rm(workspaceCheckpointRoot, { recursive: true, force: true });
  await ensureMissionWorkspace(state.activeMissionId);
  return state;
}

export function addAuditEvent(state, title, detail, tone = 'blue', icon = 'Activity') {
  const event = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), title, detail, tone, icon };
  state.auditEvents = [event, ...(state.auditEvents || [])].slice(0, 30);
  return event;
}

function refreshBenchmark(state) {
  if (state.benchmark?.status !== 'running' || !state.benchmark.startedAt) return state;
  const elapsed = Date.now() - new Date(state.benchmark.startedAt).getTime();
  const progress = Math.min(100, Math.max(0, Math.floor((elapsed / state.benchmark.durationMs) * 100 / 10) * 10));
  state.benchmark.progress = progress;
  state.benchmark.logs = buildBenchmarkLogsForMatrix(progress, state.benchmark.matrix || state.testMatrix);
  if (progress >= 100) {
    state.benchmark.status = 'complete';
    state.stage = 'evidence';
    if (!state.benchmark.completedAt) {
      state.benchmark.completedAt = new Date().toISOString();
      addAuditEvent(state, 'Full Benchmark 已完成', 'C500 41.8μs · CUDA 36.1μs · 24/24', 'green', 'CheckCircle2');
      appendRuntimeEvent(state, 'test_task.completed', { runId: state.benchmark.runId, correctness: '24/24', evidenceLevel: 'Level 3' }, { kind: 'queue', mode: 'reference-fixture' });
    }
    if (state.decisionReview?.status === 'awaiting_review') {
      state.decisionReview = { ...state.decisionReview, recommendation: 'adopt', gateEvaluatedAt: state.benchmark.completedAt };
      state.agent = {
        ...state.agent,
        status: 'awaiting_approval',
        phase: '人工介入待处理',
        currentAction: { ...(state.agent?.currentAction || {}), type: 'review.resolve', approvalRequired: true, reviewMode: 'human_requested' },
      };
    } else {
      state.decisionReview = {
        ...(state.decisionReview || createDecisionReviewState('auto_ready')),
        status: 'auto_ready',
        recommendation: 'adopt',
        requiresApproval: false,
        gateEvaluatedAt: state.benchmark.completedAt,
      };
      state.agent = {
        ...state.agent,
        status: 'awaiting_action',
        phase: '效果决策可查看',
        currentAction: { id: 'action.adoption-decision', type: 'adoption.decision', title: 'Accept Gate 已完成，等待策略执行', reason: '证据已经形成，下一次状态推进将按策略自动采用。', expectedOutput: 'Policy Decision · current best update', risk: 'medium', approvalRequired: false, reviewMode: 'conditional' },
      };
    }
  }
  return state;
}

export function applyOperatorTestSnapshot(state, snapshot) {
  if (!snapshot || snapshot.taskId !== state.benchmark?.testTaskId) return state;
  const previousStatus = state.benchmark.status;
  const nextStatus = snapshot.status === 'completed' ? 'complete' : snapshot.status === 'failed' ? 'failed' : snapshot.status === 'cancelled' ? 'cancelled' : 'running';
  state.benchmark = {
    ...state.benchmark,
    status: nextStatus,
    progress: Number(snapshot.progress || 0),
    logs: Array.isArray(snapshot.logs) ? structuredClone(snapshot.logs) : [],
    completedAt: snapshot.completedAt || null,
    durationMs: Number(snapshot.durationMs || state.benchmark.durationMs || 0),
    result: snapshot.result ? structuredClone(snapshot.result) : state.benchmark.result || null,
    source: { kind: 'operator-test-service', mock: snapshot.result?.environment?.liveHardware === false },
    lastServiceError: null,
  };
  if (nextStatus === 'cancelled') {
    state.agent = {
      ...state.agent,
      status: 'cancelled',
      phase: '测试已取消',
      progress: state.benchmark.progress,
      currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '重新提交测试矩阵', reason: '本次测试已取消，候选仍保留在隔离工作区。', expectedOutput: 'Correctness · Benchmark · Tracer · Profiler', risk: 'low', approvalRequired: false },
    };
    if (previousStatus !== 'cancelled') {
      addAuditEvent(state, '算子测试已取消', `Queue ${snapshot.taskId}`, 'warning', 'CircleStop');
      appendRuntimeEvent(state, 'operator_test.cancelled', { taskId: snapshot.taskId, runId: state.benchmark.runId }, { kind: 'operator-test-queue', mode: 'client' });
    }
    return state;
  }
  if (nextStatus !== 'complete') return state;

  state.stage = 'evidence';
  if (previousStatus !== 'complete') {
    const measurements = snapshot.result?.benchmark || [];
    const summary = measurements.map((item) => `${item.environment} ${item.value}${item.unit}`).join(' / ') || 'Benchmark completed';
    addAuditEvent(state, 'Operator benchmark completed', summary, 'green', 'CheckCircle2');
    appendRuntimeEvent(state, 'operator_test.completed', {
      taskId: snapshot.taskId,
      runId: state.benchmark.runId,
      benchmark: structuredClone(measurements),
      tracerFormat: snapshot.result?.tracer?.format || null,
      profilerFormat: snapshot.result?.profiler?.format || null,
    }, { kind: 'operator-test-service', mode: snapshot.result?.environment?.liveHardware ? 'live' : 'mock' });
  }
  const gate = evaluateAcceptGate(state, snapshot.result || {});
  const candidateId = state.appliedCandidateId || state.benchmark?.candidate?.id || null;
  const recommendation = gate.result === 'eligible' ? 'adopt' : gate.result === 'reference' ? 'reference' : 'reject';
  applyGateDisposition(state, candidateId, gate);
  if (gate.passed && state.agent?.runtimeKind === 'codex-cli') ensureEvidenceKnowledgeDraft(state, candidateId, gate);
  appendRuntimeEvent(state, 'accept_gate.evaluated', { candidate: candidateId, result: gate.result, passed: gate.passed, rules: gate.rules }, { kind: 'policy', mode: 'client' });
  if (state.decisionReview?.status === 'awaiting_review') {
    state.decisionReview = { ...state.decisionReview, candidateId, recommendation, gate, gateEvaluatedAt: state.benchmark.completedAt };
    state.agent = {
      ...state.agent,
      status: 'awaiting_approval',
      phase: 'Human intervention pending',
      currentAction: { ...(state.agent?.currentAction || {}), type: 'review.resolve', approvalRequired: true, reviewMode: 'human_requested' },
    };
  } else {
    state.decisionReview = {
      ...(state.decisionReview || createDecisionReviewState('auto_ready')),
      status: gate.passed ? 'auto_ready' : 'resolved',
      candidateId,
      recommendation,
      gate,
      requiresApproval: false,
      gateEvaluatedAt: state.benchmark.completedAt,
      resolution: gate.passed ? null : { outcome: recommendation, source: 'accept_gate', note: gate.summary, resolvedAt: state.benchmark.completedAt },
    };
    state.agent = {
      ...state.agent,
      status: gate.passed ? 'awaiting_action' : 'completed',
      phase: gate.passed ? 'Accept Gate 已通过' : gate.result === 'reference' ? '候选保留为参考' : '候选验证失败',
      currentAction: gate.passed ? {
        id: 'action.adoption-decision',
        type: 'adoption.decision',
        title: 'Accept Gate 已通过，策略将自动采用',
        reason: gate.summary,
        expectedOutput: '更新 current best 并自动沉淀知识',
        risk: 'low',
        approvalRequired: false,
        reviewMode: 'conditional',
      } : null,
    };
  }
  return state;
}

const parsePerformanceThreshold = (mission = {}) => {
  const text = `${mission.goal || ''} ${mission.metric || ''}`;
  const match = text.match(/(?:<|<=|≤|低于|不高于|控制在)\s*(\d+(?:\.\d+)?)\s*(?:μs|us|ms)?/i);
  return match ? Number(match[1]) : null;
};

export function evaluateAcceptGate(state, result = {}) {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const measurements = Array.isArray(result.benchmark) ? result.benchmark : [];
  const expectedCases = Number(state.benchmark?.matrix?.correctnessCases || state.testMatrix?.correctnessCases || 24);
  const correctnessPassed = measurements.length > 0 && measurements.every((item) => item.correctness?.passed === true && Number(item.correctness?.total || 0) >= expectedCases);
  const evidencePassed = measurements.length > 0
    && result.tracer?.format === 'operator-trace/v1'
    && Array.isArray(result.tracer?.events)
    && result.profiler?.format === 'operator-profile/v1'
    && result.profiler?.metrics && typeof result.profiler.metrics === 'object';
  const liveEvidence = result.environment?.liveHardware === true;
  const threshold = parsePerformanceThreshold(mission);
  const primaryHardware = String(mission.hardware?.[0] || measurements[0]?.environment || '').toLowerCase();
  const primary = measurements.find((item) => String(item.environment || '').toLowerCase().includes(primaryHardware)) || measurements[0];
  const minimizesMetric = !String(mission.metric || '').toLowerCase().includes('throughput');
  const performanceApplicable = Number.isFinite(threshold) && Number.isFinite(Number(primary?.value));
  const performancePassed = performanceApplicable && (minimizesMetric ? Number(primary.value) <= threshold : Number(primary.value) >= threshold);
  const rules = [
    { id: 'correctness.complete', label: 'Correctness 用例全部通过', required: true, passed: correctnessPassed, actual: measurements.map((item) => `${item.environment} ${item.correctness?.passed ? item.correctness.total : 0}/${item.correctness?.total || expectedCases}`).join(' · '), expected: `${expectedCases}/${expectedCases}` },
    { id: 'evidence.complete', label: 'Benchmark / Tracer / Profiler 证据完整', required: true, passed: Boolean(evidencePassed), actual: evidencePassed ? '三类证据齐全' : '证据缺失或格式不匹配', expected: 'operator benchmark + trace/v1 + profile/v1' },
    { id: 'performance.target', label: '达到 Mission 性能目标', required: true, passed: performancePassed, skipped: false, actual: primary ? `${primary.environment} ${primary.value}${primary.unit}` : '无测量值', expected: Number.isFinite(threshold) ? `${minimizesMetric ? '≤' : '≥'} ${threshold}${primary?.unit || ''}` : 'Mission 必须配置数值阈值' },
    { id: 'cross_platform.regression', label: '跨平台相对 current best 无回归', required: false, passed: null, skipped: true, actual: '未配置逐平台 current best 基线', expected: '为各平台登记可比较基线后评估' },
    { id: 'evidence.provenance', label: '真实硬件证据可用于正式发布', required: false, passed: liveEvidence, skipped: false, actual: liveEvidence ? '真实测试服务' : 'Mock 测试服务', expected: 'liveHardware=true' },
  ];
  const requiredRules = rules.filter((rule) => rule.required);
  const failedRules = requiredRules.filter((rule) => !rule.passed).map((rule) => rule.id);
  const passedRules = requiredRules.filter((rule) => rule.passed).map((rule) => rule.id);
  const hardFailure = !correctnessPassed || !evidencePassed;
  const passed = failedRules.length === 0;
  const resultKind = passed ? 'eligible' : hardFailure ? 'failed' : 'reference';
  return {
    passed,
    publishable: passed && liveEvidence,
    evidenceSource: liveEvidence ? 'live' : 'mock',
    result: resultKind,
    rules,
    passedRules,
    failedRules,
    evaluatedRules: requiredRules.length,
    skippedRules: rules.filter((rule) => rule.skipped).map((rule) => rule.id),
    summary: passed
      ? `${passedRules.length}/${requiredRules.length} 条必需规则通过；${liveEvidence ? '证据可用于正式发布。' : '当前为 Mock 证据，只能验证流程与生成预览资产。'}`
      : resultKind === 'reference'
        ? `正确性与证据完整，但未达到性能目标；候选保留为弱候选参考。`
        : `正确性或证据完整性未通过；候选退出候选池并保留失败记录。`,
    evaluatedAt: new Date().toISOString(),
  };
}

const applyGateDisposition = (state, candidateId, gate) => {
  if (!candidateId) return;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  if (!candidate) return;
  candidate.acceptGate = gate;
  if (gate.result === 'eligible') {
    candidate.classification = 'eligible';
    candidate.status = 'Accept Gate 已通过';
    candidate.decision = '等待策略自动采用';
    candidate.decisionReason = gate.summary;
    return;
  }
  if (gate.result === 'reference') {
    candidate.classification = 'reference';
    candidate.status = '弱候选参考';
    candidate.tone = 'reference';
    candidate.decision = '未采用，保留为弱候选参考';
    candidate.decisionReason = gate.summary;
    return;
  }
  const failedAt = new Date().toISOString();
  state.failureRecords = [{
    id: `failure.${candidateId}.${Date.now()}`,
    recordType: 'failure',
    sourceAttempt: candidateId,
    label: `${candidate.label || candidateId} Failure Record`,
    version: candidate.version || 'agent.1',
    date: failedAt,
    status: '已退出候选池',
    tone: 'failed',
    title: candidate.title,
    hypothesis: candidate.hypothesis,
    change: candidate.change,
    files: candidate.files,
    evidence: state.benchmark?.runId || 'operator test',
    decision: 'Accept Gate 硬门禁失败，禁止形成候选',
    decisionReason: gate.summary,
    failure: { gate: 'Accept Gate', code: 'ACCEPT_GATE_HARD_FAILURE', failedRules: gate.failedRules, disposition: 'candidate_removed' },
    retainedArtifacts: [candidate.patchDigest, state.benchmark?.runId, state.benchmark?.result?.tracer?.format, state.benchmark?.result?.profiler?.format].filter(Boolean),
    extractedExperience: { id: `negative.${candidateId}`, status: 'extracted', title: `${candidate.title} 的失败边界`, rule: gate.summary, reuse: `后续候选必须先满足：${gate.failedRules.join('、')}`, evidenceLevel: 'negative evidence' },
  }, ...(state.failureRecords || [])];
  state.candidateEvaluations = state.candidateEvaluations.filter((item) => item.id !== candidateId);
};

const ensureEvidenceKnowledgeDraft = (state, candidateId, gate) => {
  if (!candidateId || state.knowledgeDrafts?.some((draft) => draft.sourceCandidate === candidateId)) return;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  if (!candidate) return;
  const measurements = state.benchmark?.result?.benchmark || [];
  state.knowledgeDrafts = [...(state.knowledgeDrafts || []), {
    id: `exp.${safeMissionId(state.activeMissionId).toLowerCase()}.${candidateId}`,
    code: `EXP-${Date.now().toString(36).toUpperCase()}`,
    category: 'Mission 验证经验',
    title: candidate.title,
    conclusion: candidate.change || candidate.hypothesis,
    scope: `${(mission.hardware || []).join(' / ') || '目标硬件'} · ${mission.metric || '性能指标'}`,
    hardware: mission.hardware || [],
    operator: mission.title || 'operator',
    dtype: '由项目配置继承',
    layout: '由项目配置继承',
    shape: '由测试矩阵继承',
    runtime: state.benchmark?.result?.environment?.runtime || 'client-managed-runtime',
    trigger: candidate.hypothesis,
    procedure: `应用 Patch ${candidate.patchDigest}，通过串行测试队列执行 Correctness、Benchmark、Tracer 与 Profiler。`,
    expectedGain: measurements.map((item) => `${item.environment} ${item.value}${item.unit}`).join(' · '),
    validation: gate.summary,
    constraints: `仅适用于本次已验证的 Mission 范围；${gate.skippedRules.length ? '未评估规则不得外推。' : '所有配置门禁均已评估。'}`,
    contraindications: '工作区 Diff、环境、测试矩阵或硬件范围变化时必须重新验证。',
    failedAttempts: '无',
    evidence: `${state.benchmark?.runId} · ${gate.passedRules.length}/${gate.evaluatedRules} required gates`,
    evidenceLevel: gate.publishable ? 'Level 3' : '模拟证据',
    confidence: gate.publishable ? '中' : '仅供流程验证',
    evidenceRefs: [state.activeMissionId, candidateId, candidate.patchDigest, state.benchmark?.runId, state.benchmark?.result?.tracer?.format, state.benchmark?.result?.profiler?.format].filter(Boolean),
    sourceMission: state.activeMissionId,
    sourceCandidate: candidateId,
    sourceCommit: state.workflowRecovery?.worktree?.head || 'isolated-worktree',
    owner: 'Operator Studio',
    status: gate.publishable ? 'validated' : 'simulation',
  }];
};

function refreshAgent(state) {
  const agent = state.agent;
  if (!agent || agent.status !== 'running' || !agent.startedAt) return { state, changed: false };
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const missionTitle = mission.title || '当前算子';
  const hardware = mission.hardware?.[0] || '目标硬件';
  const metric = mission.metric || '性能指标';
  const candidateName = `${missionTitle} ${metric} fast path`;
  const elapsed = Date.now() - new Date(agent.startedAt).getTime();
  const progress = Math.min(100, Math.max(0, Math.floor((elapsed / agent.durationMs) * 100 / 10) * 10));
  const phases = [
    [0, '上下文读取', 'Context Agent 正在读取仓库、Git 状态和当前最佳。', 'context'],
    [20, '知识检索', 'Research Agent 已找到 3 条适用于 C500 的 Experience。', 'research'],
    [40, '瓶颈分析', 'Bottleneck Agent 正在对齐 plan、workspace 和 host mirror 的时间线。', 'diagnosis'],
    [60, '候选规划', 'Candidate Agent 正在生成有界变更和验证约束。', 'candidate'],
    [80, '补丁准备', 'Candidate Plan 已生成，正在准备自动策略检查。', 'candidate'],
    [100, '策略检查就绪', 'Candidate 02 已准备好，可自动检查变更边界并写入隔离工作区。', 'candidate'],
  ];
  const current = phases.reduce((selected, item) => (progress >= item[0] ? item : selected), phases[0]);
  const messages = phases.filter(([threshold]) => progress >= threshold).map(([threshold, title, detail, phase], index) => ({
    id: `agent-${threshold}`,
    phase,
    status: threshold === 100 ? 'waiting' : 'completed',
    title,
    detail,
    time: threshold === 0 ? '刚刚' : `${Math.max(1, Math.floor((elapsed - (threshold / 100) * agent.durationMs) / 1000))}s 前`,
  }));
  const artifacts = [
    { id: 'artifact-context', kind: 'Context Snapshot', title: progress >= 20 ? `${missionTitle} / context` : '正在读取仓库上下文', status: progress >= 20 ? 'ready' : 'running', meta: `${mission.repository || 'repository'} · constraints · baseline` },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: progress >= 40 ? `3 条 ${hardware} 相关 Experience` : '等待知识检索', status: progress >= 40 ? 'ready' : progress >= 20 ? 'running' : 'queued', meta: `${hardware} · ${metric} · validated` },
  ];
  const toolDefinitions = [
    [0, 'tool.repository-inspect', 'Repository Inspector', 'v1.5.0', '读取仓库、Git 状态和当前最佳', 'skill.context-snapshot'],
    [20, 'tool.experience-search', 'Experience Search', 'v2.0.3', `检索到 3 条 ${hardware} 相关经验`, 'skill.context-snapshot'],
    [40, 'tool.profile-timeline', 'Profile Timeline', 'v1.8.0', '定位 plan、workspace 和 host mirror 固定开销', 'skill.bottleneck-segmentation'],
    [60, 'tool.patch-workspace', 'Patch Workspace', 'v1.4.2', `生成 ${missionTitle} 的有界变更计划`, 'skill.candidate-planning'],
  ];
  const toolCalls = toolDefinitions.filter(([threshold]) => progress >= threshold).map(([threshold, id, name, version, summary, skillId]) => ({ id: `${id}-${agent.runId}`, toolId: id, name, version, skillId, status: progress >= Math.min(100, threshold + 20) ? 'completed' : 'running', summary, permission: capabilityRegistry.tools.find((tool) => tool.id === id)?.permission || 'read' }));
  const next = { ...agent, progress, phase: current[1], messages, artifacts, toolCalls };
  if (progress >= 100) {
    next.status = 'awaiting_action';
    next.currentAction = {
      id: 'action.candidate-02',
      type: 'candidate.plan',
      title: `自动检查 Candidate 02 · ${candidateName}`,
      reason: `${metric} 的主要瓶颈已定位，候选变更限定在当前 Mission 的受控工作区。`,
      expectedOutput: '2 个文件 · 受控 Patch · Correctness Matrix',
      risk: 'medium',
      approvalRequired: false,
      approvalPolicy: 'client-controlled',
    };
    next.artifacts = [
      ...artifacts,
      { id: 'artifact-candidate', kind: 'Candidate Plan', title: `Candidate 02 · ${candidateName}`, status: 'ready', meta: '2 files · +37 −18 · digest recorded' },
    ];
    if (state.stage === 'diagnosis') state.stage = 'candidate';
    if (!state.auditEvents?.some((event) => event.detail === 'agent run completed')) addAuditEvent(state, 'Candidate Agent 已完成计划', 'agent run completed · Candidate 02 ready for policy check', 'blue', 'Code2');
    if (!state.runtimeEvents?.some((event) => event.type === 'candidate.plan_created' && event.payload?.runId === next.runId)) {
      appendRuntimeEvent(state, 'candidate.plan_created', { runId: next.runId, candidate: 'candidate-02', artifactId: 'artifact-candidate' }, { kind: 'agent', mode: 'reference-fixture' });
    }
  }
  return { state: { ...state, agent: next }, changed: JSON.stringify(agent) !== JSON.stringify(next) };
}

export function resetMissionRunState(state, goal, { referenceFixture = false } = {}) {
  if (state.agent?.runId) {
    state.runHistory = [
      {
        runId: state.agent.runId,
        threadId: state.agent.threadId || null,
        runtimeKind: state.agent.runtimeKind || null,
        goal: state.agent.goal,
        stage: state.stage,
        benchmark: structuredClone(state.benchmark),
        decisionReview: structuredClone(state.decisionReview),
        currentBest: structuredClone(state.currentBest),
        publishedAssets: structuredClone(state.publishedAssets),
        knowledgeMaintenance: structuredClone(state.knowledgeMaintenance),
        completedAt: state.benchmark?.completedAt || state.decisionReview?.resolvedAt || null,
      },
      ...(state.runHistory || []),
    ].slice(0, 20);
  }
  state.stage = 'diagnosis';
  state.patchApplied = false;
  state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
  state.decisionReview = createDecisionReviewState('idle');
  const mission = state.missions?.find((item) => item.id === state.activeMissionId);
  state.workflowRecovery = createWorkflowRecoveryState(state.activeMissionId, mission?.repository, mission?.projectRoot);
  state.currentBest = referenceFixture ? createCurrentBestState('candidate-01') : structuredClone(state.currentBest?.candidateId ? state.currentBest : { candidateId: null, version: null, value: '--', improvement: '--', status: 'empty' });
  state.knowledgeDrafts = referenceFixture ? structuredClone(knowledgeDrafts) : [];
  state.candidateEvaluations = referenceFixture ? structuredClone(candidateEvaluations) : [];
  state.failureRecords = referenceFixture ? structuredClone(state.failureRecords?.length ? state.failureRecords : failureRecords) : [];
  state.publishedAssets = referenceFixture ? [] : structuredClone(state.publishedAssets || []);
  state.knowledgeMaintenance = createKnowledgeMaintenanceState('idle');
  state.knowledgeReferences = [];
  state.agent = { ...(state.agent || {}), missionId: state.activeMissionId, goal: goal.trim() };
  return state;
}

export function startAgentRun(state, goal, { reset = true } = {}) {
  if (reset) resetMissionRunState(state, goal, { referenceFixture: true });
  const runId = `agent_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
  state.agent = {
    status: 'running',
    phase: '上下文读取',
    progress: 0,
    missionId: state.agent?.missionId || 'MIS_01JH7R',
    runId,
    profileId: 'profile.operator-orchestrator',
    goal: goal.trim(),
    startedAt: new Date().toISOString(),
    durationMs: 7200,
    currentAction: null,
    toolCalls: [],
    messages: [{ id: `agent-start-${runId}`, phase: 'Mission', status: 'running', title: 'Orchestrator 已接管 Mission', detail: `Run ${runId} 已启动，正在建立 Context Snapshot。`, time: '刚刚' }],
    artifacts: [
      { id: 'artifact-context', kind: 'Context Snapshot', title: '正在读取仓库上下文', status: 'running', meta: 'repository · constraints · baseline' },
      { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: '等待知识检索', status: 'queued', meta: 'C500 · paged_attention · validated' },
    ],
  };
  addAuditEvent(state, 'Orchestrator 已启动 Agent Run', `${runId} · ${goal.trim()}`, 'blue', 'Activity');
  return state;
}

export function buildBenchmarkLogsForMatrix(progress, matrix = {}) {
  const environments = Array.isArray(matrix?.environments) && matrix.environments.length ? matrix.environments : ['C500', 'CUDA'];
  const primary = environments[0];
  const secondary = environments[1] || environments[0];
  const entries = [
    [0, `\u8c03\u5ea6\u5668\u5df2\u9501\u5b9a ${environments.length} \u4e2a\u73af\u5883\u5feb\u7167`],
    [20, `${primary} Correctness 12 / 12 \u901a\u8fc7`],
    [40, `${secondary} Correctness 12 / 12 \u901a\u8fc7`],
    [60, `${primary} Full Benchmark \u5b8c\u6210`],
    [80, `${secondary} Full Benchmark \u5b8c\u6210`],
    [100, '\u8bc1\u636e\u5305\u5df2\u751f\u6210\uff1aLevel 3'],
  ];
  return entries.filter(([threshold]) => progress >= threshold).map(([threshold, message], index) => ({ sequence: index + 1, progress: threshold, message }));
}

export function buildBenchmarkLogs(progress) {
  const entries = [
    [0, '调度器已锁定 2 个环境快照'],
    [20, 'C500 Correctness 12 / 12 通过'],
    [40, 'CUDA Correctness 12 / 12 通过'],
    [60, 'C500 Full Benchmark 完成：41.8μs'],
    [80, 'CUDA Full Benchmark 完成：36.1μs'],
    [100, '证据包已生成：Level 3'],
  ];
  return entries.filter(([threshold]) => progress >= threshold).map(([threshold, message], index) => ({ sequence: index + 1, progress: threshold, message }));
}

export const workspaceFiles = [
  { id: 'paged_attention.cu', path: 'kernels/paged_attention.cu', status: 'M', lines: [['context', '188', 'auto plan = build_attention_plan(args);'], ['remove', '189', 'auto workspace = allocate_workspace(plan.size());'], ['remove', '190', 'mirror_to_host(plan, host_plan);'], ['add', '189', 'auto& plan = plan_cache.get_or_build(args.signature());'], ['add', '190', 'if (LIKELY(plan.host_mirror_ready())) {'], ['add', '191', '  launch_paged_kernel(plan.device_view(), kv_cache);'], ['add', '192', '} else {'], ['add', '193', '  plan_cache.enqueue_host_mirror(plan);'], ['add', '194', '}'], ['context', '195', 'return plan;']], rationale: '缓存 descriptor 避免热路径重复分配；同步回退只保留在 host mirror 尚未就绪的边界场景。' },
  { id: 'plan_cache.hpp', path: 'kernels/plan_cache.hpp', status: 'A', lines: [['context', '1', '#pragma once'], ['add', '2', 'class PlanCache {'], ['add', '3', ' public:'], ['add', '4', '  Plan& get_or_build(Signature signature);'], ['add', '5', '  void enqueue_host_mirror(const Plan& plan);'], ['add', '6', '};']], rationale: '新增轻量 descriptor cache，将 plan 生命周期与请求 signature 绑定，避免重复构建。' },
  { id: 'paged_attention_cases.yaml', path: 'tests/paged_attention_cases.yaml', status: 'T', lines: [['context', '1', 'suite: paged_attention'], ['context', '2', 'platforms: [C500, CUDA]'], ['add', '3', 'correctness_cases: 24'], ['add', '4', 'shape: [1, 4, 128, 1024]'], ['add', '5', 'assert: max_abs_error <= 1e-3']], rationale: 'Correctness Gate 固定 24 个边界与回归用例，先通过正确性再进入性能阶段。' },
  { id: 'mla_paged_attention.yaml', path: 'benchmarks/mla_paged_attention.yaml', status: 'B', lines: [['context', '1', 'benchmark: mla_paged_attention'], ['context', '2', 'warmup: 50'], ['add', '3', 'repeats: 200'], ['add', '4', 'metric: latency_p50'], ['add', '5', 'environment_snapshot: fixed']], rationale: 'Benchmark 固定预热、重复次数与 Environment Snapshot，保证跨硬件结果可比。' },
];

export async function applyCandidatePatch(missionId) {
  await ensureStorage();
  const activeWorkspace = await ensureMissionWorkspace(missionId);
  await mkdir(path.join(activeWorkspace, 'kernels'), { recursive: true });
  const patchedSource = `#include "paged_attention.hpp"\n#include "plan_cache.hpp"\n\nPlan run_paged_attention(const AttentionArgs& args, const KvCache& kv_cache) {\n  auto& plan = plan_cache.get_or_build(args.signature());\n  if (LIKELY(plan.host_mirror_ready())) {\n    launch_paged_kernel(plan.device_view(), kv_cache);\n  } else {\n    plan_cache.enqueue_host_mirror(plan);\n  }\n  return plan;\n}\n`;
  const cacheHeader = `#pragma once\n\nclass PlanCache {\n public:\n  Plan& get_or_build(Signature signature);\n  void enqueue_host_mirror(const Plan& plan);\n};\n`;
  await writeFile(path.join(activeWorkspace, 'kernels', 'paged_attention.cu'), patchedSource, 'utf8');
  await writeFile(path.join(activeWorkspace, 'kernels', 'plan_cache.hpp'), cacheHeader, 'utf8');
  return { workspace: path.relative(rootDir, activeWorkspace).replaceAll('\\', '/'), files: workspaceFiles };
}

export async function createWorkspaceCheckpoint(missionId, stage = 'candidate', candidateId = null) {
  await ensureStorage();
  const activeWorkspace = await ensureMissionWorkspace(missionId);
  const safeMissionId = String(missionId || 'mission').replace(/[^a-zA-Z0-9._-]/g, '_');
  const checkpointId = `cp_${randomUUID().slice(0, 12).toUpperCase()}`;
  const checkpointPath = path.join(workspaceCheckpointRoot, safeMissionId, checkpointId);
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  try {
    await copyWorkspaceSnapshot(activeWorkspace, checkpointPath);
  } catch (error) {
    await rm(checkpointPath, { recursive: true, force: true });
    throw error;
  }
  return {
    id: checkpointId,
    missionId,
    stage,
    candidateId,
    path: checkpointPath,
    createdAt: new Date().toISOString(),
    label: candidateId ? `${candidateId} 应用前` : `${stage} 工作区基线`,
  };
}

async function replaceWorkspaceFrom(source, target) {
  const stagePath = `${target}.stage-${randomUUID()}`;
  const backupPath = `${target}.backup-${randomUUID()}`;
  await copyWorkspaceSnapshot(source, stagePath);
  await mkdir(backupPath, { recursive: true });
  const movedToBackup = [];
  const movedFromStage = [];
  try {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(target)) {
      if (name.toLowerCase() === '.git') continue;
      await rename(path.join(target, name), path.join(backupPath, name));
      movedToBackup.push(name);
    }
    for (const name of await readdir(stagePath)) {
      await rename(path.join(stagePath, name), path.join(target, name));
      movedFromStage.push(name);
    }
  } catch (error) {
    for (const name of movedFromStage.reverse()) {
      try { await rename(path.join(target, name), path.join(stagePath, name)); } catch { /* retain remaining content for recovery */ }
    }
    for (const name of movedToBackup.reverse()) {
      try { await rename(path.join(backupPath, name), path.join(target, name)); } catch { /* preserve backup for recovery */ }
    }
    throw error;
  } finally {
    await rm(stagePath, { recursive: true, force: true });
  }
  await rm(backupPath, { recursive: true, force: true });
}

export async function resetMissionWorkspace(missionId) {
  const target = await ensureMissionWorkspace(missionId);
  await replaceWorkspaceFrom(workspaceTemplate, target);
  const checkpointPath = path.join(workspaceCheckpointRoot, safeMissionId(missionId));
  await rm(checkpointPath, { recursive: true, force: true });
  return { workspace: path.relative(rootDir, target).replaceAll('\\', '/'), resetAt: new Date().toISOString() };
}

export async function rebuildMissionWorkspaceFromRepository(mission) {
  const projectRoot = mission.projectRoot || '';
  const target = workspaceDirForMission(mission.id, mission.repository, projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  await recoverWorkspaceSwap(target);
  await replaceWorkspaceFrom(mission.repository, target);
  await workspaceManager.git(['config', 'user.name', 'Operator Studio'], target);
  await workspaceManager.git(['config', 'user.email', 'operator-studio@local.invalid'], target);
  await workspaceManager.git(['add', '-A'], target);
  await workspaceManager.git(['commit', '--allow-empty', '-m', 'Operator Studio mission baseline refreshed'], target);
  await workspaceManager.inspect(target, { refresh: true });
  const checkpointPath = path.join(workspaceCheckpointRoot, safeMissionId(mission.id));
  await rm(checkpointPath, { recursive: true, force: true });
  return { workspace: path.relative(rootDir, target).replaceAll('\\', '/'), rebuiltAt: new Date().toISOString() };
}

export async function restoreWorkspaceCheckpoint(checkpoint, missionId = checkpoint?.missionId) {
  if (!checkpoint?.path) {
    const error = new Error('当前 Mission 没有可恢复的工作区检查点。');
    error.status = 409;
    error.code = 'WORKSPACE_CHECKPOINT_MISSING';
    throw error;
  }
  const checkpointPath = path.resolve(checkpoint.path);
  const allowedRoot = path.resolve(workspaceCheckpointRoot);
  if (checkpointPath !== allowedRoot && !checkpointPath.startsWith(`${allowedRoot}${path.sep}`)) {
    const error = new Error('工作区检查点路径不受信任，恢复操作已拒绝。');
    error.status = 409;
    error.code = 'WORKSPACE_CHECKPOINT_INVALID';
    throw error;
  }
  if (!(await exists(checkpointPath))) {
    const error = new Error('工作区检查点文件不存在，无法恢复。');
    error.status = 409;
    error.code = 'WORKSPACE_CHECKPOINT_MISSING';
    throw error;
  }
  if (checkpoint.missionId && missionId && checkpoint.missionId !== missionId) {
    const error = new Error('工作区检查点不属于当前 Mission，恢复操作已拒绝。');
    error.status = 409;
    error.code = 'WORKSPACE_CHECKPOINT_MISSION_MISMATCH';
    throw error;
  }
  const target = await ensureMissionWorkspace(missionId || checkpoint.missionId);
  await replaceWorkspaceFrom(checkpointPath, target);
  return { checkpointId: checkpoint.id, workspace: path.relative(rootDir, target).replaceAll('\\', '/'), restoredAt: new Date().toISOString() };
}
