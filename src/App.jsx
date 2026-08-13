import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Archive,
  Beaker,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Filter,
  GitPullRequestArrow,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  Grid2X2,
  History,
  Layers3,
  Lightbulb,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Pause,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  TestTube2,
  TriangleAlert,
  Trash2,
  Users,
  X,
} from 'lucide-react';

const stageOrder = {
  diagnosis: 0,
  candidate: 1,
  validation: 2,
  evidence: 3,
  curation: 4,
  published: 5,
};

const defaultKnowledgeDrafts = [
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
    evidence: '2 个 Level 3 Run', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_01JH7R', 'run_01JH8T', 'run_01JH91', 'candidate-02', 'commit 8f3a7c2'],
    sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'Experience Curator', status: 'validated',
  },
  {
    id: 'exp.c500-plan-cache-boundary', code: 'EXP-02', category: '沐曦 C500 专项准则', title: '沐曦 C500 plan cache 与 host mirror 边界准则',
    conclusion: '在 MXMACA 1.4+ 环境中，descriptor cache 应按 Shape signature 分桶，host mirror 仅在缓存未就绪时回退同步路径。',
    scope: 'MetaX C500 · MXMACA 1.4+ · paged_attention · small batch', hardware: ['C500'], operator: 'mla_paged_attention', dtype: 'FP16', layout: 'paged KV · contiguous descriptor', shape: 'batch 1–8 · seq_len 128–1024', runtime: 'MXMACA 1.4.0 · C500 driver 2.7.3',
    trigger: 'C500 时间线中 host plan 与 mirror 准备占比超过 25%，同一 shape signature 在请求间重复出现。',
    procedure: '使用 shape、dtype、layout、head_dim 组成 cache key\n限制每个算子最多保留 64 个 descriptor\n使用 stream event 标记 mirror ready，禁止热路径 host wait\nMXMACA、driver 或编译参数变化时清空缓存',
    expectedGain: 'C500 P50 53.8μs → 41.8μs；固定开销减少 14.6μs', validation: 'C500 Production 01 · warmup 50 · repeat 200 · 12/12 correctness · P50/P95',
    constraints: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。', contraindications: '动态 descriptor 内容无法由 signature 完整表达；超大 shape corpus 导致命中率低于 60%。', failedAttempts: '无界 LRU 在长尾流量中增加 18MB 峰值占用；固定单例 plan 在 head_dim 变化时产生错误结果。',
    evidence: 'C500 41.8μs · Level 3', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_01JH7R', 'env.c500-prod-01@8f3a', 'run_01JH8T', 'candidate-02'], sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'C500 Kernel Group', status: 'validated',
  },
  {
    id: 'exp.cross-platform-adoption-gate', code: 'EXP-03', category: '跨平台验证准则', title: 'C500 / CUDA 跨平台候选采用门禁',
    conclusion: '跨平台候选只有在 Correctness、目标平台性能和固定环境证据同时通过后，才能替换 current best。',
    scope: 'C500 / CUDA · operator candidate adoption · Full Benchmark', hardware: ['C500', 'CUDA'], operator: 'all optimized operators', dtype: 'FP16 / BF16', layout: 'all registered layouts', shape: '完整基准矩阵与边界 shape', runtime: '固定 Environment Snapshot',
    trigger: '候选将替换 current best，或修改跨硬件共享的 runtime、layout、精度和同步路径。', procedure: '为每个平台固定 Environment Snapshot\n先运行边界与历史回归 Correctness Matrix\n再运行预热充分的 Full Benchmark\n按平台分别比较 current best，任何关键平台回归均阻止采用',
    expectedGain: '目标平台达到 Mission 门槛，非目标平台回归不超过 2%', validation: '24 / 24 Correctness · C500/CUDA Full Benchmark · Environment Diff 为空 · Level 3', constraints: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。', contraindications: '缺少目标平台 Worker；环境快照不一致；仅有 Probe 或单次 Run；正确性用例未覆盖边界 shape。', failedAttempts: 'Candidate 03 在 C500 回退 3.3%、CUDA 回退 10.2%，即使正确性通过也不得采用。',
    evidence: '24 / 24 · 2 个固定环境', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_01JH7R', 'decision.candidate-02', 'run_01JH8T', 'run_01JH91'], sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02 / 03', sourceCommit: '8f3a7c2', owner: 'Performance Review Board', status: 'validated',
  },
];

const defaultKnowledgeOptionLibrary = {
  schemaVersion: 'v3.0',
  updated: '2026-08-05',
  categories: {
    hardware: { label: '硬件平台', owner: 'Platform Admin', options: [
      { value: 'C500', label: '沐曦 MetaX C500', code: 'hw.metax.c500' },
      { value: 'CUDA', label: 'NVIDIA CUDA GPU', code: 'hw.nvidia.cuda' },
      { value: 'ROCm MI300', label: 'AMD ROCm MI300', code: 'hw.amd.mi300' },
    ] },
    operators: { label: '算子注册表', owner: 'Kernel Registry', options: [
      { value: 'mla_paged_attention', label: 'MLA Paged Attention', code: 'op.attention.mla_paged' },
      { value: 'paged_decode', label: 'Paged Decode', code: 'op.attention.paged_decode' },
      { value: 'ragged_prefill', label: 'Ragged Prefill', code: 'op.attention.ragged_prefill' },
      { value: 'gemm', label: 'GEMM', code: 'op.linear.gemm' },
      { value: 'reduction', label: 'Reduction', code: 'op.math.reduction' },
      { value: 'all optimized operators', label: '全部已注册优化算子', code: 'op.scope.all' },
    ] },
    dtypes: { label: '数据类型', owner: 'Schema Committee', options: [
      { value: 'FP32', label: 'FP32', code: 'dtype.fp32' }, { value: 'FP16', label: 'FP16', code: 'dtype.fp16' },
      { value: 'BF16', label: 'BF16', code: 'dtype.bf16' }, { value: 'FP8', label: 'FP8', code: 'dtype.fp8' },
      { value: 'INT8', label: 'INT8', code: 'dtype.int8' },
    ] },
    layouts: { label: '数据布局', owner: 'Kernel Registry', options: [
      { value: 'paged KV · head_dim 128', label: 'Paged KV / Head Dim 128', code: 'layout.paged_kv.hd128' },
      { value: 'paged KV · contiguous descriptor', label: 'Paged KV / Contiguous Descriptor', code: 'layout.paged_kv.contiguous' },
      { value: 'all registered layouts', label: '全部已注册布局', code: 'layout.scope.all' },
      { value: 'row-major tiled', label: 'Row-major / Tiled', code: 'layout.row.tiled' },
      { value: 'column-major tiled', label: 'Column-major / Tiled', code: 'layout.column.tiled' },
    ] },
    shapes: { label: 'Shape 桶', owner: 'Benchmark Guild', options: [
      { value: 'batch 1–8 · seq_len ≤ 1024', label: 'Small Batch / Short Sequence', code: 'shape.attn.small_short' },
      { value: 'batch 1–8 · seq_len 128–1024', label: 'Small Batch / Bounded Sequence', code: 'shape.attn.small_bounded' },
      { value: '完整基准矩阵与边界 shape', label: '完整矩阵 / 边界 Shape', code: 'shape.matrix.full_boundary' },
      { value: 'M/N/K 热区与长尾桶', label: 'GEMM M/N/K 热区与长尾', code: 'shape.gemm.distribution' },
    ] },
    runtimes: { label: 'Runtime 配置', owner: 'Environment Admin', options: [
      { value: 'MXMACA 1.4+ / CUDA 12.4', label: 'MXMACA 1.4+ / CUDA 12.4', code: 'runtime.cross.maca14_cuda124' },
      { value: 'MXMACA 1.4.0 · C500 driver 2.7.3', label: 'MXMACA 1.4.0 / C500 Driver 2.7.3', code: 'runtime.metax.prod_273' },
      { value: '固定 Environment Snapshot', label: '跟随固定环境快照', code: 'runtime.snapshot.fixed' },
      { value: 'CUDA 12.4 · Driver 550.54', label: 'CUDA 12.4 / Driver 550.54', code: 'runtime.cuda.124_550' },
      { value: 'ROCm 6.2 · MI300', label: 'ROCm 6.2 / MI300', code: 'runtime.rocm.62_mi300' },
    ] },
    triggers: { label: '问题特征', owner: 'Performance Core Team', options: [
      { value: 'Profile 显示 device kernel < 50μs，且 plan 构建、workspace 与 host mirror 合计占端到端延迟 30% 以上。', label: '固定开销占比 ≥30%，Kernel <50μs', code: 'signal.fixed_overhead.30' },
      { value: 'C500 时间线中 host plan 与 mirror 准备占比超过 25%，同一 shape signature 在请求间重复出现。', label: 'C500 Plan/Mirror 占比 ≥25%，Shape 重复', code: 'signal.c500.plan_mirror.25' },
      { value: '候选将替换 current best，或修改跨硬件共享的 runtime、layout、精度和同步路径。', label: '候选影响跨平台共享路径', code: 'signal.adoption.cross_platform' },
      { value: 'Profile 显示访存吞吐不足，cache miss 或非合并访问成为主要限制。', label: '访存吞吐 / Cache Miss', code: 'signal.memory.cache_miss' },
    ] },
    gains: { label: '收益口径', owner: 'Benchmark Guild', options: [
      { value: '端到端 P50 下降 8%–15%；本 Mission 实测下降 22.3%', label: 'P50 下降 8%–15% / 实测 22.3%', code: 'gain.latency_p50.8_15' },
      { value: 'C500 P50 53.8μs → 41.8μs；固定开销减少 14.6μs', label: 'C500 53.8μs → 41.8μs', code: 'gain.c500.53_41' },
      { value: '目标平台达到 Mission 门槛，非目标平台回归不超过 2%', label: '目标达标 / 非目标平台回归 ≤2%', code: 'gain.policy.cross_platform' },
      { value: 'P50 下降 3%–8%', label: 'P50 下降 3%–8%', code: 'gain.latency_p50.3_8' },
    ] },
    procedures: { label: '执行动作', owner: 'Experience Curator', options: [
      { value: '按 operator、dtype、layout 与 shape bucket 生成稳定 signature', label: '生成稳定 Shape Signature', code: 'step.cache.signature' },
      { value: '缓存 plan descriptor，并为缓存设置容量上限', label: '缓存 Plan Descriptor', code: 'step.cache.plan_descriptor' },
      { value: 'host mirror 仅在缓存未就绪时走异步回退', label: '异步 Host Mirror 回退', code: 'step.runtime.async_mirror' },
      { value: '环境指纹变化时强制失效并重建缓存', label: '环境变化时失效缓存', code: 'step.cache.invalidate_env' },
      { value: '使用 shape、dtype、layout、head_dim 组成 cache key', label: '构造完整 Cache Key', code: 'step.cache.full_key' },
      { value: '限制每个算子最多保留 64 个 descriptor', label: '限制 Descriptor 容量', code: 'step.cache.capacity_64' },
      { value: '使用 stream event 标记 mirror ready，禁止热路径 host wait', label: '使用 Event 标记 Mirror Ready', code: 'step.stream.mirror_ready' },
      { value: 'MXMACA、driver 或编译参数变化时清空缓存', label: '编译栈变化时清空缓存', code: 'step.cache.invalidate_stack' },
      { value: '为每个平台固定 Environment Snapshot', label: '固定平台环境快照', code: 'step.evidence.fix_environment' },
      { value: '先运行边界与历史回归 Correctness Matrix', label: '运行 Correctness Matrix', code: 'step.validation.correctness' },
      { value: '再运行预热充分的 Full Benchmark', label: '运行 Full Benchmark', code: 'step.validation.full_benchmark' },
      { value: '按平台分别比较 current best，任何关键平台回归均阻止采用', label: '执行跨平台采用门禁', code: 'step.policy.cross_platform_gate' },
    ] },
    guardrails: { label: '约束与回退', owner: 'Policy Engine', options: [
      { value: '保留 host mirror fallback；必须通过 24 / 24 Correctness Gate。', label: 'Mirror 回退 + 24/24 正确性', code: 'guardrail.mirror_correctness' },
      { value: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。', label: '容量上限 + 环境失效 + 同步回退', code: 'guardrail.cache_boundary' },
      { value: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。', label: '禁止 Probe 采用 + 固定环境', code: 'guardrail.adoption_evidence' },
    ] },
    contraindications: { label: '禁用条件', owner: 'Policy Engine', options: [
      { value: 'shape 基数高且复用率低；环境指纹频繁变化；Kernel 本身仍占端到端延迟 80% 以上。', label: '低复用 / 环境漂移 / Kernel 占比高', code: 'deny.cache.low_reuse' },
      { value: '动态 descriptor 内容无法由 signature 完整表达；超大 shape corpus 导致命中率低于 60%。', label: 'Signature 不完整 / 命中率低于 60%', code: 'deny.cache.signature_miss' },
      { value: '缺少目标平台 Worker；环境快照不一致；仅有 Probe 或单次 Run；正确性用例未覆盖边界 shape。', label: 'Worker / 快照 / Evidence 不完整', code: 'deny.adoption.incomplete_evidence' },
    ] },
    failures: { label: '失败案例', owner: 'Mission Evidence', options: [
      { value: '仅复用 Workspace 的 Candidate 01 收益 7.8%，未达到 45μs 目标；融合 mirror preparation 的 Candidate 03 出现跨平台回归。', label: 'Candidate 01 / 03：收益不足与跨平台回归', code: 'failure.mis01.c01_c03' },
      { value: '无界 LRU 在长尾流量中增加 18MB 峰值占用；固定单例 plan 在 head_dim 变化时产生错误结果。', label: '无界 LRU / 固定单例 Plan', code: 'failure.mis01.lru_singleton' },
      { value: 'Candidate 03 在 C500 回退 3.3%、CUDA 回退 10.2%，即使正确性通过也不得采用。', label: 'Candidate 03：C500/CUDA 性能回归', code: 'failure.mis01.c03_regression' },
    ] },
    validations: { label: '验证门禁', owner: 'Quality Guild', options: [
      { value: 'C500 + CUDA · 24 / 24 Correctness · 2 个 Full Benchmark · 最大允许回归 2%', label: '双平台 / 24/24 / Full Benchmark / 回归 ≤2%', code: 'gate.cross.l3_24' },
      { value: 'C500 Production 01 · warmup 50 · repeat 200 · 12/12 correctness · P50/P95', label: 'C500 Prod / W50 / R200 / 12/12', code: 'gate.c500.prod_12' },
      { value: '24 / 24 Correctness · C500/CUDA Full Benchmark · Environment Diff 为空 · Level 3', label: '跨平台采用 Level 3 门禁', code: 'gate.adoption.cross_l3' },
    ] },
    evidence: { label: '证据对象', owner: 'Mission Runtime', options: [
      { value: 'MIS_01JH7R', label: 'Mission MIS_01JH7R', code: 'evidence.mission.01JH7R' },
      { value: 'run_01JH8T', label: 'C500 Full Benchmark Run', code: 'evidence.run.01JH8T' },
      { value: 'run_01JH91', label: 'CUDA Full Benchmark Run', code: 'evidence.run.01JH91' },
      { value: 'candidate-02', label: 'Candidate 02 / Adopted', code: 'evidence.candidate.02' },
      { value: 'commit 8f3a7c2', label: 'Git Commit 8f3a7c2', code: 'evidence.commit.8f3a7c2' },
      { value: 'env.c500-prod-01@8f3a', label: 'C500 Environment Snapshot', code: 'evidence.env.c500.8f3a' },
      { value: 'decision.candidate-02', label: 'Candidate 02 Decision Report', code: 'evidence.decision.c02' },
    ] },
    missions: { label: '来源 Mission', owner: 'Mission Runtime', options: [
      { value: 'MIS_01JH7R', label: 'MIS_01JH7R / MLA Paged KV Cache', code: 'mission.01JH7R' },
      { value: 'MIS_01JGA4', label: 'MIS_01JGA4 / Paged Decode', code: 'mission.01JGA4' },
      { value: 'MIS_01JDX9', label: 'MIS_01JDX9 / Ragged Prefill', code: 'mission.01JDX9' },
    ] },
    candidates: { label: '来源 Candidate', owner: 'Mission Runtime', options: [
      { value: 'Candidate 02', label: 'Candidate 02 / Adopted', code: 'candidate.02' },
      { value: 'Candidate 02 / 03', label: 'Candidate 02 / 03 对照', code: 'candidate.02_03' },
      { value: 'Candidate 01', label: 'Candidate 01 / Rejected', code: 'candidate.01' },
      { value: 'Candidate 03', label: 'Candidate 03 / Rejected', code: 'candidate.03' },
    ] },
    commits: { label: '代码版本', owner: 'Repository', options: [
      { value: '8f3a7c2', label: '8f3a7c2 / async plan cache', code: 'commit.8f3a7c2' },
      { value: '91cfe10', label: '91cfe10 / compiler flags', code: 'commit.91cfe10' },
      { value: 'baseline', label: 'Baseline / no patch', code: 'commit.baseline' },
    ] },
    owners: { label: '维护团队', owner: 'Organization Admin', options: [
      { value: 'Experience Curator', label: 'Experience Curator', code: 'team.experience_curator' },
      { value: 'C500 Kernel Group', label: 'C500 Kernel Group', code: 'team.kernel.c500' },
      { value: 'Performance Review Board', label: 'Performance Review Board', code: 'team.review.performance' },
      { value: 'Performance Core Team', label: 'Performance Core Team', code: 'team.performance.core' },
    ] },
  },
};

const defaultKnowledgeMaintenance = {
  status: 'idle',
  trigger: 'decision.adopted',
  triggerLabel: '等待效果决策',
  policy: { id: 'policy.knowledge.level3.same-scope', label: 'Level 3 同范围自动发布', version: 'v2.1', rule: 'evidence.level = 3 AND scope.expanded = false', exception: '适用范围扩大、证据降级或发生冲突时转人工治理' },
  summary: { extracted: 0, matched: 0, created: 0, autoPublished: 0, reviewRequired: 0 },
  steps: [
    { id: 'extract', label: '经验提取', detail: '等待效果决策', status: 'idle' },
    { id: 'deduplicate', label: '查重与合并', detail: '等待经验提取', status: 'idle' },
    { id: 'evidence', label: '证据与边界校验', detail: '等待匹配结果', status: 'idle' },
    { id: 'publish', label: '策略发布', detail: '等待策略判定', status: 'idle' },
  ],
  changes: [],
};

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `服务请求失败（${response.status}）`);
    error.status = response.status;
    error.code = payload.code;
    error.details = payload.details;
    throw error;
  }
  return payload;
}

async function copyText(value) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to a temporary textarea when clipboard permission is unavailable.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const stages = [
  { id: 'diagnosis', number: '01', label: '诊断', caption: '定位瓶颈' },
  { id: 'candidate', number: '02', label: '候选', caption: '审查补丁' },
  { id: 'validation', number: '03', label: '验证', caption: '异构测试' },
  { id: 'evidence', number: '04', label: '证据', caption: '形成结论' },
  { id: 'curation', number: '05', label: '沉淀', caption: '发布经验' },
];

const stageMeta = {
  diagnosis: { badge: 'DIAGNOSIS', status: '分析中', action: '查看候选方案' },
  candidate: { badge: 'CANDIDATE READY', status: '候选已生成', action: '查看候选方案' },
  validation: { badge: 'VALIDATING', status: '验证中', action: '完成 Full Benchmark' },
  evidence: { badge: 'EVIDENCE READY', status: '策略评估', action: '查看效果建议' },
  curation: { badge: 'CURATION', status: '知识维护中', action: '查看知识维护' },
  published: { badge: 'MISSION COMPLETE', status: '已完成', action: '查看已发布经验' },
};

const globalNavItems = [
  { id: 'missions', label: '优化任务', icon: GitBranch },
  { id: 'capabilities', label: 'Agent 能力', icon: Grid2X2 },
  { id: 'knowledge', label: '知识资产', icon: BookOpen },
  { id: 'resources', label: '算力资源', icon: Cpu, modal: 'environments' },
  { id: 'audit', label: '审计中心', icon: ShieldCheck, modal: 'events' },
];

const missionFlow = [
  { id: 'overview', number: '01', label: '任务总览', caption: '目标与瓶颈', view: 'mission', stage: 'diagnosis', icon: Gauge },
  { id: 'iterations', number: '02', label: '候选迭代', caption: '等待候选', view: 'iterations', stage: 'candidate', icon: History },
  { id: 'code', number: '03', label: '代码优化', caption: '补丁审查', view: 'code', stage: 'candidate', icon: Code2 },
  { id: 'experiments', number: '04', label: '异构验证', caption: '等待测试', view: 'experiments', stage: 'validation', icon: TestTube2 },
  { id: 'decision', number: '05', label: '效果决策', caption: '等待证据', view: 'decision', stage: 'evidence', icon: ShieldCheck },
  { id: 'curation', number: '06', label: '知识沉淀', caption: '等待提取', view: 'curation', stage: 'curation', icon: BookOpen },
];

const operatorIterations = [
  { id: 'baseline', label: 'Baseline', version: 'v0', date: '08-03 09:12', status: '基线', tone: 'neutral', title: '原始同步执行路径', hypothesis: '记录未经优化的 plan 构建、workspace 分配、host mirror 与 Kernel 完整开销。', change: '仅建立固定环境基线，不修改代码。', files: '0 files', c500: 53.8, cuda: 44.4, delta: '—', correctness: '24 / 24', evidence: 'Environment Snapshot · Level 3', decision: '作为比较基线', decisionReason: '固定 MXMACA、CUDA、编译器和测试 Shape，后续所有候选均与该版本比较。', knowledge: 'Profile timeline v1.8.0' },
  { id: 'candidate-01', label: 'Candidate 01', version: 'cnd.01', date: '08-03 09:36', status: '已淘汰', tone: 'muted', title: 'Workspace pool reuse', hypothesis: '重复分配 Workspace 可能是小 Batch 延迟的主要来源。', change: '引入按 Shape 分桶的 Workspace pool，并保留同步 plan 构建。', files: '2 files · +24 −11', c500: 49.6, cuda: 41.9, delta: '−7.8%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '收益有限，未采用', decisionReason: '两个平台均有改善，但未达到 45μs 目标；Profile 显示 plan 与 host mirror 仍主导热路径。', knowledge: 'Workspace Allocation Tracker v1.2.0' },
  { id: 'candidate-02', label: 'Candidate 02', version: 'cnd.02', date: '08-03 10:42', status: '当前采用', tone: 'adopted', title: 'Async plan descriptor cache', hypothesis: '缓存 plan descriptor，并将 host mirror 同步移出热路径。', change: '新增 plan cache 与异步 mirror fallback，保持 API 和回退路径不变。', files: '2 files · +37 −18', c500: 41.8, cuda: 36.1, delta: '−22.3%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '已采用为 current best', decisionReason: 'C500 与 CUDA 均通过完整正确性和性能门禁，且 C500 延迟低于 45μs 目标。', knowledge: '3 assets referenced · fixed versions' },
  { id: 'candidate-03', label: 'Candidate 03', version: 'cnd.03', date: '08-03 11:18', status: '已淘汰', tone: 'rejected', title: 'Fuse mirror preparation', hypothesis: '将 mirror preparation 与 Kernel 前处理融合可能继续压缩固定开销。', change: '合并两个 host/device 边界，并调整事件同步粒度。', files: '3 files · +61 −35', c500: 43.2, cuda: 39.8, delta: '−19.7%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '跨平台回归，未采用', decisionReason: '相对 Candidate 02，C500 回退 3.3%，CUDA 回退 10.2%，不满足 current best 更新条件。', knowledge: '异步流水线 Stall 归因规则 v1.4' },
  { id: 'candidate-04', label: 'Candidate 04', version: 'cnd.04', date: '08-03 13:05', status: '验证中', tone: 'running', title: 'Adaptive tile selection', hypothesis: '根据 Batch 与序列长度动态选择 tile，可改善长尾 Shape 的设备利用率。', change: '新增轻量 Shape classifier 和三组预验证 tile 配置。', files: '3 files · +82 −16', c500: 40.9, cuda: null, delta: '−24.0%*', correctness: '20 / 24', evidence: 'Probe Run · Level 1', decision: '等待 Correctness Gate', decisionReason: 'C500 Probe 已获得更低延迟，但 4 个边界 Shape 尚未通过，不能替换 current best。', knowledge: '真实 Shape 分布分析 v2.1.0' },
];

const defaultCandidateEvaluations = operatorIterations.filter((item) => ['candidate-01', 'candidate-02', 'candidate-03'].includes(item.id)).map((item) => ({
  ...item,
  classification: item.id === 'candidate-02' ? 'accepted' : 'reference',
  tone: item.id === 'candidate-02' ? 'adopted' : 'reference',
  status: item.id === 'candidate-02' ? '已自动采用' : '弱候选参考',
  acceptGate: item.id === 'candidate-02'
    ? { passed: true, failedRules: [], passedRules: ['correctness', 'performance.target.c500', 'cross_platform.no_regression', 'runtime.stability', 'evidence.level3'], result: 'accepted' }
    : { passed: false, failedRules: [item.id === 'candidate-01' ? 'performance.target.c500' : 'current_best.no_regression'], passedRules: ['correctness', 'runtime.stability', 'evidence.level3'], result: 'reference' },
}));

const defaultFailureRecords = [{
  ...operatorIterations.find((item) => item.id === 'candidate-04'),
  id: 'failure.run-04', recordType: 'failure', sourceAttempt: 'Attempt 04', label: 'Failure Record 04', version: 'fail.04', status: '已退出候选池', tone: 'failed',
  decision: 'Correctness Gate 失败，禁止形成候选', decisionReason: '4 个边界 Shape 出现数值偏差，硬门禁失败；代码提案和 worktree 已退出候选生命周期。',
  failure: { gate: 'Correctness Gate', code: 'CORRECTNESS_BOUNDARY_MISMATCH', affectedCases: 4, disposition: 'candidate_removed' },
  retainedArtifacts: ['run.probe.c500.04', 'patch.digest.04', 'error.fingerprint.tile-boundary'],
  extractedExperience: { id: 'neg.adaptive-tile-boundary', status: 'extracted', title: 'Adaptive tile 必须先覆盖边界 Shape', rule: '动态 tile 选择器在进入性能比较前，必须覆盖 head_dim、seq_len 与尾块不对齐的边界组合；任何数值偏差直接终止候选化。', reuse: 'Agent 生成 tile classifier 时自动加入边界 Shape Correctness 前置约束。', evidenceLevel: 'Level 1 · negative evidence' },
}];

function Mark({ tone = 'green', pulse = false }) {
  return <span className={`signal-mark ${tone} ${pulse ? 'pulse' : ''}`} />;
}

function RailButton({ icon: Icon, label, active, onClick }) {
  return (
    <button className={`rail-button ${active ? 'active' : ''}`} onClick={onClick} title={label} aria-label={label}>
      <Icon size={19} strokeWidth={1.7} />
      <span>{label}</span>
    </button>
  );
}

function MissionFlowBar({ view, stage, mission, decisionReview, onSelect }) {
  const activeId = view === 'mission' ? 'overview' : view;
  const lifecycleIndex = {
    diagnosis: 0,
    candidate: 2,
    validation: 3,
    evidence: 4,
    curation: 5,
    published: 6,
  }[stage];
  const reviewPending = decisionReview?.status === 'awaiting_review';
  const stageStatus = reviewPending ? '审批意见待处理' : stageMeta[stage].status;
  const candidateCount = mission?.candidateEvaluations?.length || 0;
  const failureCount = mission?.failureRecords?.length || 0;
  const knowledgeCount = (mission?.knowledgeDrafts?.length || 0) + (mission?.publishedAssets?.length || 0);
  const benchmarkResult = mission?.benchmark?.result;
  const correctness = (benchmarkResult?.benchmark || []).reduce((summary, item) => ({
    total: summary.total + (item.correctness?.total || 0),
    passed: summary.passed + (item.correctness?.passed ? (item.correctness?.total || 0) : 0),
  }), { total: 0, passed: 0 });
  const flowCaption = (item) => {
    if (item.id === 'iterations') return candidateCount || failureCount ? `${candidateCount} 个候选 · ${failureCount} 次失败` : '等待候选';
    if (item.id === 'code') return mission?.patchApplied ? '补丁已应用' : '等待补丁';
    if (item.id === 'experiments') {
      if (mission?.benchmark?.status === 'running') return `运行中 ${mission.benchmark.progress || 0}%`;
      if (correctness.total) return `${correctness.passed} / ${correctness.total}`;
      return '等待测试';
    }
    if (item.id === 'decision') return benchmarkResult?.evidenceLevel || (benchmarkResult ? '证据已生成' : '等待证据');
    if (item.id === 'curation') return knowledgeCount ? `${knowledgeCount} 条资产` : '等待提取';
    return item.caption;
  };

  return (
    <section className="mission-context-bar" aria-label="当前优化任务">
      <div className="mission-context-summary">
        <div className="mission-context-title">
          <span className="live-mission-mark"><CircleDot size={13} /> LIVE MISSION</span>
          <strong>{mission?.title || '未选择任务'}</strong>
          <small>{mission?.id || '—'}</small>
        </div>
        <div className="mission-context-facts">
          <span><i className="fact-platform">HW</i>{mission?.hardware?.join(' + ') || '未配置'}</span>
          <span><small>当前最佳</small><strong>{mission?.result?.value || '—'}</strong></span>
          <span className="mission-gain"><small>累计提升</small><strong>{mission?.result?.improvement || '—'}</strong></span>
          <span className={`mission-stage-state ${stage} ${reviewPending ? 'review-pending' : ''}`}><Mark tone={reviewPending ? 'ochre' : 'green'} pulse={reviewPending || stage !== 'published'} />{stageStatus}</span>
        </div>
      </div>
      <nav className="mission-flow" aria-label="任务阶段">
        {missionFlow.map((item, index) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          const complete = index < lifecycleIndex;
          const current = index === lifecycleIndex;
          const blocked = item.id === 'decision' && reviewPending;
          const policyReady = item.id === 'decision' && decisionReview?.status === 'auto_ready';
          const caption = blocked ? '已阻塞 · 待处理' : policyReady ? '策略建议 · 可采用' : flowCaption(item);
          return (
            <button key={item.id} className={`${active ? 'active' : ''} ${complete ? 'complete' : ''} ${current ? 'current' : ''} ${blocked ? 'blocked' : ''} ${policyReady ? 'policy-ready' : ''}`} onClick={() => onSelect(item)} aria-current={active ? 'step' : undefined}>
              <span className="mission-flow-index">{blocked ? <TriangleAlert size={13} /> : complete ? <Check size={13} /> : item.number}</span>
              <span className="mission-flow-icon"><Icon size={16} /></span>
              <span className="mission-flow-copy"><strong>{item.label}</strong><small>{caption}</small></span>
              {current && <i className="current-stage-pin" />}
            </button>
          );
        })}
      </nav>
    </section>
  );
}

function AppShell({ view, stage, decisionReview, missionContext, activeMission, activeProject, unreadCount, mobileNavOpen, missionPaused, backendStatus, backendError, runtimeInfo, onToggleMobileNav, onGlobalNavigate, onMissionStep, onOpenModal, children }) {
  const currentStep = missionFlow.find((item) => item.id === (view === 'mission' ? 'overview' : view));
  const areaLabel = view === 'knowledge' ? '知识资产' : view === 'capabilities' ? 'Agent 能力' : '优化任务';
  const workflowRequestsIntervention = decisionReview?.status === 'awaiting_review' || decisionReview?.requiresApproval === true || decisionReview?.signals?.some((signal) => signal.triggered);
  const selectGlobal = (item) => {
    if (item.modal) onOpenModal(item.modal);
    else onGlobalNavigate(item.id);
    onToggleMobileNav(false);
  };
  return (
    <div className="studio-shell">
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="关闭导航" onClick={() => onToggleMobileNav(false)} />}
      <aside className={`rail ${mobileNavOpen ? 'open' : ''}`}>
        <div className="oa-brand">
          <div className="studio-mark">OS</div>
          <div><strong>Operator Studio</strong><span>异构算子优化平台</span></div>
        </div>
        <button className="workspace-switch" aria-label="查看当前项目" onClick={() => onOpenModal('repository')}>
          <span><FolderGit2 size={16} /></span><div><strong>{activeProject?.name || activeMission?.repository || '未绑定仓库'}</strong><small>{activeProject?.repository || '当前项目 / Git 仓库'}</small></div><ChevronDown size={14} />
        </button>
        <div className="nav-group-title">产品域</div>
        <nav aria-label="全局导航">
          {globalNavItems.map((item) => (
            <RailButton key={item.id} {...item} active={(item.id === 'missions' && (missionContext || view === 'missions')) || (item.id === 'knowledge' && view === 'knowledge') || (item.id === 'capabilities' && view === 'capabilities')} onClick={() => selectGlobal(item)} />
          ))}
        </nav>
        <div className="nav-group-title project-title">项目管理</div>
        <div className="project-nav">
          <button onClick={() => onOpenModal('repository')}><FolderGit2 size={17} /> 仓库与工作副本</button>
          <button onClick={() => onOpenModal('settings')}><Settings2 size={17} /> 项目策略</button>
        </div>
        <div className="rail-bottom">
          <button className="user-card" onClick={() => onOpenModal('user')}><span className="profile-button">YL</span><div><strong>Yilin Lu</strong><small>算子工程师</small></div><MoreHorizontal size={16} /></button>
        </div>
      </aside>

      <div className="studio-main">
        <header className="app-header">
          <div className="header-context">
            <button className="mobile-menu" aria-label="打开导航" onClick={() => onToggleMobileNav(true)}><Menu size={18} /></button>
            <span>{areaLabel}</span><ChevronRight size={13} /><span>{missionContext ? (activeMission?.title || '未选择任务') : view === 'missions' ? 'Mission 中心' : view === 'capabilities' ? '能力注册表' : '组织知识库'}</span>{missionContext && <><ChevronRight size={13} /><strong>{currentStep?.label}</strong></>}
          </div>
          <div className="header-actions">
            <button className="header-search" aria-label="搜索" onClick={() => onOpenModal('search')}><Search size={16} /><span>搜索任务、资产或成员</span><kbd>⌘K</kbd></button>
            <div className={`cloud-state ${backendStatus} ${runtimeInfo?.mode || 'unavailable'}`} title={runtimeInfo?.hint || runtimeInfo?.transport || ''}><Mark tone={backendStatus === 'offline' || ['degraded', 'unavailable'].includes(runtimeInfo?.status) ? 'ochre' : 'green'} pulse={backendStatus === 'connecting'} />{backendStatus === 'online' ? (runtimeInfo?.label || 'Agent 未连接') : backendStatus === 'offline' ? '客户端运行时离线' : '正在连接'}</div>
            {missionContext && <button className={`intervention-trigger ${workflowRequestsIntervention ? 'attention' : ''}`} aria-label={workflowRequestsIntervention ? '流程请求人工介入，存在待处理事项' : '主动发起人工介入'} title={workflowRequestsIntervention ? '流程正在请求人工处理' : '用户主动发起或查看人工介入'} onClick={() => onOpenModal('intervention')}><span className="intervention-icon"><ShieldCheck size={15} /></span><span className="intervention-copy"><small>{workflowRequestsIntervention ? '流程请求' : '主动发起'}</small><strong>{workflowRequestsIntervention ? '待人工处理' : '人工介入'}</strong></span>{workflowRequestsIntervention && <i aria-hidden="true" />}</button>}
            <button className="header-icon" aria-label="通知" onClick={() => onOpenModal('notifications')}><Bell size={17} />{unreadCount > 0 && <i>{unreadCount}</i>}</button>
          </div>
        </header>
        {missionContext && <MissionFlowBar view={view} stage={stage} mission={activeMission} decisionReview={decisionReview} onSelect={onMissionStep} />}
        {backendStatus === 'offline' && <div className="service-offline-banner"><TriangleAlert size={14} /><span>业务服务不可用，修改操作不会提交。{backendError ? ` ${backendError}` : ''}</span></div>}
        {missionPaused && <div className="mission-paused-banner"><Pause size={14} />任务已暂停，浏览与导出仍可使用，新的审批和测试操作已锁定。</div>}
        {children}
      </div>
    </div>
  );
}

function MissionHeader({ stage, onAdvance, onOpenModal, disabled }) {
  const meta = stageMeta[stage];
  return (
    <section className="mission-header">
      <div className="page-title-row">
        <div>
          <div className="mission-overline">优化任务 / MIS_01JH7R</div>
          <div className="title-with-status"><h1>任务指挥台</h1><span className={`oa-status ${stage}`}>{meta.status}</span></div>
          <p>MLA Paged KV Cache · C500 / CUDA A100 · latency p50</p>
        </div>
        <div className="mission-command">
          <button onClick={onAdvance} disabled={disabled}>{meta.action}<ArrowRight size={16} /></button>
          <button className="more-action" aria-label="更多操作" onClick={() => onOpenModal('missionActions')}><MoreHorizontal size={17} /></button>
        </div>
      </div>
    </section>
  );
}

function ShowcaseBoard({ onOpenModal }) {
  return (
    <section className="showcase-board" aria-label="任务成果概览">
      <div className="showcase-board-top">
        <div className="showcase-object">
          <div className="showcase-eyebrow"><CircleDot size={14} /> LIVE MISSION · MLA Paged KV Cache</div>
          <h2>MLA Paged KV Cache<br />算子优化任务</h2>
          <p>任务目标：保持 C500 与 CUDA 结果一致，将小 batch 推理延迟从 53.8μs 压至 45μs 以内。</p>
          <div className="mission-tags"><span>C500</span><span>CUDA A100</span><span>small batch</span></div>
        </div>
        <div className="showcase-outcome">
          <div className="showcase-outcome-head"><span>本次任务结果</span><button onClick={() => onOpenModal('events')}><History size={14} /> 审计记录</button></div>
          <div className="showcase-kpis"><div><span>优化前</span><strong>53.8 <em>μs</em></strong></div><ArrowRight size={18} /><div className="result"><span>当前最佳</span><strong>41.8 <em>μs</em></strong></div><div className="gain"><strong>−22.3%</strong><span>latency p50</span></div></div>
          <div className="showcase-proof"><span><CheckCircle2 size={14} /> 24 / 24 正确性通过</span><span><ShieldCheck size={14} /> Level 3 证据</span><span><BookOpen size={14} /> 3 条知识引用</span></div>
        </div>
      </div>
    </section>
  );
}

function PlatformMark({ platform }) {
  const iconMap = {
    all: Grid2X2,
    cross: GitBranch,
  };
  const Icon = iconMap[platform];
  if (Icon) return <span className={`platform-mark ${platform}`} aria-hidden="true"><Icon size={18} /><small>{platform === 'all' ? 'CORPUS' : 'PORTABLE'}</small></span>;
  const officialLogos = {
    c500: '/logos/metax.svg',
    nvidia: '/logos/nvidia-white.svg',
    amd: '/logos/amd.svg',
  };
  return <span className={`platform-mark official ${platform}`} aria-hidden="true"><img src={officialLogos[platform]} alt="" /></span>;
}

const missionKnowledge = [
  {
    kind: 'Experience',
    version: 'validated',
    title: '短序列下优先量化固定开销',
    shortTitle: '短序列固定开销',
    tone: 'ochre',
    icon: Lightbulb,
    reason: '当设备 Kernel 已低于 50μs 时，plan、workspace、host mirror 与同步成本可能成为主要瓶颈。',
    scope: 'C500 / CUDA · paged_attention · seq_len ≤ 1024',
    evidence: '2 个历史 Run · Level 3',
    source: 'exp.short-seq.fixed-overhead@1.2',
  },
  {
    kind: 'Skill',
    version: 'v2.3.1',
    title: '性能瓶颈分段分析',
    shortTitle: '瓶颈分段分析',
    tone: 'blue',
    icon: Layers3,
    reason: '按 host/device 边界拆分时间线，确保固定开销与 Kernel 执行时间可以被分别归因。',
    scope: '代码只读 · 可创建 Test Task · 受控 Worker',
    evidence: '本次诊断 Action · 已审计',
    source: 'skill.performance-segmentation@2.3.1',
  },
  {
    kind: 'Tool',
    version: 'v1.8.0',
    title: 'Profile timeline',
    shortTitle: 'Profile timeline',
    tone: 'green',
    icon: TerminalSquare,
    reason: '采集 plan 构建、workspace 分配、host mirror 与 Kernel 执行的统一时间线工件。',
    scope: 'C500 Production 01 / CUDA A100 Reference',
    evidence: 'artifact.timeline.01JH7R · digest fixed',
    source: 'tool.profile-timeline@1.8.0',
  },
];

const knowledgeCatalog = [
  { id: 'exp.fixed-overhead', kind: 'Experience', version: 'v1.2', title: '短序列下优先量化固定开销', description: '设备 Kernel 低于 50μs 时，优先分离 plan、workspace、host mirror 与同步开销。', tags: ['C500', 'paged_attention', 'seq_len ≤ 1024', '2 Run citations'], tone: 'ochre', icon: Lightbulb, referenced: true, scope: 'C500 / CUDA · paged_attention · seq_len ≤ 1024', permissions: 'organization:read', evidence: '2 Run citations · Level 3', updated: '2026-08-03' },
  { id: 'exp.c500-compiler-flags', kind: 'Experience', version: 'v1.7', title: '沐曦 C500 MXMACA 编译参数准则', description: '按算子类型约束 fast-math、寄存器上限和内联策略，避免局部收益引发跨 shape 回退。', tags: ['MetaX C500', 'MXMACA', 'compiler flags', '9 Run citations'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · MXMACA 1.4+', permissions: 'organization:read', evidence: '9 Run citations · Level 3', updated: '2026-08-02' },
  { id: 'exp.c500-launch-baseline', kind: 'Experience', version: 'v1.5', title: '沐曦 C500 小 Batch 启动开销基线', description: '建立 Kernel launch、plan 构建与同步开销基线，低于阈值时禁止仅针对 Kernel 做局部优化。', tags: ['MetaX C500', 'small batch', 'launch overhead', 'P50/P95'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · batch 1–8 · seq_len ≤ 2048', permissions: 'organization:read', evidence: '26 baseline Runs · Level 3', updated: '2026-07-30' },
  { id: 'exp.c500-cache-layout', kind: 'Experience', version: 'v2.1', title: '沐曦 C500 片上缓存与数据布局准则', description: '依据访问合并、向量宽度和片上容量选择 KV、GEMM 与归约算子的数据布局。', tags: ['MetaX C500', 'cache', 'vector width', 'layout'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · attention / GEMM / reduction', permissions: 'organization:read', evidence: '12 Mission citations · Level 3', updated: '2026-07-25' },
  { id: 'exp.c500-stream-sync', kind: 'Experience', version: 'v1.3', title: '沐曦 C500 多流同步与 Event 使用边界', description: '明确 stream 间依赖、Event 粒度与 host 等待的适用条件，避免隐式同步进入热路径。', tags: ['MetaX C500', 'stream', 'event', 'async'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · asynchronous execution', permissions: 'organization:read', evidence: '7 concurrency cases · Level 2', updated: '2026-07-21' },
  { id: 'exp.wavefront-occupancy', kind: 'Experience', version: 'v2.0', title: 'ROCm Wavefront 占用率判断基线', description: '结合 VGPR、LDS 与 active waves 判断低占用是否真实限制吞吐。', tags: ['MI300', 'ROCm', 'occupancy', '8 Run citations'], tone: 'ochre', icon: Lightbulb, scope: 'ROCm MI250 / MI300 · GEMM / attention', permissions: 'organization:read', evidence: '8 Run citations · Level 3', updated: '2026-07-29' },
  { id: 'exp.bank-conflict', kind: 'Experience', version: 'v1.6', title: '共享内存 Bank Conflict 定位模式', description: '通过访问步长、数据布局和冲突计数器识别共享内存序列化。', tags: ['CUDA', 'shared memory', 'layout', '5 missions'], tone: 'ochre', icon: Lightbulb, scope: 'CUDA SM80+ · GEMM / reduction', permissions: 'organization:read', evidence: '5 Mission citations · Level 3', updated: '2026-07-24' },
  { id: 'exp.pipeline-stall', kind: 'Experience', version: 'v1.4', title: '异步流水线 Stall 归因规则', description: '区分数据依赖、barrier、访存等待和 pipeline stage 配置导致的停顿。', tags: ['async copy', 'pipeline', 'CUDA', 'C500'], tone: 'ochre', icon: Lightbulb, scope: 'CUDA / C500 · multi-stage pipeline', permissions: 'organization:read', evidence: '6 Run citations · Level 2', updated: '2026-07-18' },
  { id: 'exp.search-pruning', kind: 'Experience', version: 'v2.4', title: 'GEMM 调优搜索空间裁剪策略', description: '依据 shape、数据类型和硬件约束提前排除低收益或不可执行组合。', tags: ['GEMM', 'autotune', 'BF16', '47% less trials'], tone: 'ochre', icon: Lightbulb, scope: 'C500 / CUDA / ROCm · M/N/K distributions', permissions: 'organization:read', evidence: '19 tuning sessions · Level 3', updated: '2026-07-11' },
  { id: 'exp.precision-drift', kind: 'Experience', version: 'v1.1', title: '混合精度误差漂移排查清单', description: '按累加精度、归约顺序、输入分布与边界值逐层定位跨平台误差。', tags: ['FP16', 'BF16', 'correctness', 'cross-platform'], tone: 'ochre', icon: Lightbulb, scope: 'FP16 / BF16 · inference kernels', permissions: 'organization:read', evidence: '11 regression cases · Level 3', updated: '2026-06-30' },
  { id: 'skill.segmentation', kind: 'Skill', version: 'v2.3.1', title: '性能瓶颈分段分析', description: '建立 host/device 边界的可归因时间线，并保存完整环境指纹。', tags: ['repository:read', 'test_task:create', 'timeline'], tone: 'blue', icon: Layers3, referenced: true, scope: 'C500 / CUDA / ROCm · performance diagnosis', permissions: 'repository:read · test_task:create', evidence: '14 Missions · verified workflow', updated: '2026-08-01' },
  { id: 'skill.correctness-matrix', kind: 'Skill', version: 'v1.9.0', title: '跨平台正确性矩阵生成', description: '从算子签名与 shape 分布生成边界、随机和历史回归用例矩阵。', tags: ['correctness', 'case generation', '3 platforms'], tone: 'blue', icon: Layers3, scope: 'C500 / CUDA / ROCm · operator test plans', permissions: 'repository:read · test_task:create', evidence: '624 generated cases · 99.4% pass', updated: '2026-07-28' },
  { id: 'skill.fusion-feasibility', kind: 'Skill', version: 'v1.5.2', title: 'Kernel Fusion 可行性评估', description: '评估访存节省、寄存器压力、调度边界与回退成本，输出融合候选。', tags: ['fusion', 'memory traffic', 'risk assessment'], tone: 'blue', icon: Layers3, scope: 'Elementwise / normalization / attention epilogue', permissions: 'repository:read · candidate:create', evidence: '9 adopted candidates · reviewed', updated: '2026-07-22' },
  { id: 'skill.regression-bisect', kind: 'Skill', version: 'v1.3.0', title: '性能回归边界搜索', description: '在固定环境中二分定位回归提交，并关联 Patch、Run 与环境变化。', tags: ['git bisect', 'regression', 'environment fixed'], tone: 'blue', icon: Layers3, scope: 'Git repositories · benchmark history', permissions: 'repository:read · test_task:create', evidence: '7 regressions localized · audited', updated: '2026-07-15' },
  { id: 'skill.shape-analysis', kind: 'Skill', version: 'v2.1.0', title: '真实 Shape 分布分析', description: '从脱敏请求样本建立 shape 热区与长尾分布，为调优优先级提供依据。', tags: ['shape corpus', 'P50 / P95', 'privacy safe'], tone: 'blue', icon: Layers3, scope: 'Inference request traces · anonymized', permissions: 'dataset:read · report:create', evidence: '4 production datasets · approved', updated: '2026-07-06' },
  { id: 'tool.profile-timeline', kind: 'Tool', version: 'v1.8.0', title: 'Profile timeline', description: '在受控 Worker 内采集包含 plan、host mirror 和 Kernel 的统一时间线。', tags: ['profile.timeline', 'C500 / CUDA', 'artifact'], tone: 'green', icon: TerminalSquare, referenced: true, scope: 'C500 / CUDA · controlled workers', permissions: 'worker:execute · artifact:write', evidence: '326 artifacts · signed digest', updated: '2026-08-02' },
  { id: 'tool.env-diff', kind: 'Tool', version: 'v2.2.0', title: 'Environment Snapshot Diff', description: '比较驱动、Runtime、编译器、固件与关键环境变量，识别不可比 Run。', tags: ['environment', 'reproducibility', 'diff'], tone: 'green', icon: TerminalSquare, scope: 'C500 / CUDA / ROCm worker snapshots', permissions: 'environment:read · report:create', evidence: '91 snapshot comparisons · verified', updated: '2026-07-31' },
  { id: 'tool.noise-analyzer', kind: 'Tool', version: 'v1.7.3', title: 'Benchmark Noise Analyzer', description: '检测预热不足、频率波动、资源争用和异常离群点，并给出重跑建议。', tags: ['benchmark', 'variance', 'outlier'], tone: 'green', icon: TerminalSquare, scope: 'Latency / throughput benchmarks · all workers', permissions: 'run:read · test_task:create', evidence: '1,284 Runs analyzed · calibrated', updated: '2026-07-26' },
  { id: 'tool.isa-hotspot', kind: 'Tool', version: 'v1.4.1', title: 'ISA Hotspot Inspector', description: '关联源码、编译产物与指令热点，定位访存、分支和流水线问题。', tags: ['SASS', 'ISA', 'source mapping'], tone: 'green', icon: TerminalSquare, scope: 'CUDA SASS / C500 ISA · debug builds', permissions: 'artifact:read · repository:read', evidence: '43 hotspot reports · signed', updated: '2026-07-19' },
  { id: 'tool.workspace-tracker', kind: 'Tool', version: 'v1.2.0', title: 'Workspace Allocation Tracker', description: '记录 Workspace 生命周期、复用率和峰值占用，识别热路径重复分配。', tags: ['workspace', 'allocation', 'lifetime'], tone: 'green', icon: TerminalSquare, scope: 'C500 / CUDA runtime allocations', permissions: 'worker:execute · artifact:write', evidence: '18 Missions · verified', updated: '2026-07-08' },
];

const knowledgeHardwareMap = {
  'exp.fixed-overhead': ['c500', 'nvidia'],
  'exp.c500-compiler-flags': ['c500'],
  'exp.c500-launch-baseline': ['c500'],
  'exp.c500-cache-layout': ['c500'],
  'exp.c500-stream-sync': ['c500'],
  'exp.wavefront-occupancy': ['amd'],
  'exp.bank-conflict': ['nvidia'],
  'exp.pipeline-stall': ['c500', 'nvidia'],
  'exp.search-pruning': ['c500', 'nvidia', 'amd'],
  'exp.precision-drift': ['c500', 'nvidia', 'amd'],
  'skill.segmentation': ['c500', 'nvidia', 'amd'],
  'skill.correctness-matrix': ['c500', 'nvidia', 'amd'],
  'skill.fusion-feasibility': ['c500', 'nvidia'],
  'skill.regression-bisect': ['c500', 'nvidia', 'amd'],
  'skill.shape-analysis': ['c500', 'nvidia', 'amd'],
  'tool.profile-timeline': ['c500', 'nvidia'],
  'tool.env-diff': ['c500', 'nvidia', 'amd'],
  'tool.noise-analyzer': ['c500', 'nvidia', 'amd'],
  'tool.isa-hotspot': ['c500', 'nvidia'],
  'tool.workspace-tracker': ['c500', 'nvidia'],
};

const hardwareLabels = {
  c500: '沐曦 MetaX C500',
  nvidia: 'NVIDIA CUDA',
  amd: 'AMD ROCm / MI300',
};

const experienceDetails = {
  'exp.fixed-overhead': {
    operator: 'paged_attention', dtype: 'FP16 / BF16', layout: 'paged KV', shape: 'batch 1–8 · seq_len ≤ 1024', runtime: 'MXMACA 1.4+ / CUDA 12.4',
    trigger: 'device kernel < 50μs，且 host plan、workspace、mirror 或同步开销占比超过 30%。',
    procedure: ['固定环境并采集端到端 Profile timeline', '分离 plan、workspace、host mirror、同步和 Kernel 耗时', '优先消除重复构建、分配和隐式同步', '在完整 Shape Matrix 上与 current best 比较'],
    expectedGain: 'P50 下降 8%–20%', validation: '24 / 24 Correctness · 2 个 Full Benchmark · 回归上限 2%',
    contraindications: 'Kernel 仍占端到端延迟 80% 以上；Profile 未充分预热；环境快照不一致。',
    failedAttempts: '只优化 Kernel 指令但不处理 host 固定开销，端到端收益通常低于 3%。',
    evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_01JH7R', 'run_01JH8T', 'run_01JH91'], sourceMission: 'MIS_01JH7R', sourceCandidate: 'Candidate 02', sourceCommit: '8f3a7c2', owner: 'Performance Core Team',
  },
  'exp.c500-compiler-flags': {
    operator: 'GEMM / attention / reduction', dtype: 'FP16 / BF16', layout: 'operator specific', shape: '按 M/N/K 或序列长度分桶', runtime: 'MXMACA 1.4+',
    trigger: '局部 Shape 收益明显，但完整 Shape Matrix 出现寄存器溢出、精度变化或长尾回归。',
    procedure: ['记录默认编译参数与编译器版本', '分别验证 fast-math、寄存器上限和内联策略', '检查 ISA、spill 与 occupancy', '仅合入通过全量 Shape Matrix 的参数组合'],
    expectedGain: '常见算子 P50 下降 3%–12%', validation: '9 个 Full Benchmark Run · Correctness Matrix · ISA Diff', contraindications: '未固定 MXMACA 版本；只验证单一 Shape；混合精度容差未评审。', failedAttempts: '全局启用 fast-math 曾导致 BF16 边界用例误差超阈值。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_C500_FLAGS_07', 'runset.flags.09', 'artifact.isa.114'], sourceMission: 'MIS_C500_FLAGS_07', sourceCandidate: 'Candidate 06', sourceCommit: '91cfe10', owner: 'C500 Kernel Group',
  },
  'exp.c500-launch-baseline': {
    operator: 'small-batch operators', dtype: 'FP16 / BF16', layout: 'any', shape: 'batch 1–8 · seq_len ≤ 2048', runtime: 'MXMACA 1.4+',
    trigger: '小 Batch 端到端延迟高，但 Kernel duration 已接近平台启动开销下限。', procedure: ['执行空 Kernel 与轻量 Kernel 基线', '分别量化 launch、plan、同步和 Kernel 时间', '建立 P50/P95 平台阈值', '低于阈值后转向 runtime 与调度优化'], expectedGain: '避免无效 Kernel 调优；减少 30%–50% 低收益实验', validation: '26 个基线 Run · 三轮时钟稳定性检查', contraindications: 'GPU 频率未锁定；预热不足；Worker 存在资源争用。', failedAttempts: '在启动开销占主导时继续调整 tile，收益低于噪声区间。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_C500_BASE_03', 'runset.baseline.26'], sourceMission: 'MIS_C500_BASE_03', sourceCandidate: 'Baseline Set 04', sourceCommit: 'n/a', owner: 'Benchmark Guild',
  },
  'exp.c500-cache-layout': {
    operator: 'attention / GEMM / reduction', dtype: 'FP16 / BF16', layout: 'vectorized / tiled', shape: '按工作集与向量宽度分桶', runtime: 'MXMACA 1.4+',
    trigger: 'Profile 显示访存吞吐不足，cache miss、非合并访问或片上容量成为主要限制。', procedure: ['计算单 block 工作集和向量宽度', '检查连续访问与对齐边界', '评估片上缓存占用和并发 block 数', '使用代表性与长尾 Shape 同时验证布局'], expectedGain: '访存受限算子提升 6%–18%', validation: '12 个 Mission 引用 · Cache Counter · Full Benchmark', contraindications: '布局转换成本高于复用收益；边界 Shape 产生非对齐访问。', failedAttempts: '为最大 Shape 固定布局导致小 Shape 片上空间浪费并回退 5.1%。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_C500_LAYOUT_12', 'artifact.cache.221', 'runset.layout.18'], sourceMission: 'MIS_C500_LAYOUT_12', sourceCandidate: 'Candidate 04', sourceCommit: 'cc740de', owner: 'C500 Kernel Group',
  },
  'exp.c500-stream-sync': {
    operator: 'asynchronous operators', dtype: 'any', layout: 'any', shape: 'multi-stream workload', runtime: 'MXMACA 1.4+',
    trigger: '时间线出现 host wait、全局同步或跨 stream 空洞，且依赖关系可由 Event 表达。', procedure: ['绘制 stream 间读写依赖', '将 device-wide sync 收窄为 Event', '按数据生命周期选择 Event 粒度', '验证异常与回退路径不存在竞态'], expectedGain: '热路径同步开销下降 5%–14%', validation: '7 个并发场景 · TSan-like event audit · Level 2', contraindications: '依赖关系不完整；输出被 host 立即消费；异常路径缺少 Event 收敛。', failedAttempts: '过细 Event 粒度增加调度开销，P95 回退 4.6%。', evidenceLevel: 'Level 2', confidence: '中', evidenceRefs: ['MIS_C500_STREAM_05', 'runset.concurrent.07'], sourceMission: 'MIS_C500_STREAM_05', sourceCandidate: 'Candidate 03', sourceCommit: 'f21b9a8', owner: 'Runtime Team',
  },
  'exp.wavefront-occupancy': {
    operator: 'GEMM / attention', dtype: 'FP16 / BF16', layout: 'wavefront tiled', shape: 'MI250 / MI300', runtime: 'ROCm 6.x',
    trigger: 'active waves 偏低且吞吐不足，需要区分 VGPR、LDS 或访存瓶颈。', procedure: ['采集 VGPR、LDS 和 active waves', '计算理论与实际 occupancy', '分别调整 tile、wave 数和 LDS 复用', '用 Roofline 判断 occupancy 是否为真实瓶颈'], expectedGain: '资源受限算子提升 4%–16%', validation: '8 个 Run · MI250/MI300 对照 · Level 3', contraindications: '算子已受带宽限制；仅看 occupancy 百分比而未结合吞吐。', failedAttempts: '压低 VGPR 提高 occupancy 后指令数上升，端到端回退 2.8%。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_ROCM_OCC_08', 'artifact.rocprof.65'], sourceMission: 'MIS_ROCM_OCC_08', sourceCandidate: 'Candidate 05', sourceCommit: '42ed814', owner: 'ROCm Kernel Group',
  },
  'exp.bank-conflict': {
    operator: 'GEMM / reduction', dtype: 'FP16 / FP32', layout: 'shared-memory tiled', shape: 'CUDA SM80+', runtime: 'CUDA 12.x',
    trigger: 'shared memory 吞吐低于预期，bank conflict 计数器与 warp stall 同时升高。', procedure: ['确认访问步长与 bank 映射', '构造最小冲突复现 Shape', '尝试 padding、swizzle 或向量宽度调整', '检查布局转换与寄存器压力副作用'], expectedGain: '共享内存受限路径提升 5%–20%', validation: '5 个 Mission · Nsight Compute · Level 3', contraindications: '主要瓶颈为 global memory 或计算吞吐；padding 导致 LDS 超限。', failedAttempts: '统一增加 padding 在小 tile 上增加寻址指令并回退 1.9%。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_CUDA_BANK_05', 'artifact.ncu.882'], sourceMission: 'MIS_CUDA_BANK_05', sourceCandidate: 'Candidate 08', sourceCommit: 'd63f7e1', owner: 'CUDA Kernel Group',
  },
  'exp.pipeline-stall': {
    operator: 'multi-stage attention / GEMM', dtype: 'FP16 / BF16', layout: 'async tiled', shape: 'pipeline stage 2–5', runtime: 'CUDA 12.x / MXMACA 1.4+',
    trigger: '异步流水线出现周期性空洞，需要区分依赖、barrier、访存等待和 stage 配置。', procedure: ['按 stage 标记 producer/consumer 事件', '对齐 barrier 与数据生命周期', '比较 2–5 stage 的吞吐和资源占用', '保留跨平台的独立 stage 参数'], expectedGain: '流水线受限路径提升 4%–13%', validation: '6 个 Run · 2 个平台 · Level 2', contraindications: '工作集无法覆盖访存延迟；stage 增加导致寄存器或片上缓存溢出。', failedAttempts: '将 stage 从 3 固定增加到 5 后，C500 资源压力导致回退 3.3%。', evidenceLevel: 'Level 2', confidence: '中', evidenceRefs: ['MIS_PIPELINE_06', 'runset.pipeline.06'], sourceMission: 'MIS_PIPELINE_06', sourceCandidate: 'Candidate 03', sourceCommit: 'ae9154c', owner: 'Performance Core Team',
  },
  'exp.search-pruning': {
    operator: 'GEMM', dtype: 'FP16 / BF16 / INT8', layout: 'NN / NT / TN', shape: 'M/N/K distribution buckets', runtime: 'C500 / CUDA / ROCm',
    trigger: 'Autotune 搜索空间过大，重复试验占用 Worker，且大量配置可由硬件约束提前排除。', procedure: ['从真实 Shape corpus 建立热区', '按硬件资源约束排除不可执行配置', '使用历史结果训练启发式排序', '保留探索预算验证长尾与新架构'], expectedGain: '试验数量减少约 47%，最优解保持率 98.6%', validation: '19 个 tuning session · 三平台复现 · Level 3', contraindications: '新硬件无历史样本；Shape 分布漂移；剪枝规则未保留探索预算。', failedAttempts: '只按历史 top-k 剪枝遗漏新架构最优 tile。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_GEMM_TUNE_19', 'dataset.shape.4', 'runset.tune.387'], sourceMission: 'MIS_GEMM_TUNE_19', sourceCandidate: 'Policy v2.4', sourceCommit: '7a510cb', owner: 'AutoTune Team',
  },
  'exp.precision-drift': {
    operator: 'inference kernels', dtype: 'FP16 / BF16', layout: 'cross-platform', shape: '边界值 / 随机 / 历史回归', runtime: 'C500 / CUDA / ROCm',
    trigger: '跨平台结果误差超阈值，或误差随序列长度、归约维度稳定累积。', procedure: ['固定输入样本与 golden implementation', '逐层检查累加精度和归约顺序', '比较输入分布与边界值敏感性', '为不同 dtype 建立独立容差与回归用例'], expectedGain: '定位时间由天级缩短到小时级', validation: '11 个回归案例 · 3 平台 · Level 3', contraindications: '输入样本未固定；Golden 本身精度不足；只比较最终 max error。', failedAttempts: '统一放宽容差掩盖了长序列累加误差。', evidenceLevel: 'Level 3', confidence: '高', evidenceRefs: ['MIS_PRECISION_11', 'dataset.correctness.624'], sourceMission: 'MIS_PRECISION_11', sourceCandidate: 'Checklist v1.1', sourceCommit: '0c98b5d', owner: 'Correctness Guild',
  },
};

const toLines = (value) => Array.isArray(value) ? value : String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);

const normalizeKnowledgeAsset = (asset) => {
  const details = experienceDetails[asset.id] || {};
  const evidenceLevel = asset.evidenceLevel || (asset.evidence?.includes('Level 3') ? 'Level 3' : asset.evidence?.includes('Level 2') ? 'Level 2' : asset.kind === 'Experience' ? 'Level 1' : 'Verified');
  return {
    operator: asset.kind === 'Experience' ? 'operator specific' : asset.kind,
    dtype: '按任务上下文', layout: '受资产版本约束', shape: '按适用范围', runtime: '固定环境版本',
    trigger: asset.description, expectedGain: asset.kind === 'Experience' ? '以关联 Run 为准' : '生成受控任务产物',
    validation: asset.evidence, contraindications: '超出适用范围或环境版本不一致时禁止直接复用。', failedAttempts: '暂无已固化的反例。',
    confidence: evidenceLevel === 'Level 3' ? '高' : '中', sourceMission: '组织知识库', sourceCandidate: '固定版本资产', sourceCommit: 'signed digest', owner: 'Knowledge Steward',
    ...details,
    ...asset,
    evidenceLevel,
    procedure: toLines(asset.procedure || details.procedure),
    evidenceRefs: Array.isArray(asset.evidenceRefs) ? asset.evidenceRefs : (details.evidenceRefs || []),
  };
};

function ReferenceRow({ icon: Icon, type, title, meta, tone, onClick }) {
  return (
    <button className="reference-row" onClick={onClick}>
      <span className={`reference-icon ${tone}`}><Icon size={16} /></span>
      <span><small>{type}</small><strong>{title}</strong></span>
      <em>{meta} <ChevronRight size={13} /></em>
    </button>
  );
}

function MissionView({ stage, setView, onAdvance, onOpenModal, paused }) {
  const active = stageOrder[stage];
  return (
    <main className="page mission-page">
      <MissionHeader stage={stage} onAdvance={onAdvance} onOpenModal={onOpenModal} disabled={paused} />
      <ShowcaseBoard onOpenModal={onOpenModal} />

      <section className="overview-layout">
        <article className="judgement-block reveal one">
          <div className="section-index">01 / 当前判断</div>
          <h2>瓶颈不在 Kernel，<br />而在热路径的固定开销。</h2>
          <p>设备 Kernel 已低于 50μs。重复创建 plan descriptor、workspace 分配与 host mirror 同步，正在主导短序列延迟。</p>
          <div className="judgement-quote">
            <span>Agent recommendation</span>
            <strong>缓存 plan descriptor，并将 host mirror 移出热路径。</strong>
          </div>
          <button className="text-link" onClick={() => onOpenModal('knowledgeEvidence')}>查看知识依据 <ArrowRight size={15} /></button>
        </article>

        <aside className="references-block reveal two">
          <div className="references-heading"><div><span className="section-index">02 / 知识依据</span><strong>3 条已引用</strong></div><button onClick={() => onOpenModal('knowledgeEvidence')}>查看详情 <ArrowRight size={13} /></button></div>
          {missionKnowledge.map((item) => <ReferenceRow key={item.source} icon={item.icon} type={item.kind.toUpperCase()} title={item.shortTitle} meta={item.version} tone={item.tone} onClick={() => onOpenModal('asset', { kind: item.kind, title: item.title, version: item.version })} />)}
          <div className="reference-note"><ShieldCheck size={15} /> 3 条引用均绑定可访问证据与固定版本。</div>
        </aside>
      </section>

      <section className="candidate-section reveal three">
        <div className="section-heading-large">
          <div><span>03 / 当前候选</span><h2>Candidate 02 · Async plan cache</h2></div>
          <button className="secondary-action" onClick={() => setView('code')}>审阅代码变更 <ArrowRight size={15} /></button>
        </div>
        <div className="comparison-table">
          <div className="comparison-head"><span>方案</span><span>热路径组成</span><span>延迟</span><span>状态</span></div>
          <div className="comparison-row muted"><strong>Current best</strong><div className="path-bar baseline"><i>plan</i><i>alloc</i><i>mirror</i><i>kernel</i></div><b>53.8 μs</b><span>基线</span></div>
          <div className="comparison-row proposed"><strong>Candidate 02</strong><div className="path-bar candidate"><i>cache hit</i><i>async mirror</i><i>kernel</i></div><b>41.8 μs</b><span>−22.3%</span></div>
        </div>
      </section>

      <section className="bottom-overview">
        <div className="run-summary">
          <div className="section-index">04 / 验证状态</div>
          <div className="run-line"><span className="platform-sign green">C5</span><div><strong>C500 Production 01</strong><small>Correctness 12/12 · Full Benchmark</small></div><em>{active >= 3 ? '41.8 μs' : active >= 2 ? 'Running' : 'Queued'}</em></div>
          <div className="run-line"><span className="platform-sign blue">CU</span><div><strong>CUDA A100 Reference</strong><small>Correctness 12/12 · Full Benchmark</small></div><em>{active >= 3 ? '36.1 μs' : active >= 2 ? 'Running' : 'Queued'}</em></div>
          <button className="text-link" onClick={() => setView('experiments')}>打开测试矩阵 <ArrowRight size={15} /></button>
        </div>
        <div className="decision-block">
          <TriangleAlert size={19} />
          <div><span>DECISION GATE</span><strong>{stage === 'evidence' ? '证据已满足采用条件' : stageOrder[stage] > 3 ? '候选已通过采用审批' : 'Full Benchmark 完成前不可更新 current best'}</strong><p>Probe 仅用于筛选方向；最终采用必须引用完整 Run 与 Environment Snapshot。</p></div>
        </div>
      </section>
    </main>
  );
}

function MissionHub({ missions = [], projects = [], activeProjectId, activeMissionId, onSelect, onCreate }) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState({ title: '', goal: '', repository: 'mla-kernels', hardware: ['C500'], metric: 'latency p50' });
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const projectMissions = activeProjectId ? missions.filter((mission) => mission.projectId === activeProjectId || mission.repository === activeProject?.repository) : missions;
  const visible = projectMissions.filter((mission) => `${mission.title} ${mission.goal} ${mission.repository}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (activeProject?.repository) setDraft((current) => ({ ...current, repository: activeProject.repository }));
  }, [activeProject?.repository]);
  const statusLabel = { ready: '策略就绪', running: '运行中', awaiting_approval: '人工处理中', completed: '已完成' };
  const submit = async (event) => {
    event.preventDefault();
    if (!draft.goal.trim()) return;
    await onCreate(draft);
    setCreating(false);
    setDraft({ title: '', goal: '', repository: 'mla-kernels', hardware: ['C500'], metric: 'latency p50' });
  };
  return (
    <main className="page mission-hub-page">
      <section className="detail-heading mission-hub-heading">
        <div><span className="detail-overline">MISSION CONTROL</span><h1>优化任务</h1><p>从一个清晰目标开始，让 Agent 持续推进代码、实验、证据和知识。</p></div>
        <button className="primary-action" onClick={() => setCreating((value) => !value)}>{creating ? <><X size={15} /> 取消创建</> : <><GitBranch size={15} /> 新建 Mission</>}</button>
      </section>

      {creating && <form className="mission-create-panel" onSubmit={submit}>
        <div className="mission-create-lead"><span>NEW MISSION</span><strong>定义 Agent 的目标与执行边界</strong><p>创建后先进入就绪状态，由你决定何时启动 Agent Run。</p></div>
        <label className="wide"><span>优化目标</span><textarea aria-label="新 Mission 优化目标" value={draft.goal} onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))} placeholder="例如：降低 Paged Decode 在 C500 长尾 shape 下的 P95 延迟" /></label>
        <label><span>任务名称</span><input aria-label="Mission 名称" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="自动从目标生成" /></label>
        <label><span>代码仓库</span><select aria-label="代码仓库" value={draft.repository} onChange={(event) => setDraft((current) => ({ ...current, repository: event.target.value }))}>{projects.filter((project) => project.status === 'active').map((project) => <option key={project.id} value={project.repository}>{project.name} · {project.repository}</option>)}</select></label>
        <label><span>目标指标</span><select aria-label="目标指标" value={draft.metric} onChange={(event) => setDraft((current) => ({ ...current, metric: event.target.value }))}><option>latency p50</option><option>latency p95</option><option>throughput</option></select></label>
        <fieldset><legend>目标硬件</legend>{['C500', 'CUDA', 'ROCm MI300'].map((item) => <label key={item}><input type="checkbox" checked={draft.hardware.includes(item)} onChange={(event) => setDraft((current) => ({ ...current, hardware: event.target.checked ? [...current.hardware, item] : current.hardware.filter((value) => value !== item) }))} /><span>{item}</span></label>)}</fieldset>
        <button className="primary-action mission-create-submit" disabled={!draft.goal.trim() || !draft.hardware.length} type="submit"><ArrowRight size={15} /> 创建并进入 Mission</button>
      </form>}

      <section className="mission-hub-summary">
        <div><span>项目任务</span><strong>{projectMissions.length}</strong><small>{activeProject?.name || '当前项目'} · 本地持久化</small></div>
        <div><span>Agent 运行中</span><strong>{projectMissions.filter((mission) => mission.status === 'running').length}</strong><small>包含工具执行</small></div>
        <div><span>人工介入</span><strong>{projectMissions.filter((mission) => mission.status === 'awaiting_approval').length}</strong><small>仅统计已阻塞任务</small></div>
        <div><span>已完成</span><strong>{projectMissions.filter((mission) => mission.status === 'completed').length}</strong><small>证据和知识已固化</small></div>
      </section>

      <section className="mission-hub-list">
        <div className="mission-hub-toolbar"><div><span className="eyebrow">MISSION LEDGER</span><strong>任务台账</strong></div><label><Search size={15} /><input aria-label="搜索 Mission" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、目标或仓库" /></label></div>
        <div className="mission-table-head"><span>Mission</span><span>Agent 状态</span><span>目标硬件</span><span>当前结果</span><span>更新</span><span /></div>
        {visible.map((mission) => <button className={`mission-table-row ${mission.id === activeMissionId ? 'active' : ''}`} key={mission.id} onClick={() => onSelect(mission.id)}><div><span className="mission-list-id">{mission.id}</span><strong>{mission.title}</strong><small>{mission.goal}</small></div><span className={`mission-list-status ${mission.status}`}><Mark tone={mission.status === 'awaiting_approval' ? 'ochre' : 'green'} pulse={mission.status === 'running'} />{statusLabel[mission.status] || mission.status}</span><span>{mission.hardware.join(' + ')}</span><div className="mission-result"><strong>{mission.result?.value || '—'}</strong><small>{mission.result?.improvement || 'new'}</small></div><span>{mission.updatedLabel}</span><ChevronRight size={16} /></button>)}
      </section>
    </main>
  );
}

function CapabilitiesView({ agentProfiles = [], capabilityRegistry = { skills: [], tools: [] } }) {
  const [tab, setTab] = useState('profiles');
  return (
    <main className="page capability-page">
      <section className="detail-heading"><div><span className="detail-overline">AGENT CONTROL PLANE</span><h1>Agent 能力中心</h1><p>Profile 决定 Agent 的职责，Skill 定义工作方法，Tool 提供受控执行能力。</p></div><div className="capability-health"><Mark tone="green" /><span>{agentProfiles.length} Profiles · {capabilityRegistry.skills.length} Skills · {capabilityRegistry.tools.length} Tools</span></div></section>
      <section className="capability-tabs" role="tablist"><button className={tab === 'profiles' ? 'active' : ''} onClick={() => setTab('profiles')}>Agent Profiles</button><button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>Skills</button><button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>Tools</button></section>
      {tab === 'profiles' && <section className="profile-registry">{agentProfiles.map((profile, index) => <article key={profile.id} className={profile.status === 'active' ? 'active' : ''}><div className="profile-registry-head"><span className="profile-registry-mark">{String(index + 1).padStart(2, '0')}</span><span className={`profile-state ${profile.status}`}>{profile.status}</span></div><span className="eyebrow">{profile.id}</span><h2>{profile.name}</h2><p>{profile.role}</p><dl><div><dt>版本</dt><dd>{profile.version}</dd></div><div><dt>Skills</dt><dd>{profile.skills}</dd></div><div><dt>Tools</dt><dd>{profile.tools}</dd></div></dl></article>)}</section>}
      {tab !== 'profiles' && <section className="capability-registry"><div className="capability-registry-head"><span>能力</span><span>固定版本</span><span>执行权限</span><span>{tab === 'tools' ? '风险' : '类型'}</span><span>状态</span></div>{(tab === 'tools' ? capabilityRegistry.tools : capabilityRegistry.skills).map((item) => <div className="capability-registry-row" key={item.id}><div><span className={`capability-kind ${tab}`}><>{tab === 'tools' ? <TerminalSquare size={15} /> : <Layers3 size={15} />}</></span><span><strong>{item.name}</strong><small>{item.id}</small></span></div><code>{item.version}</code><span>{item.permission}</span><span>{item.risk || 'workflow'}</span><em><Mark tone="green" /> available</em></div>)}</section>}
    </main>
  );
}

function ResearcherPanel({ researchAgent = {}, researchNotes = [], iterationStats = null, onStartResearch, onCancelResearch }) {
  const [direction, setDirection] = useState('');
  const status = researchAgent.status || 'idle';
  const isResearching = status === 'running' || status === 'cancel_requested';
  const statusLabel = { running: '调研中', completed: '调研完成', failed: '调研失败', timed_out: '预算耗尽', cancelled: '已取消', cancel_requested: '正在取消' }[status] || (status === 'idle' ? '待调研' : status);
  const syncLabel = researchAgent.synchronous ? '串行等待' : '并行不阻塞';
  const loopStatus = iterationStats?.loopStatus;
  const loopReasonText = { max_rounds: '已迭代到最大轮数上限，仍未完成采纳，请人工介入', total_budget: '累计迭代时长超出预算上限，请人工介入', max_research: '研究员已多次升级仍未产生被采纳候选，请人工介入' }[iterationStats?.loopStatusReason] || iterationStats?.loopStatusReason;
  return (
    <section className="research-panel panel-surface">
      <div className="workbench-panel-head">
        <div><span className="eyebrow">RESEARCH SCOUT</span><strong>研究员 · 外部调研</strong></div>
        <div className="research-panel-head-actions"><span className={`run-status ${status}`}>{statusLabel}</span><span className="research-mode-chip">{syncLabel}</span></div>
      </div>

      {loopStatus === 'needs_human' && <div className="research-loop-status blocked"><TriangleAlert size={16} /><div><strong>循环需要人工介入</strong><span>{loopReasonText || '已触发自动流转上限，请人工决策后继续。'}</span></div></div>}

      <div className="research-loop-meta"><span>第 {iterationStats?.round || 0} 轮</span><span>连续 {iterationStats?.consecutiveNoAdopt || 0} 轮无采纳</span><span>研究员升级 {iterationStats?.researchRounds || 0} 次</span></div>

      {isResearching && <div className="research-current">
        <div className="research-current-head"><span>当前调研</span><strong>{researchAgent.direction || '自动生成方向'}</strong><em>{researchAgent.phase || '调研中'}</em></div>
        <div className="agent-progress-track"><i style={{ width: `${researchAgent.progress || 5}%` }} /></div>
      </div>}

      <div className="research-actions">
        <input value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="研究方向（留空 = 自动从卡点生成）" disabled={isResearching} aria-label="研究方向" />
        {isResearching
          ? <button className="agent-stop-action" type="button" onClick={onCancelResearch} disabled={status === 'cancel_requested'}><Pause size={15} /> {status === 'cancel_requested' ? '正在取消' : '取消调研'}</button>
          : <button className="primary-action" type="button" onClick={() => { onStartResearch(direction); setDirection(''); }}><Search size={15} /> 发起调研</button>}
      </div>

      {(researchNotes || []).length > 0 ? (
        <div className="research-notes-list">
          {(researchNotes || []).map((note) => (
            <details className="research-note" key={note.id}>
              <summary><div><strong>{note.direction || '调研笔记'}</strong>{note.summary && <span>{note.summary}</span>}</div><em className={note.value === 'high' ? 'high' : note.value === 'medium' ? 'medium' : 'low'}>{note.value ? `价值 ${note.value}` : '未评估'}{note.injected ? ' · 已注入' : ''}</em></summary>
              <div className="research-note-body">
                {(note.findings || []).length > 0 && <div className="research-note-block"><span className="eyebrow">FINDINGS</span>{(note.findings || []).map((finding, index) => <div className="knowledge-row" key={index}><div className="knowledge-type">F{index + 1}</div><div><strong>{finding}</strong></div></div>)}</div>}
                {(note.suggestedDirections || []).length > 0 && <div className="research-note-block"><span className="eyebrow">SUGGESTED DIRECTIONS</span>{(note.suggestedDirections || []).map((item, index) => <div className="reference-row" key={index}><div className="reference-icon">→</div><div><strong>{item}</strong></div></div>)}</div>}
                {(note.sources || []).length > 0 && <div className="research-note-block"><span className="eyebrow">SOURCES</span>{(note.sources || []).map((source, index) => <div className="reference-row" key={index}><div className="reference-icon">⌁</div><div><strong>{source.title || '来源'}</strong>{source.url && <small>{source.url}</small>}</div></div>)}</div>}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="agent-empty"><Search size={22} /><strong>尚未发起调研</strong><span>陷入停滞或操作员触发时，研究员会联网调研最新算子做法并产出针对性笔记。</span></div>
      )}
    </section>
  );
}

function AgentWorkbenchView({ stage, activeMission, agentState, agentProfiles = [], capabilityRegistry = { skills: [], tools: [] }, runtimeInfo, runtimePreflight, intentIssue, onStartAgent, onCancelAgent, onAdvance, setView, onOpenModal, paused, researchAgent, researchNotes, iterationStats, onStartResearch, onCancelResearch }) {
  const mission = activeMission || { id: '—', title: '未选择任务', goal: '', hardware: [], repository: '', metric: '' };
  const activeProfile = agentProfiles.find((profile) => profile.id === agentState.profileId) || agentProfiles[0];
  const [goal, setGoal] = useState(agentState.goal || mission.goal || '');
  const isRunning = agentState.status === 'running' || agentState.status === 'executing' || agentState.status === 'cancel_requested';
  const canCancelAgent = agentState.status === 'running' || agentState.status === 'cancel_requested';
  const isAwaitingApproval = agentState.status === 'awaiting_approval';
  const isAwaitingAction = agentState.status === 'awaiting_action';
  const statusLabel = agentState.status === 'cancel_requested' ? '正在停止 Agent' : agentState.status === 'executing' ? '工具执行中' : isRunning ? 'Agent 执行中' : isAwaitingApproval ? '流程已阻塞' : isAwaitingAction ? '策略建议已就绪' : agentState.status === 'completed' ? (activeMission?.stage === 'published' ? 'Mission 已完成' : '本轮运行完成') : agentState.status === 'failed' ? '上次运行失败' : 'Mission 就绪';
  const actionDestination = { 'candidate.plan': 'code', 'test.plan': 'experiments', 'adoption.decision': 'decision', 'review.resolve': 'decision', 'knowledge.publish': 'curation' }[agentState.currentAction?.type] || 'iterations';
  const actionLabel = { 'candidate.plan': '查看 Candidate Plan', 'test.plan': '打开测试矩阵', 'adoption.decision': '查看策略建议', 'review.resolve': '处理审批意见', 'knowledge.publish': '审阅知识草稿' }[agentState.currentAction?.type] || '查看 Action';
  const actionRequiresApproval = Boolean(agentState.currentAction?.approvalRequired);
  const runtimeConnected = runtimeInfo?.connected === true && runtimeInfo?.mode !== 'unavailable';
  const missionRuntimeReady = runtimeConnected && runtimePreflight?.ready === true;
  const candidateCount = mission.candidateEvaluations?.length || 0;
  const failureCount = mission.failureRecords?.length || 0;
  const knowledgeCount = (mission.knowledgeDrafts?.length || 0) + (mission.publishedAssets?.length || 0);
  const benchmarkMeasurements = mission.benchmark?.result?.benchmark || [];
  const correctnessTotal = benchmarkMeasurements.reduce((sum, item) => sum + (item.correctness?.total || 0), 0);
  const correctnessPassed = benchmarkMeasurements.reduce((sum, item) => sum + (item.correctness?.passed ? (item.correctness?.total || 0) : 0), 0);
  const allToolCalls = agentState.toolCalls || [];
  const toolEvidenceCategory = (call) => {
    const summary = String(call.summary || '');
    if (/git\s+(status|diff|log|show|ls-files)|git diff/i.test(summary)) return 'git';
    if (/Get-Content|README|paged_attention|\.ya?ml/i.test(summary)) return 'files';
    if (/rg\s+-n|Get-ChildItem/i.test(summary)) return 'repository';
    if (/Get-CimInstance|Win32_Process|Get-Process|tasklist/i.test(summary)) return 'process';
    return 'system';
  };
  const completedEvidenceCategories = new Set(allToolCalls.filter((call) => call.status === 'completed').map(toolEvidenceCategory));
  const unresolvedToolCalls = allToolCalls.filter((call) => (call.status === 'failed' || call.status === 'warning') && !completedEvidenceCategories.has(toolEvidenceCategory(call)));
  const recoveredToolCalls = allToolCalls.filter((call) => (call.status === 'failed' || call.status === 'warning') && completedEvidenceCategories.has(toolEvidenceCategory(call)));
  const hasStructuredResult = Boolean(agentState.result && (agentState.result.summary || agentState.result.diagnosis));
  const noCandidateResult = agentState.status === 'completed' && hasStructuredResult && !(agentState.result?.candidates || []).length;
  const baselineEmpty = runtimePreflight?.workspaceCheck?.baselineEmpty === true;
  // A completed structured result is authoritative. Shell exploration can contain
  // recoverable failures; surface the conclusion instead of turning every failed
  // probe into a separate workflow blocker.
  const warningToolCalls = noCandidateResult ? [] : unresolvedToolCalls;
  const warningDetails = [...new Set(warningToolCalls.map(toolEvidenceCategory))].map((category) => {
    const calls = warningToolCalls.filter((call) => toolEvidenceCategory(call) === category);
    const summary = calls.map((call) => String(call.summary || '')).join(' ');
    if (category === 'files') return { id: 'files', title: '无法读取任务所需的仓库文件', impact: 'Agent 缺少源码或测试配置，不能可靠生成候选方案。', action: '系统正在重试；若持续失败，请检查 Mission 工作区文件是否存在。', blocking: true };
    if (category === 'git') return { id: 'git', title: '无法确认当前代码改动和版本状态', impact: '系统不能判断 Patch 基线，暂不应应用候选。', action: '系统正在重新读取 Git 状态；无需手动批准候选。', blocking: true };
    if (category === 'repository') return { id: 'repository', title: '仓库结构扫描没有完成', impact: 'Agent 可能遗漏相关实现，但已经取得的文件仍可继续分析。', action: '系统会缩小扫描范围后重试。', blocking: false };
    if (category === 'process') return { id: 'process', title: '无法读取本机进程归属信息', impact: '只影响 Agent 连接证明，不影响推理、代码修改和测试。', action: /access denied|拒绝访问/i.test(summary) ? '无需处理；当前 Windows 权限不允许读取该字段。' : '无需处理；系统会使用其他连接证据。', blocking: false };
    return { id: 'system', title: '一项运行环境检查没有完成', impact: '该项结果不会用于本轮结论。', action: '系统将自动重试；持续失败时再提示人工处理。', blocking: false };
  });
  if (baselineEmpty || noCandidateResult) warningDetails.unshift({
    id: 'baseline-empty',
    title: baselineEmpty ? '项目基线为空，未生成候选' : '本轮未生成候选，流程无法继续',
    impact: baselineEmpty ? '当前 Iteration Repository 没有受 Git 管理的源码、测试或构建配置，Agent 无法确定可修改的算子入口。' : (agentState.result?.diagnosis?.summary || agentState.result?.summary || 'Agent 没有返回可执行的 Candidate Plan。'),
    action: baselineEmpty ? '把实际项目文件放入项目的 repository 目录，或切换到包含代码的 Git 仓库后重新运行 Agent。' : '补齐项目代码、测试配置和目标验收条件后重新运行 Agent。',
    blocking: true,
  });
  const blockingIssueCount = warningDetails.filter((issue) => issue.blocking).length;
  const runResult = (() => {
    if (agentState.status === 'failed') return {
      tone: 'error', Icon: TriangleAlert, title: '运行失败，暂时不能继续',
      detail: agentState.messages?.findLast?.((message) => message.errorCode)?.detail || 'Codex 未能完成本轮任务，请查看错误详情后重新运行。',
      next: '处理错误并重新运行', canProceed: false,
    };
    if (agentState.status === 'awaiting_approval') return {
      tone: 'blocked', Icon: ShieldCheck, title: '等待人工处理，流程已阻塞',
      detail: 'Codex 已暂停后续动作，处理人工介入请求后才会继续。',
      next: '处理人工介入', canProceed: false,
    };
    if (isRunning) return {
      tone: 'running', Icon: Activity, title: 'Codex 正在正常运行',
      detail: `${agentState.phase || '正在分析任务'}，完成后系统会自动给出结论和下一步。`,
      next: '等待本轮完成', canProceed: false,
    };
    if (isAwaitingAction) return {
      tone: 'success', Icon: CheckCircle2, title: '运行成功，可以继续',
      detail: `Codex 已完成分析并生成 ${agentState.result?.candidates?.length || 1} 个候选建议。本轮没有阻塞性错误。`,
      next: actionLabel, canProceed: true,
    };
    if (agentState.status === 'completed') return {
      tone: noCandidateResult ? 'warning' : 'success', Icon: noCandidateResult ? TriangleAlert : CheckCircle2, title: noCandidateResult ? '运行完成，但未形成候选' : '运行成功，本轮已完成',
      detail: noCandidateResult ? (agentState.result?.diagnosis?.summary || agentState.result?.summary || '当前没有足够的项目证据生成候选。') : activeMission?.stage === 'published' ? 'Codex、评测、Gate 和知识维护均已完成。' : 'Codex 已完成本轮分析，但 Mission 仍有后续候选、评测或决策步骤。',
      next: noCandidateResult ? '补齐项目基线后重新运行' : agentState.currentAction ? actionLabel : '可重新运行或查看产物', canProceed: !noCandidateResult,
    };
    if (agentState.status === 'cancelled') return {
      tone: 'neutral', Icon: Pause, title: '本轮已停止',
      detail: 'Codex 已停止执行，本轮不会继续产生新动作。',
      next: '需要时重新运行', canProceed: false,
    };
    return {
      tone: 'neutral', Icon: CircleDot, title: 'Codex 已连接，等待启动',
      detail: '本机 Runtime 与 Mission 工作区均已就绪，可以发起新的运行。',
      next: '输入目标并启动 Agent', canProceed: true,
    };
  })();
  const RunResultIcon = runResult.Icon;
  const uniqueAgentMessages = (agentState.messages || []).filter((message, index, messages) => {
    const signature = `${message.phase || ''}|${message.status || ''}|${String(message.detail || '').trim().replace(/\s+/g, ' ')}`;
    return messages.findIndex((item) => `${item.phase || ''}|${item.status || ''}|${String(item.detail || '').trim().replace(/\s+/g, ' ')}` === signature) === index;
  });
  const readableMessages = uniqueAgentMessages.map((message, index) => {
    const rawDetail = String(message.detail || '').trim();
    const isStructuredResult = rawDetail.startsWith('{') && rawDetail.endsWith('}');
    if (message.errorCode) return {
      ...message,
      title: agentState.status === 'failed' ? message.title : `非阻塞诊断 · ${message.title}`,
      detail: message.detail,
      badge: agentState.status === 'failed' ? '需要处理' : '不阻塞下一步',
    };
    if (isStructuredResult) return {
      ...message,
      phase: 'candidate',
      title: '结构化结果已返回',
      detail: agentState.result?.diagnosis?.summary || agentState.result?.summary || 'Agent 已返回结构化结果。',
      badge: `${agentState.result?.candidates?.length || 0} 个候选 · ${agentState.result?.nextAction?.title || '等待下一步'}`,
    };
    const titles = ['读取 Mission 工作区', '确认工作区连接', '核对任务配置', '补充运行证据'];
    return {
      ...message,
      title: titles[index] || 'Agent 分析步骤',
      detail: rawDetail.replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 220),
      badge: message.status === 'completed' ? '已完成' : '进行中',
    };
  }).concat(warningDetails.length > 0 && agentState.status !== 'failed' ? [{
    id: `tool-warning-summary-${agentState.runId}`,
    phase: 'diagnosis',
    status: 'warning',
    title: blockingIssueCount > 0 ? `${blockingIssueCount} 个问题阻止流程继续` : `${warningDetails.length} 个问题不影响当前流程`,
    detail: blockingIssueCount > 0 ? '请先处理下面标记为“阻塞”的问题，系统不会在证据不足时继续应用 Patch 或提交测试。' : '这些问题只影响补充信息，候选生成、Patch 和 Benchmark 可以继续。',
    badge: blockingIssueCount > 0 ? '需要处理' : '无需处理',
    time: '本轮运行',
    warningDetails,
  }] : []);
  const activityMessages = [...readableMessages].reverse();
  useEffect(() => {
    if (agentState.goal && agentState.goal !== goal && !isRunning) setGoal(agentState.goal);
  }, [agentState.goal, isRunning]);
  if (!runtimeInfo) return (
    <main className="page agent-workbench-page">
      <section className="detail-heading">
        <div><span className="detail-overline">AGENT RUNTIME / CONNECTING</span><h1>正在连接本机 Codex</h1><p>正在确认 Codex CLI 与本地 Runtime 状态，完成后将恢复最近一次 Mission。</p></div>
        <span className="mission-status-chip running">连接中</span>
      </section>
      <section className="agent-empty-state runtime-connecting-state">
        <div className="agent-empty-state-icon"><Activity size={30} /></div>
        <h2>正在初始化 Agent Runtime</h2>
        <p>此过程只读取本机 Codex 状态，不会自动发起模型调用或启动 Mission。</p>
      </section>
    </main>
  );
  if (!runtimeConnected) return (
    <main className="page agent-workbench-page">
      <section className="detail-heading">
        <div><span className="detail-overline">AGENT RUNTIME / DISCONNECTED</span><h1>等待接入真实 Agent</h1><p>Operator Studio 不会在 Agent 未连接时生成推理、工具调用或候选结果。</p></div>
        <span className="mission-status-chip unavailable">未连接</span>
      </section>
      <section className="agent-empty-state">
        <div className="agent-empty-state-icon"><CircleDot size={30} /></div>
        <h2>{runtimeInfo?.mode === 'codex-cli' ? '未检测到本机 Codex CLI' : '请先连接可用的 Coding Agent'}</h2>
        <p>{runtimeInfo?.hint || '客户端会自动启动 Agent 并接收推理、工具调用、候选和测试证据，无需手动打开 Agent 会话。'}</p>
        <div className="agent-empty-state-meta"><span>当前 Runtime</span><strong>{runtimeInfo?.label || 'Agent not connected'}</strong><span>测试服务</span><strong>仅负责 Benchmark / Tracer / Profiler</strong></div>
      </section>
    </main>
  );
  return (
    <main className="page agent-workbench-page">
      <section className="agent-command-header">
        <div className="agent-command-copy">
          <span className="detail-overline">MISSION WORKSPACE / {mission.id}</span>
          <div className="agent-command-title"><h1>让 Agent 负责迭代，你负责决策。</h1><span className={`mission-status-chip ${agentState.status}`}>{statusLabel}</span></div>
          <p>持续工作的算子优化 Mission，所有计划、代码、实验和证据都在同一条工作链上。</p>
        </div>
        <div className="agent-command-meta"><span><Mark tone={missionRuntimeReady ? 'green' : 'ochre'} pulse={!runtimePreflight} /> {missionRuntimeReady ? '受管工作区已就绪' : runtimePreflight ? '工作区预检失败' : '正在准备工作区'}</span><span><GitBranch size={14} /> {runtimePreflight?.workspaceCheck?.metadata?.mode === 'git-worktree' ? 'Git worktree' : 'Managed Git workspace'}</span></div>
      </section>

      {runtimePreflight && !runtimePreflight.ready && <section className="action-approval required"><ShieldCheck size={16} /><div><strong>Mission 启动前预检未通过</strong><span>{runtimePreflight.workspaceCheck?.detail || runtimePreflight.agentCheck?.detail || '请检查本机 Codex 与工作区状态。'}</span></div></section>}

      <section className="mission-intent-bar">
        <div className="intent-label"><CircleDot size={15} /><span>MISSION INTENT</span></div>
        <form className="intent-form" onSubmit={(event) => { event.preventDefault(); onStartAgent(goal); }}>
          <input value={goal} onChange={(event) => setGoal(event.target.value)} aria-label="优化目标" placeholder="输入一个优化目标" disabled={isRunning || paused} />
          {canCancelAgent
            ? <button className="agent-stop-action" type="button" onClick={onCancelAgent} disabled={agentState.status === 'cancel_requested'}><Pause size={15} /> {agentState.status === 'cancel_requested' ? '正在停止' : '停止 Agent'}</button>
            : <button className="primary-action" type="submit" disabled={isRunning || paused || !goal.trim() || !missionRuntimeReady}>{agentState.status === 'executing' ? <><Activity size={15} /> 流程执行中</> : <><ArrowRight size={15} /> {!runtimePreflight ? '准备工作区' : agentState.status === 'idle' ? '启动 Agent' : '重新运行'}</>}</button>}
        </form>
        <div className="intent-facts">{(mission.hardware || ['C500']).map((item) => <span key={item}>{item}</span>)}<span>{mission.metric || 'latency p50'}</span></div>
      </section>
      {intentIssue && <section className={`intent-feedback ${intentIssue.status}`} role="alert">
        <span><TriangleAlert size={18} /></span>
        <div><strong>{intentIssue.title}</strong><p>{intentIssue.message}</p>{intentIssue.missing?.length > 0 && <small>还需补充：{intentIssue.missing.join('、')}</small>}</div>
        {intentIssue.suggestions?.[0] && <button type="button" onClick={() => setGoal(intentIssue.suggestions[0])}>载入可执行测试例 <ArrowRight size={14} /></button>}
      </section>}

      <section className="agent-workbench-grid">
        <article className="agent-stream-panel panel-surface">
          <div className="workbench-panel-head"><div><span className="eyebrow">AGENT RUN</span><strong>{agentState.runId || '等待新的 Run'}</strong></div><span className={`run-status ${agentState.status}`}>{statusLabel}</span></div>
          <div className={`agent-run-summary ${runResult.tone}`}>
            <span className="agent-run-summary-icon"><RunResultIcon size={21} /></span>
            <div className="agent-run-summary-copy"><span>本轮结论</span><strong>{runResult.title}</strong><p>{runResult.detail}</p><div className="agent-run-summary-flags"><em>{runResult.canProceed ? '可进行下一步' : '暂不可继续'}</em>{warningDetails.length > 0 && agentState.status !== 'failed' && <em className="warning">{blockingIssueCount > 0 ? `${blockingIssueCount} 个问题需要处理` : `${warningDetails.length} 个问题无需处理`}</em>}</div></div>
            <div className="agent-run-next"><span>下一步</span><strong>{runResult.next}</strong></div>
          </div>
          <div className="agent-progress-track"><i style={{ width: `${agentState.progress || 0}%` }} /></div>
          <div className="agent-phase-row"><span>当前阶段</span><strong>{agentState.phase || '待启动'}</strong><em>{agentState.progress || 0}%</em></div>
          {agentState.status === 'failed' && <div className="agent-run-history-note"><History size={15} /><span>这是上次 Run 的持久化失败记录，不代表当前 Codex Runtime 仍然不可用。点击“重新运行”会创建新的独立线程。</span></div>}
          {readableMessages.length > 0 ? <section className="agent-activity-shell">
            <div className="agent-activity-window" aria-label="Agent 运行动态" tabIndex={0}>
              <div className="activity-window-head"><div><Activity size={15} /><span>运行动态</span><Mark tone={isRunning ? 'blue' : agentState.status === 'failed' ? 'ochre' : 'green'} pulse={isRunning} /></div><small>{readableMessages.length} 条动作</small></div>
              <div className="activity-feed" role="log" aria-live="polite">
                {activityMessages.map((message, index) => { const isWarning = message.errorCode || message.status === 'warning'; return <article className={`activity-feed-item ${isWarning ? 'warning' : message.status}`} key={message.id}>
                  <span className="activity-feed-index">{index === 0 ? 'NOW' : String(index).padStart(2, '0')}</span>
                  <div><strong>{message.title}</strong><p>{message.detail}</p><small>{message.time}</small>{message.warningDetails && <details className="tool-warning-disclosure"><summary><span>查看具体问题</span><ChevronDown size={14} /></summary><div className="tool-warning-list">{message.warningDetails.map((warning, warningIndex) => <div className={warning.blocking ? 'blocking' : 'nonblocking'} key={warning.id}><em>{warning.blocking ? '阻塞' : '提示'}</em><div><strong>{warning.title}</strong><dl><div><dt>影响</dt><dd>{warning.impact}</dd></div><div><dt>处理</dt><dd>{warning.action}</dd></div></dl></div></div>)}</div></details>}</div>
                  <span className="activity-feed-state">{message.badge}</span>
                </article>; })}
              </div>
            </div>
          </section> : <div className="agent-empty"><Activity size={22} /><strong>等待 Agent 接管 Mission</strong><span>启动后，这里会出现可追溯的 Agent Action。</span></div>}
        </article>

        <article className="agent-action-panel panel-surface">
          <div className="workbench-panel-head"><div><span className="eyebrow">CURRENT ACTION</span><strong>{agentState.currentAction ? agentState.currentAction.type : 'orchestrator.idle'}</strong></div><ShieldCheck size={17} className="action-shield" /></div>
          {agentState.currentAction ? <>
            <div className="action-card-title"><span className="action-number">01</span><h2>{agentState.currentAction.title}</h2></div>
            <dl className="action-facts"><div><dt>为什么现在</dt><dd>{agentState.currentAction.reason}</dd></div><div><dt>预期产物</dt><dd>{agentState.currentAction.expectedOutput}</dd></div><div><dt>风险等级</dt><dd><span className="risk-pill">{agentState.currentAction.risk}</span></dd></div></dl>
            <div className={`action-approval ${actionRequiresApproval ? 'required' : 'conditional'}`}><ShieldCheck size={16} /><div><strong>{actionRequiresApproval ? '流程正在等待人工处理' : '当前无需强制人工审批'}</strong><span>{actionRequiresApproval ? '审批意见已进入审计链，处理前流程保持阻塞。' : '策略建议已就绪，你可以直接继续，也可以主动发起人工复核。'}</span></div></div>
            <button className="primary-action action-continue" onClick={() => setView(actionDestination)}><Code2 size={15} /> {actionLabel} <ArrowRight size={14} /></button>
          </> : <div className="action-empty"><div className="action-empty-mark"><CircleDot size={22} /></div><strong>Agent 尚未提出动作</strong><p>Mission 启动后，计划、工具调用和审批请求会在这里聚合。</p></div>}
        </article>

        <aside className="agent-context-panel panel-surface">
          <div className="workbench-panel-head"><div><span className="eyebrow">MISSION CONTEXT</span><strong>任务上下文</strong></div><button className="icon-inline-button" aria-label="任务审计" onClick={() => onOpenModal('events')}><History size={15} /></button></div>
          <div className="context-goal"><span>目标</span><strong>{agentState.goal || mission.goal || goal}</strong></div>
          {activeProfile && <div className="context-profile"><span className="eyebrow">ACTIVE PROFILE</span><div><span className="profile-avatar">AO</span><div><strong>{activeProfile.name}</strong><small>{activeProfile.version} · {activeProfile.role}</small></div><Mark tone="green" /></div></div>}
          <div className="context-section"><span className="eyebrow">ARTIFACTS</span>{(agentState.artifacts || []).map((artifact) => <button className="artifact-row" key={artifact.id} onClick={() => artifact.kind.includes('Candidate') ? setView('code') : onOpenModal('events')}><span className={`artifact-dot ${artifact.status}`} /><div><strong>{artifact.title}</strong><small>{artifact.kind} · {artifact.meta}</small></div><ChevronRight size={14} /></button>)}</div>
          <div className="context-section context-tools"><span className="eyebrow">TOOL CALLS</span>{(agentState.toolCalls || []).slice(-3).map((call, index) => <div className="tool-call-row" key={`${call.id}-${index}`}><span className={`tool-call-status ${call.status}`} /><div><strong>{call.name}</strong><small>{call.version} · {call.permission}</small></div><em>{call.status === 'completed' ? 'done' : call.status === 'failed' || call.status === 'warning' ? 'warning' : 'running'}</em></div>)}</div>
          <div className="context-section context-gates"><span className="eyebrow">GATES</span><div><CheckCircle2 size={14} /><span>Correctness {correctnessTotal ? `${correctnessPassed} / ${correctnessTotal}` : '等待测试'}</span><em>{correctnessTotal ? (correctnessPassed === correctnessTotal ? 'ready' : 'failed') : 'pending'}</em></div><div><ShieldCheck size={14} /><span>Human approval</span><em>{isAwaitingApproval ? 'required' : 'policy'}</em></div></div>
          <button className="ghost-action context-advance" onClick={() => onAdvance()} disabled={isRunning || paused}><Activity size={14} /> 查看当前阶段</button>
        </aside>
      </section>

      <section className="agent-output-strip">
        <button onClick={() => setView('iterations')}><History size={17} /><div><span>ITERATION HISTORY</span><strong>{candidateCount ? `${candidateCount} 个候选` : '等待候选'}</strong><small>{failureCount ? `${failureCount} 次失败已保留记录` : '查看假设、Diff、结果和采用决策'}</small></div><ArrowRight size={15} /></button>
        <button onClick={() => setView('experiments')}><TestTube2 size={17} /><div><span>VALIDATION</span><strong>{correctnessTotal ? `${correctnessPassed} / ${correctnessTotal} correctness` : mission.benchmark?.status === 'running' ? `运行中 ${mission.benchmark.progress || 0}%` : '等待测试'}</strong><small>{mission.testMatrix?.environments?.join(' + ') || '尚未配置测试环境'}</small></div><ArrowRight size={15} /></button>
        <button onClick={() => setView('knowledge')}><BookOpen size={17} /><div><span>KNOWLEDGE</span><strong>{knowledgeCount ? `${knowledgeCount} 条任务知识` : '等待提取'}</strong><small>成功经验与失败记录均保留证据引用</small></div><ArrowRight size={15} /></button>
      </section>

      <ResearcherPanel researchAgent={researchAgent} researchNotes={researchNotes} iterationStats={iterationStats} onStartResearch={onStartResearch} onCancelResearch={onCancelResearch} />
    </main>
  );
}

function IterationTrendChart({ iterations }) {
  const width = 760;
  const height = 224;
  const padding = { left: 52, right: 24, top: 24, bottom: 42 };
  const minValue = 38;
  const maxValue = 56;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const measuredIterations = iterations.filter((item) => Number.isFinite(item.c500));
  const pendingIterations = iterations.filter((item) => !Number.isFinite(item.c500));
  const points = measuredIterations.map((item, index) => ({
    ...item,
    x: padding.left + (innerWidth / Math.max(1, measuredIterations.length - 1)) * index,
    y: padding.top + ((maxValue - item.c500) / (maxValue - minValue)) * innerHeight,
  }));
  const targetY = padding.top + ((maxValue - 45) / (maxValue - minValue)) * innerHeight;
  return (
    <svg className="iteration-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="C500 延迟随候选迭代变化趋势">
      {[55, 50, 45, 40].map((tick) => {
        const y = padding.top + ((maxValue - tick) / (maxValue - minValue)) * innerHeight;
        return <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid-line" /><text x={padding.left - 12} y={y + 4} textAnchor="end" className="chart-axis-label">{tick}μs</text></g>;
      })}
      <line x1={padding.left} x2={width - padding.right} y1={targetY} y2={targetY} className="chart-target-line" />
      <text x={width - padding.right} y={targetY - 7} textAnchor="end" className="chart-target-label">TARGET 45μs</text>
      {points.length > 1 && <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} className="chart-trend-line" />}
      {points.map((point) => <g key={point.id} className={`chart-point ${point.tone}`}><circle cx={point.x} cy={point.y} r={point.tone === 'adopted' ? 7 : 5} /><text x={point.x} y={point.y - 12} textAnchor="middle" className="chart-value">{point.c500}</text><text x={point.x} y={height - 17} textAnchor="middle" className="chart-candidate-label">{point.label.replace('Candidate ', 'C')}</text></g>)}
      {pendingIterations.length > 0 && <g className="chart-pending-state"><rect x={width - 254} y={height - 58} width="230" height="30" rx="3" /><text x={width - 139} y={height - 39} textAnchor="middle">{pendingIterations.length} 个候选等待 Benchmark，不参与折线</text></g>}
    </svg>
  );
}

function IterationsView({ candidateEvaluations = defaultCandidateEvaluations, failureRecords = defaultFailureRecords, onOpenModal }) {
  const candidates = candidateEvaluations;
  const failedRecords = failureRecords;
  if (!candidates.length && !failedRecords.length) return <main className="page detail-page iterations-page"><section className="detail-heading"><div><span className="detail-overline">CANDIDATE LIFECYCLE</span><h1>暂无候选记录</h1><p>连接 Agent 并运行 Mission 后，真实候选、弱候选和失败记录会显示在这里。</p></div></section><section className="knowledge-empty"><GitBranch size={25} /><strong>等待 Agent 生成候选</strong><span>客户端不会在 Agent 未连接时填充演示候选。</span></section></main>;
  const adopted = candidates.find((item) => item.classification === 'accepted') || null;
  const focusCandidate = adopted || candidates[0];
  const references = candidates.filter((item) => item.classification === 'reference');
  const timeline = [operatorIterations[0], ...candidates];
  const failed = failedRecords[0];
  return (
    <main className="page detail-page iterations-page">
      <section className="detail-heading">
        <div><span className="detail-overline">CANDIDATE LIFECYCLE / MLA PAGED KV CACHE</span><h1>候选评估与失败经验</h1><p>Accept Gate 自动分类；失败尝试退出候选池，但保留证据记录并提取负向经验。</p></div>
        <div className="detail-actions"><button className="ghost-action" onClick={() => onOpenModal('iterationDetail', { iteration: failed })}><TriangleAlert size={14} /> 查看失败记录</button></div>
      </section>

      <section className="iteration-summary-band">
        <div className="iteration-summary-lead"><span>OPERATOR</span><strong>MLA Paged KV Cache</strong><small>kernel.paged_attention · {adopted ? `current best ${adopted.version}` : '尚无已采用候选'}</small></div>
        <div><span>候选池</span><strong>{candidates.length}</strong><small>1 accepted · {references.length} reference</small></div>
        <div><span>当前最佳</span><strong className={adopted ? 'metric-good' : ''}>{Number.isFinite(adopted?.c500) ? <>{adopted.c500} <em>μs</em></> : '—'}</strong><small>{adopted ? `${adopted.label} · C500` : '尚无候选通过 Accept Gate'}</small></div>
        <div><span>累计提升</span><strong className={adopted ? 'metric-good' : ''}>{Number.isFinite(adopted?.c500) ? `${((53.8 - adopted.c500) / 53.8 * 100).toFixed(1)}%` : '—'}</strong><small>{Number.isFinite(adopted?.c500) ? `53.8 → ${adopted.c500}μs` : '等待 Benchmark 结果'}</small></div>
        <div><span>失败记录</span><strong>{failedRecords.length}</strong><small>{failedRecords.filter((item) => item.extractedExperience?.status === 'extracted').length} 条经验已提取</small></div>
      </section>

      <section className="candidate-classification-band" aria-label="Accept Gate 分类">
        <div className="accepted"><span><CheckCircle2 size={17} /></span><div><small>ACCEPT GATE · PASS</small><strong>可采用候选</strong><p>全部硬门禁通过，由策略自动更新 current best。</p></div><em>{candidates.filter((item) => item.classification === 'accepted').length}</em></div>
        <div className="reference"><span><BookOpen size={17} /></span><div><small>REFERENCE ONLY</small><strong>弱候选参考</strong><p>保留可复用假设与局部收益，不具备采用资格。</p></div><em>{references.length}</em></div>
        <div className="failed"><span><TriangleAlert size={17} /></span><div><small>REMOVED FROM POOL</small><strong>失败记录</strong><p>不保留候选身份，仅保留审计证据与负向经验。</p></div><em>{failedRecords.length}</em></div>
      </section>

      <section className="iteration-analysis-grid">
        <article className="iteration-trend-panel">
          <div className="iteration-panel-head"><div><span>CANDIDATE TREND</span><strong>候选池内的 C500 延迟演进</strong></div><div className="chart-legend"><span><i className="adopted" />已采用</span><span><i className="reference" />弱候选</span></div></div>
          <IterationTrendChart iterations={timeline} />
          <div className="trend-footnote"><ShieldCheck size={14} /><span>折线仅包含基线和候选池成员；失败运行不会伪装成候选进入趋势比较。</span></div>
        </article>

        <aside className={`iteration-best-panel ${adopted ? '' : 'pending'}`}>
          <div className="best-panel-label">{adopted ? <><CheckCircle2 size={15} /> ACCEPT GATE · PASS</> : <><CircleDot size={15} /> ACCEPT GATE · PENDING</>}</div>
          <span className={`iteration-status ${adopted ? 'adopted' : 'running'}`}>{adopted ? adopted.status : '等待验证'}</span>
          <h2>{focusCandidate.label} · {focusCandidate.title}</h2>
          <p>{focusCandidate.hypothesis}</p>
          <div className="best-platform-results"><div><span>C500</span><strong>{Number.isFinite(focusCandidate.c500) ? `${focusCandidate.c500}μs` : '待测试'}</strong><small>{Number.isFinite(focusCandidate.c500) ? focusCandidate.delta : '不参与趋势比较'}</small></div><div><span>CUDA</span><strong>{Number.isFinite(focusCandidate.cuda) ? `${focusCandidate.cuda}μs` : '待测试'}</strong><small>{Number.isFinite(focusCandidate.cuda) ? '已采集' : '等待结果'}</small></div></div>
          <div className="best-proof"><span><CheckCircle2 size={14} /> Correctness {focusCandidate.correctness || 'pending'}</span><span><ShieldCheck size={14} /> {focusCandidate.evidence || '尚未形成证据'}</span></div>
          <button onClick={() => onOpenModal('iterationDetail', { iteration: focusCandidate })}>{adopted ? '查看采用证据' : '查看候选计划'} <ArrowRight size={14} /></button>
        </aside>
      </section>

      <section className="iteration-ledger">
        <div className="iteration-ledger-title"><div><span>REUSABLE CANDIDATE POOL</span><strong>候选池</strong></div><small>只有可采用候选与弱候选参考保留 Candidate 身份</small></div>
        <div className="iteration-ledger-head"><span>版本</span><span>优化方向</span><span>C500</span><span>CUDA</span><span>相对基线</span><span>正确性</span><span>分类</span><span /></div>
        {candidates.map((item) => <button key={item.id} className={`iteration-ledger-row ${item.tone}`} onClick={() => onOpenModal('iterationDetail', { iteration: item })}><div><span className="iteration-version">{item.version}</span><small>{item.date}</small></div><div><strong>{item.title}</strong><small>{item.files || '尚无 Patch'}</small></div><b>{Number.isFinite(item.c500) ? `${item.c500}μs` : '—'}</b><b>{Number.isFinite(item.cuda) ? `${item.cuda}μs` : '—'}</b><em>{item.delta || '待测试'}</em><span>{item.correctness}</span><span className={`iteration-status ${item.tone}`}>{item.status}</span><ChevronRight size={15} /></button>)}
      </section>

      <section className="failure-records-section">
        <div className="failure-records-heading"><div><span>FAILURE RECORDS / NOT CANDIDATES</span><strong>失败记录与负向经验</strong></div><small>代码提案退出候选池 · 证据按审计策略保留</small></div>
        {failedRecords.map((record) => <article className="failure-record-row" key={record.id}>
          <div className="failure-record-id"><span>{record.version}</span><strong>{record.sourceAttempt}</strong><small>{record.date}</small></div>
          <div className="failure-record-cause"><span>{record.failure?.gate || 'Hard Gate'}</span><strong>{record.title}</strong><p>{record.decisionReason}</p></div>
          <div className="failure-experience"><Lightbulb size={16} /><span><small>EXTRACTED EXPERIENCE</small><strong>{record.extractedExperience?.title}</strong><p>{record.extractedExperience?.reuse}</p></span></div>
          <button aria-label={`查看 ${record.sourceAttempt} 失败记录`} onClick={() => onOpenModal('iterationDetail', { iteration: record })}><ChevronRight size={16} /></button>
        </article>)}
      </section>
    </main>
  );
}

function CodeView({ patchApplied, workspaceFiles: remoteWorkspaceFiles, candidateEvaluations = [], currentAction, onApplyPatch, onOpenModal, paused }) {
  const applied = patchApplied;
  const [diffMode, setDiffMode] = useState('unified');
  const [activeFileId, setActiveFileId] = useState('paged_attention.cu');
  const [expandedFolders, setExpandedFolders] = useState({ kernels: true, tests: false, benchmarks: false });
  const [policyState, setPolicyState] = useState(applied ? 'applied' : 'ready');
  const autoCheckStarted = useRef(false);
  const fallbackFiles = {
    'paged_attention.cu': {
      path: 'kernels/paged_attention.cu', status: 'M',
      lines: [
        ['context', '188', 'auto plan = build_attention_plan(args);'],
        ['remove', '189', 'auto workspace = allocate_workspace(plan.size());'],
        ['remove', '190', 'mirror_to_host(plan, host_plan);'],
        ['add', '189', 'auto& plan = plan_cache.get_or_build(args.signature());'],
        ['add', '190', 'if (LIKELY(plan.host_mirror_ready())) {'],
        ['add', '191', '  launch_paged_kernel(plan.device_view(), kv_cache);'],
        ['add', '192', '} else {'],
        ['add', '193', '  plan_cache.enqueue_host_mirror(plan);'],
        ['add', '194', '}'],
        ['context', '195', 'return plan;'],
      ],
      rationale: '缓存 descriptor 避免热路径重复分配；同步回退只保留在 host mirror 尚未就绪的边界场景。',
    },
    'plan_cache.hpp': {
      path: 'kernels/plan_cache.hpp', status: 'A',
      lines: [
        ['context', '1', '#pragma once'],
        ['add', '2', 'class PlanCache {'],
        ['add', '3', ' public:'],
        ['add', '4', '  Plan& get_or_build(Signature signature);'],
        ['add', '5', '  void enqueue_host_mirror(const Plan& plan);'],
        ['add', '6', '};'],
      ],
      rationale: '新增轻量 descriptor cache，将 plan 生命周期与请求 signature 绑定，避免重复构建。',
    },
    'paged_attention_cases.yaml': {
      path: 'tests/paged_attention_cases.yaml', status: 'T',
      lines: [
        ['context', '1', 'suite: paged_attention'],
        ['context', '2', 'platforms: [C500, CUDA]'],
        ['add', '3', 'correctness_cases: 24'],
        ['add', '4', 'shape: [1, 4, 128, 1024]'],
        ['add', '5', 'assert: max_abs_error <= 1e-3'],
      ],
      rationale: 'Correctness Gate 固定 24 个边界与回归用例，先通过正确性再进入性能阶段。',
    },
    'mla_paged_attention.yaml': {
      path: 'benchmarks/mla_paged_attention.yaml', status: 'B',
      lines: [
        ['context', '1', 'benchmark: mla_paged_attention'],
        ['context', '2', 'warmup: 50'],
        ['add', '3', 'repeats: 200'],
        ['add', '4', 'metric: latency_p50'],
        ['add', '5', 'environment_snapshot: fixed'],
      ],
      rationale: 'Benchmark 固定预热、重复次数与 Environment Snapshot，保证跨硬件结果可比。',
    },
  };
  const files = Object.fromEntries((remoteWorkspaceFiles || []).map((file) => [file.id, file]));
  const hasPatch = Object.keys(files).length > 0;
  const candidate = candidateEvaluations.find((item) => item.classification === 'accepted') || candidateEvaluations.find((item) => String(item.files || '').trim()) || candidateEvaluations[0] || null;
  const policyManaged = currentAction?.approvalRequired !== true;
  const activeFile = files[activeFileId] || files['paged_attention.cu'] || Object.values(files)[0];
  const toggleFolder = (folder) => setExpandedFolders((current) => ({ ...current, [folder]: !current[folder] }));
  const fileButton = (id, label, Icon = FileCode2) => <button className={`file-item ${activeFileId === id ? 'selected' : ''}`} onClick={() => setActiveFileId(id)}><Icon size={15} /> {label}<em>{files[id]?.status}</em></button>;
  const runPolicyCheck = async () => {
    if (!candidate || policyState === 'checking') return;
    setPolicyState('checking');
    const succeeded = await onApplyPatch(candidate.id);
    if (!succeeded) setPolicyState('failed');
  };
  useEffect(() => {
    if (!hasPatch || applied || paused || !policyManaged || autoCheckStarted.current) return undefined;
    autoCheckStarted.current = true;
    const timer = window.setTimeout(runPolicyCheck, 500);
    return () => window.clearTimeout(timer);
  }, [hasPatch, applied, paused, policyManaged, candidate?.id]);
  if (!hasPatch) return (
    <main className="page detail-page">
      <section className="detail-heading"><div><span className="detail-overline">CODE OPTIMIZATION / {candidate?.id || 'NO CANDIDATE'}</span><h1>{candidate?.title || '等待候选 Patch'}</h1><p>当前候选没有代码变更，因此不会进入 Patch 应用或人工审批。</p></div></section>
      <section className="candidate-no-patch"><Code2 size={27} /><div><span>AUTOMATION STATUS</span><h2>没有可执行的 Patch</h2><p>{candidate?.change || 'Agent 需要先生成包含文件清单和变更内容的 Candidate Plan。'} 当前流程保留在候选阶段，不会使用演示 Diff 代替真实产物。</p><div><em>代码变更：0</em><em>人工审批：不需要</em><em>下一步：重新运行 Agent 生成 Patch</em></div></div></section>
    </main>
  );
  return (
    <main className="page detail-page">
      <section className="detail-heading">
        <div><span className="detail-overline">CODE OPTIMIZATION / {candidate?.id}</span><h1>{candidate?.title}</h1><p>Patch 先经过路径、工作区和风险策略检查，通过后自动写入隔离工作区。</p></div>
        <div className="detail-actions"><button className={`primary-action ${applied ? 'done' : ''}`} disabled={paused || applied || policyState === 'checking'} onClick={runPolicyCheck}>{applied ? <><Check size={15} /> 已自动应用</> : policyState === 'checking' ? <><Activity size={15} /> 自动检查中</> : policyState === 'failed' ? <><TriangleAlert size={15} /> 重新运行检查</> : <><ShieldCheck size={15} /> 运行自动检查</>}</button></div>
      </section>

      <section className="code-workspace">
        <aside className="file-browser">
          <div className="workspace-caption"><span>REPOSITORY</span><strong>mla-kernels</strong></div>
          <button className="file-item folder" onClick={() => toggleFolder('kernels')}>{expandedFolders.kernels ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderGit2 size={15} /> kernels</button>
          {expandedFolders.kernels && <>{fileButton('paged_attention.cu', 'paged_attention.cu')}{fileButton('plan_cache.hpp', 'plan_cache.hpp')}</>}
          <button className="file-item folder" onClick={() => toggleFolder('tests')}>{expandedFolders.tests ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderGit2 size={15} /> tests</button>
          {expandedFolders.tests && fileButton('paged_attention_cases.yaml', 'paged_attention_cases.yaml')}
          <button className="file-item folder" onClick={() => toggleFolder('benchmarks')}>{expandedFolders.benchmarks ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderGit2 size={15} /> benchmarks</button>
          {expandedFolders.benchmarks && fileButton('mla_paged_attention.yaml', 'mla_paged_attention.yaml')}
          <div className="bridge-state"><Mark pulse /><span>Local Bridge</span><small>authorized</small></div>
        </aside>

        <article className="diff-editor">
          <div className="editor-bar"><span><FileCode2 size={15} /> {activeFile.path}</span><div><button className={diffMode === 'unified' ? 'active' : ''} onClick={() => setDiffMode('unified')}>Unified</button><button className={diffMode === 'split' ? 'active' : ''} onClick={() => setDiffMode('split')}>Split</button><button className="editor-more" aria-label="编辑器更多操作" onClick={() => onOpenModal('editorActions')}><MoreHorizontal size={17} /></button></div></div>
          <div className={`code-lines ${diffMode}`} aria-label="Code diff">
            {activeFile.lines.map(([type, line, code]) => <div className={type} key={`${line}-${code}`}><i>{line}</i><code>{code}</code></div>)}
          </div>
          <div className="editor-rationale"><Lightbulb size={16} /><div><span>AGENT RATIONALE</span><p>{activeFile.rationale}</p></div></div>
        </article>

        <aside className="review-summary">
          <div className="summary-group"><span>CHANGE BOUNDARY</span><dl><div><dt>Files</dt><dd>{Object.keys(files).length}</dd></div><div><dt>Commands</dt><dd>none</dd></div><div><dt>Risk</dt><dd className="risk">{currentAction?.risk || 'medium'}</dd></div></dl></div>
          <div className="summary-group"><span>AUTOMATIC POLICY CHECKS</span><ul><li><CheckCircle2 size={15} /> 候选与文件清单匹配</li><li><CheckCircle2 size={15} /> 变更路径位于隔离工作区</li><li><CheckCircle2 size={15} /> 未命中高风险人工介入规则</li></ul></div>
          <div className={`summary-note ${policyManaged ? 'automatic' : ''}`}><LockKeyhole size={15} /> {policyManaged ? '策略检查通过后自动应用并写入审计链，无需人工批准。' : '当前候选命中强制介入规则，需要人工处理。'}</div>
        </aside>
      </section>
    </main>
  );
}

function ExperimentsView({ benchmarkStatus, benchmarkProgress, benchmarkLogs, benchmarkResult, testMatrix, canRollback, onRunBenchmark, onRollbackStage, onOpenModal, paused }) {
  const complete = benchmarkStatus === 'complete';
  const running = benchmarkStatus === 'running';
  const liveEvidence = benchmarkResult?.environment?.liveHardware === true;
  const selectedEnvironments = testMatrix?.environments || ['C500', 'CUDA'];
  const visibleTasks = selectedEnvironments.map((platform, index) => ({
    id: `matrix-${String(platform).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${index + 1}`,
    platform,
    environment: platform,
    tone: String(platform).toUpperCase().includes('C500') ? 'green' : 'blue',
  }));
  const measuredByEnvironment = new Map((benchmarkResult?.benchmark || []).map((item) => [item.environment, item]));
  const measuredValues = [...measuredByEnvironment.values()].map((item) => item.value).filter((value) => Number.isFinite(value));
  const bestValue = measuredValues.length ? Math.min(...measuredValues) : null;
  const bestMeasurement = bestValue === null ? null : [...measuredByEnvironment.values()].find((item) => item.value === bestValue);
  const profilerMetrics = benchmarkResult?.profiler?.metrics || {};
  return (
    <main className="page detail-page">
      <section className="detail-heading">
        <div><span className="detail-overline">TEST PLAN / TPL_01JH7R</span><h1>跨环境验证</h1><p>同一候选被精确路由到两个固定环境，Correctness Gate 先于性能结论。</p></div>
        <div className="detail-actions">{canRollback && <button className="ghost-action recovery-action" disabled={paused} onClick={onRollbackStage}><History size={14} /> 返回补丁应用前</button>}<button className="ghost-action" disabled={paused || running} onClick={() => onOpenModal('matrix')}><SlidersHorizontal size={14} /> 编辑测试矩阵</button><button className={`primary-action ${complete ? 'done' : ''}`} disabled={paused || running || complete} onClick={onRunBenchmark}>{complete ? <><Check size={15} /> Benchmark 已完成</> : running ? <><Activity size={15} /> 运行中 {benchmarkProgress}%</> : <><Beaker size={14} /> 运行测试矩阵</>}</button></div>
      </section>

      <section className="experiment-hero">
        <div><span>TEST MATRIX</span><strong>{visibleTasks.length}</strong><small>environments</small></div>
        <div><span>CORRECTNESS</span><strong>{complete ? `${visibleTasks.reduce((sum, task) => sum + (measuredByEnvironment.get(task.platform)?.correctness?.total || 0), 0)}/${visibleTasks.reduce((sum, task) => sum + (measuredByEnvironment.get(task.platform)?.correctness?.passed ? measuredByEnvironment.get(task.platform)?.correctness?.total || 0 : 0), 0)}` : '—'}</strong><small>{complete ? 'cases passed' : 'awaiting test result'}</small></div>
        <div><span>ACTIVE RUNS</span><strong>{complete ? '0' : running ? `${Math.max(1, Math.ceil((100 - benchmarkProgress) / 50))}` : '0'}</strong><small>{complete ? 'all completed' : running ? 'leased workers' : 'ready to run'}</small></div>
        <div><span>BEST RESULT</span><strong>{complete && bestValue !== null ? bestValue : running ? `${benchmarkProgress}%` : '—'}</strong><small>{running ? 'benchmark progress' : bestMeasurement?.unit || 'awaiting result'}</small></div>
      </section>

      <section className="matrix-table">
        <div className="matrix-table-head"><span>Environment</span><span>Correctness</span><span>Probe</span><span>Full Benchmark</span><span>Result</span></div>
        {visibleTasks.map((task) => (
          <div className="matrix-table-row" key={task.id}>
            <div className="environment-name"><span className={`platform-sign ${task.tone}`}>{task.platform === 'C500' ? 'C5' : 'CU'}</span><span><strong>{task.environment}</strong><small>{task.id}</small></span></div>
            <div className={complete ? 'cell-pass' : 'cell-pending'}>{complete ? <><CheckCircle2 size={16} /> {measuredByEnvironment.get(task.platform)?.correctness?.passed ? `${measuredByEnvironment.get(task.platform)?.correctness?.total} / ${measuredByEnvironment.get(task.platform)?.correctness?.total}` : 'Failed'}</> : running ? <><Activity size={16} /> Collecting</> : <><CircleDot size={16} /> —</>}</div>
            <div className={complete ? 'cell-pass' : running ? 'cell-running' : 'cell-pending'}>{complete ? <><CheckCircle2 size={16} /> {measuredByEnvironment.get(task.platform)?.value ?? '—'} {measuredByEnvironment.get(task.platform)?.unit || ''}</> : running ? <><Activity size={16} /> Collecting</> : <><CircleDot size={16} /> —</>}</div>
            <div className={complete ? 'cell-pass' : running ? 'cell-running' : 'cell-pending'}>{complete ? <CheckCircle2 size={16} /> : running ? <Activity size={16} /> : <CircleDot size={16} />} {complete ? 'Completed' : running ? `${benchmarkProgress}%` : 'Ready'}</div>
            <div className="result-cell"><strong>{complete ? (measuredByEnvironment.get(task.platform)?.improvement || 'measured') : '—'}</strong><small>{complete ? `${measuredByEnvironment.get(task.platform)?.value ?? '—'} ${measuredByEnvironment.get(task.platform)?.unit || ''}` : running ? 'collecting' : 'waiting'}</small></div>
          </div>
        ))}
      </section>

      <section className="run-console" aria-label="Benchmark 执行日志">
        <div className="run-console-head"><div><span>RUN STREAM</span><strong>{running ? '正在收集执行日志' : complete ? '执行日志已归档' : '等待提交测试任务'}</strong></div><small>{benchmarkLogs.length ? `${benchmarkLogs.length} 条事件 · ${benchmarkStatus === 'complete' ? 'artifact persisted' : 'live polling'}` : '提交后显示真实任务状态'}</small></div>
        <div className="run-console-body">{benchmarkLogs.length ? benchmarkLogs.map((log) => <div key={log.sequence}><i>{String(log.sequence).padStart(2, '0')}</i><span className={log.progress === 100 ? 'done' : ''}>{log.message}</span><em>{log.progress}%</em></div>) : <div className="run-console-empty"><TerminalSquare size={15} />尚未提交 Run，测试日志会在服务端任务启动后出现。</div>}</div>
      </section>

      <section className="evidence-band">
        <ShieldCheck size={23} />
        <div><span>EVIDENCE POLICY</span><strong>{complete ? (liveEvidence ? '真实硬件证据已形成，可进入正式 Gate' : 'Mock 证据已形成，仅用于验证流程') : '正在收集 Benchmark / Tracer / Profiler'}</strong><p>{liveEvidence ? 'Run 已绑定真实 Environment Snapshot 与 Runner Adapter 版本，结果可审计、可复现。' : '当前测试服务未连接真实硬件；结果可以推动演示闭环，但不会标记为 Level 3 或发布正式知识。'}</p></div>
        <button className="text-link" onClick={() => onOpenModal('knowledgeEvidence')}>查看证据引用 <ArrowRight size={15} /></button>
      </section>
    </main>
  );
}

function DecisionView({ stage, decisionReview, currentBest, workflowRecovery, candidateEvaluations = defaultCandidateEvaluations, activeMission, onRollbackStage, onRevertAdoption, onOpenModal, onViewCuration, paused }) {
  const candidates = candidateEvaluations.filter((item) => ['accepted', 'eligible', 'reference'].includes(item.classification));
  const [selectedId, setSelectedId] = useState(candidates.find((candidate) => ['accepted', 'eligible'].includes(candidate.classification))?.id || currentBest?.candidateId || candidates[0]?.id);
  const [revertConfirm, setRevertConfirm] = useState(false);
  if (!candidates.length) return <main className="page detail-page"><section className="detail-heading"><div><span className="detail-overline">EFFECT DECISION</span><h1>暂无可决策候选</h1><p>候选必须由 Agent 生成，并在算子测试服务返回证据后才能进入效果决策。</p></div></section><section className="knowledge-empty"><ShieldCheck size={25} /><strong>等待候选与测试证据</strong><span>Accept Gate 不会使用预置性能数据作出结论。</span></section></main>;
  const selected = candidates.find((item) => item.id === selectedId) || candidates[0];
  const ready = stageOrder[stage] >= stageOrder.evidence;
  const reviewPending = decisionReview?.status === 'awaiting_review';
  const reviewResolved = decisionReview?.status === 'resolved';
  const adoptionReverted = decisionReview?.resolution?.outcome === 'reverted';
  const gateRules = selected.acceptGate?.rules || [];
  const gates = gateRules.length ? gateRules.map((rule) => ({
    label: rule.label,
    detail: `${rule.actual || '未形成'} / 要求：${rule.expected || '按策略检查'}`,
    passed: rule.passed === true,
    informational: rule.required === false,
  })) : [
    { label: '正确性门禁', detail: selected.correctness, passed: selected.correctness === '24 / 24' },
    { label: '性能目标', detail: selected.c500 == null ? '等待测试结果' : `${selected.c500}μs`, passed: selected.c500 != null && selected.c500 <= 45 },
    { label: '证据完整性', detail: selected.evidence, passed: Boolean(selected.evidence) },
  ];
  const allGatesPassed = selected.acceptGate ? selected.acceptGate.passed === true : gates.every((gate) => gate.passed || gate.informational);
  const decisionStatus = !ready ? '等待验证' : reviewPending ? '流程已阻塞' : adoptionReverted ? `已回退到 ${currentBest?.version || 'cnd.01'}` : reviewResolved ? '策略已自动执行' : allGatesPassed ? 'Accept Gate 通过' : '进入参考池';
  const decisionTone = !ready ? 'waiting' : reviewPending ? 'blocked' : adoptionReverted ? 'reverted' : reviewResolved ? 'completed' : allGatesPassed ? 'policy-ready' : 'attention';
  return (
    <main className="page detail-page decision-page">
      <section className="detail-heading">
        <div><span className="detail-overline">DECISION CONTROL / {activeMission?.id || 'CURRENT MISSION'}</span><h1>效果决策</h1><p>集中判断证据是否满足采用条件，并形成可审计、可回退的版本结论。</p></div>
        <div className="detail-actions"><button className="ghost-action" onClick={() => onOpenModal('events')}><History size={14} /> 查看审计链</button></div>
      </section>
      <section className="decision-hero">
        <div><span>{adoptionReverted ? 'CURRENT BEST' : 'SELECTED CANDIDATE'}</span><strong>{adoptionReverted ? currentBest?.version : selected.label}</strong><small>{adoptionReverted ? '上一稳定版本已恢复' : selected.title}</small></div>
        <div><span>BASELINE</span><strong>53.8 <em>μs</em></strong><small>C500 p50</small></div>
        <div><span>PROPOSED</span><strong className="metric-good">{selected.c500} <em>μs</em></strong><small>{selected.delta} vs baseline</small></div>
        <div className={`decision-hero-result ${decisionTone}`}><span>FLOW DECISION</span><strong>{decisionStatus}</strong><small>{reviewPending ? 'blocked by intervention' : 'adoption policy evaluated'}</small></div>
      </section>
      <section className="decision-workspace">
        <aside className="decision-candidates">
          <div className="decision-panel-heading"><span>CANDIDATE SET</span><strong>候选比较</strong></div>
          <div className="decision-candidate-group"><small>可采用 / 参考</small>{candidates.map((candidate) => <button key={candidate.id} className={`${selected.id === candidate.id ? 'selected' : ''} ${candidate.classification}`} onClick={() => setSelectedId(candidate.id)}><span className={`decision-candidate-status ${candidate.tone}`} /><span><strong>{candidate.label}</strong><small>{candidate.title}</small></span><em>{candidate.classification === 'reference' ? '参考' : `${candidate.c500}μs`}</em></button>)}</div>
          <div className="decision-candidate-note"><ShieldCheck size={15} /><span>失败运行已从候选比较中移除，负向经验见候选迭代页的失败记录。</span></div>
        </aside>
        <section className="decision-gates">
          <div className="decision-panel-heading"><span>EVIDENCE RESULT</span><strong>技术证据</strong><button onClick={() => onOpenModal('knowledgeEvidence')}>查看证据 <ArrowRight size={13} /></button></div>
          <div className="decision-gate-list">{gates.map((gate) => <div key={gate.label} className={gate.passed ? 'passed' : gate.informational ? 'waiting' : 'blocked'}><span>{gate.passed ? <CheckCircle2 size={17} /> : gate.informational ? <CircleDot size={17} /> : <TriangleAlert size={17} />}</span><div><strong>{gate.label}</strong><small>{gate.detail}</small></div><em>{gate.passed ? 'PASS' : gate.informational ? 'INFO' : 'BLOCKED'}</em></div>)}</div>
          <div className="decision-evidence-note"><FileText size={16} /><div><span>DECISION REPORT</span><strong>{selected.evidence}</strong><p>环境快照、Run 结果和 Patch digest 已固定，可回溯到原始工件。</p></div></div>
        </section>
        <aside className={`decision-risk-panel ${reviewPending ? 'review-pending' : ''}`}>
          <div className="decision-panel-heading"><span>DECISION POLICY</span><strong>{reviewPending ? '当前流程阻塞' : '自动采用策略'}</strong></div>
          {!reviewPending && !reviewResolved && <>
            <div className="decision-policy-summary"><span><ShieldCheck size={18} /></span><div><small>{decisionReview?.policy?.version || 'v1.0'} · ACCEPT GATE POLICY</small><strong>{allGatesPassed ? 'Accept Gate 通过，策略将自动执行' : '当前候选进入弱候选参考池'}</strong><p>{allGatesPassed ? '全部硬门禁通过后，系统会自动更新 current best 并触发知识维护，无需再点击采用按钮。' : '候选不会替换 current best，但会保留假设、Diff 和可复用的局部结果。'}</p></div></div>
            <div className="decision-signal-list">{(decisionReview?.signals || []).map((signal) => <div key={signal.id} className={signal.triggered ? 'triggered' : ''}><span>{signal.label}</span><strong>{signal.value}</strong><em>{signal.triggered ? 'BLOCK' : 'CLEAR'}</em></div>)}</div>
            <div className="decision-risk-list"><span><GitBranch size={14} /> Accept Gate 自动执行</span><span><LockKeyhole size={14} /> 所有结果写入审计链</span></div>
            <div className="decision-actions stacked"><div className={`decision-auto-state ${allGatesPassed ? 'ready' : 'reference'}`}><Activity size={14} /><span><strong>{allGatesPassed ? '等待策略引擎完成自动采用' : '已标记为弱候选参考'}</strong><small>{allGatesPassed ? '通过后自动更新 current best，用户无需确认。' : '不进入采用队列，可供后续 Agent 检索复用。'}</small></span></div><button className="text-recovery-action" disabled={paused} onClick={onRollbackStage} title="恢复补丁应用前的工作区检查点"><History size={13} /> 撤销当前补丁</button><small className="decision-recovery-hint">恢复检查点，当前验证结果与证据将失效</small></div>
          </>}
          {reviewPending && <div className="decision-intervention-summary"><span><TriangleAlert size={18} /></span><div><small>WORKFLOW BLOCKED</small><strong>存在待处理的任务级介入</strong><p>当前采用策略暂停执行。请从顶栏“人工介入”查看、处理或撤回意见。</p></div></div>}
          {reviewResolved && <div className={`decision-resolution-complete ${adoptionReverted ? 'reverted' : ''}`}><span>{adoptionReverted ? <History size={20} /> : <CheckCircle2 size={20} />}</span><div><small>{adoptionReverted ? 'RECOVERY COMPLETE' : 'ACCEPT GATE COMPLETE'}</small><strong>{adoptionReverted ? '上一稳定版本已恢复' : '策略已自动采用并写入审计链'}</strong><p>{adoptionReverted ? `${workflowRecovery?.lastRecovery?.from || '已采用候选'} 保留在审计链中，相关证据和知识版本已标记为被替代。` : decisionReview.resolution?.source === 'human_review' ? '人工处置意见已覆盖自动策略，候选与知识版本均已固化。' : 'Accept Gate 必需规则通过，系统自动更新 current best 并触发知识维护。'}</p></div><dl><div><dt>当前版本</dt><dd>{`${currentBest?.candidateId || selected.id} · ${currentBest?.version || selected.version}`}</dd></div><div><dt>{adoptionReverted ? '恢复检查点' : '决策来源'}</dt><dd>{adoptionReverted ? workflowRecovery?.lastRecovery?.checkpointId : decisionReview.resolution?.source === 'human_review' ? '人工处置' : 'Accept Gate 策略'}</dd></div></dl>{!adoptionReverted && <div className="decision-followup-actions"><button className="ghost-action" onClick={onViewCuration}><BookOpen size={14} /> 查看知识维护结果</button><div className="decision-revert-zone">{!revertConfirm ? <button className="ghost-action" disabled={paused} onClick={() => setRevertConfirm(true)}><History size={14} /> 回退到上一版本</button> : <><div><TriangleAlert size={15} /><span><strong>确认恢复上一稳定版本？</strong><small>{currentBest?.candidateId || selected.id} 的知识版本将标记为被替代。</small></span></div><div className="decision-actions"><button className="ghost-action" onClick={() => setRevertConfirm(false)}>取消</button><button className="danger-action" disabled={paused} onClick={onRevertAdoption}>确认回退</button></div></>}</div></div>}</div>}
        </aside>
      </section>
    </main>
  );
}

const getLibraryOptions = (library, category, currentValues = []) => {
  const options = library?.categories?.[category]?.options || [];
  const knownValues = new Set(options.map((option) => option.value));
  const legacy = currentValues.filter(Boolean).filter((value) => !knownValues.has(value)).map((value) => ({ value, label: value, code: 'legacy.unregistered' }));
  return [...options, ...legacy];
};

function ControlledSelect({ label, category, value, library, onChange, disabled, wide = false }) {
  const options = getLibraryOptions(library, category, [value]);
  const selected = options.find((option) => option.value === value);
  return <label className={`controlled-select ${wide ? 'wide' : ''}`}><span>{label}</span><select value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{selected?.code || '请选择已注册选项'}</small></label>;
}

function ControlledMultiChoice({ label, category, values, library, onChange, disabled, wide = false }) {
  const options = getLibraryOptions(library, category, values);
  const toggle = (value) => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  return <fieldset className={`controlled-multi ${wide ? 'wide' : ''}`}><legend>{label}</legend><div>{options.map((option) => <label key={option.value} className={values.includes(option.value) ? 'selected' : ''}><input type="checkbox" checked={values.includes(option.value)} disabled={disabled} onChange={() => toggle(option.value)} /><span><strong>{option.label}</strong><small>{option.code}</small></span></label>)}</div></fieldset>;
}

function CurationView({ drafts = defaultKnowledgeDrafts, publishedAssets, knowledgeMaintenance = defaultKnowledgeMaintenance, activeMission, onUpdateDraft, onViewLibrary, onOpenModal, optionLibrary = defaultKnowledgeOptionLibrary }) {
  const [activeDraftId, setActiveDraftId] = useState('exp.async-plan-cache');
  const [editorTab, setEditorTab] = useState('definition');
  if (!drafts.length) return <main className="page detail-page"><section className="detail-heading"><div><span className="detail-overline">KNOWLEDGE CURATION</span><h1>暂无待沉淀经验</h1><p>Agent 会在真实候选完成验证和决策后生成结构化知识草稿。</p></div></section><section className="knowledge-empty"><BookOpen size={25} /><strong>等待 Agent 产出知识草稿</strong><span>客户端不会把内置示例伪装成本次 Mission 的经验。</span></section></main>;
  const publishedIds = new Set((publishedAssets || []).filter((asset) => asset.status === 'published').map((asset) => asset.id));
  const simulationOnly = knowledgeMaintenance.changes?.some((change) => change.outcome === 'simulation_only');
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) || drafts[0];
  const activeChange = knowledgeMaintenance.changes?.find((change) => change.draftId === activeDraft.id);
  const published = publishedIds.has(activeDraft.id) || activeChange?.outcome === 'auto_published';
  const publishedCount = publishedIds.size;
  const updateDraft = (field, value) => onUpdateDraft(activeDraft.id, { [field]: value });
  const deriveScope = (draft) => [draft.hardware?.join(' / '), draft.operator, draft.dtype, draft.shape].filter(Boolean).join(' · ');
  const updateControlled = (field, value) => {
    const next = { ...activeDraft, [field]: value };
    onUpdateDraft(activeDraft.id, { [field]: value, scope: deriveScope(next) });
  };
  const dtypeValues = (activeDraft.dtype || '').split('/').map((item) => item.trim()).filter(Boolean);
  const procedureValues = toLines(activeDraft.procedure);
  const hasStructuredContext = (draft) => Boolean(draft.operator?.trim() && draft.scope?.trim() && draft.trigger?.trim() && draft.procedure?.trim());
  const hasEvidence = (draft) => Boolean(draft.validation?.trim() && draft.constraints?.trim() && draft.evidenceRefs?.length);
  const maintenanceComplete = knowledgeMaintenance.status === 'completed';
  const selectDraft = (id) => { setActiveDraftId(id); setEditorTab('definition'); };
  return (
    <main className="page detail-page curation-page">
      <section className="detail-heading">
        <div><span className="detail-overline">EXPERIENCE CURATOR / {activeMission?.id || 'CURRENT MISSION'}</span><h1>知识自动维护</h1><p>效果决策完成后，系统自动提取经验、查重合并、绑定证据并生成固定版本。</p></div>
        <div className="detail-actions"><button className="ghost-action" onClick={() => onOpenModal('optionLibrary')}><SlidersHorizontal size={14} /> 知识字段库</button><button className="ghost-action" onClick={() => onOpenModal('knowledgeEvidence')}><ShieldCheck size={14} /> 查看来源证据</button><button className="ghost-action" onClick={onViewLibrary}><BookOpen size={14} /> 查看知识库</button></div>
      </section>
      <section className="curation-status-band"><div className="curation-status-lead"><span>AUTOMATED KNOWLEDGE MAINTENANCE</span><strong>{maintenanceComplete ? (simulationOnly ? '仿真预览已生成' : '维护完成') : '等待决策触发'}</strong><small>{knowledgeMaintenance.triggerLabel}</small></div><div><span>正式发布</span><strong>{knowledgeMaintenance.summary?.autoPublished || 0} / {drafts.length}</strong><small>{simulationOnly ? 'Mock 证据不会进入正式知识库' : `${knowledgeMaintenance.summary?.matched || 0} 条合并 · ${knowledgeMaintenance.summary?.created || 0} 条新建`}</small></div><div><span>预览 / 例外</span><strong>{knowledgeMaintenance.summary?.reviewRequired || 0}</strong><small>{knowledgeMaintenance.summary?.reviewRequired ? '等待真实硬件证据' : '无需人工操作'}</small></div><div><span>发布策略</span><strong>{knowledgeMaintenance.policy?.version || 'v2.1'}</strong><small>{knowledgeMaintenance.policy?.label}</small></div></section>
      <section className="curation-workspace">
        <aside className="curation-source-panel">
          <div className="curation-panel-heading"><span>CHANGE SET</span><strong>本次知识变更</strong><em>{publishedCount}/{drafts.length}</em></div>
          <nav className="curation-draft-list" aria-label="本次知识维护结果">
            {drafts.map((draft) => {
              const change = knowledgeMaintenance.changes?.find((item) => item.draftId === draft.id);
              const isPublished = publishedIds.has(draft.id) || change?.outcome === 'auto_published';
              return <button key={draft.id} className={activeDraft.id === draft.id ? 'selected' : ''} onClick={() => selectDraft(draft.id)}><span className={`curation-draft-icon ${isPublished ? 'published' : ''}`}>{isPublished ? <Check size={14} /> : <Lightbulb size={14} />}</span><span><small>{draft.code} · {change?.action === 'update' ? '合并更新' : '新建资产'}</small><strong>{draft.title}</strong><em>{change?.nextVersion || '待版本化'} · {isPublished ? '自动发布' : change?.outcome === 'simulation_only' ? '仿真预览' : '等待策略'}</em></span><ChevronRight size={14} /></button>;
            })}
          </nav>
          <div className="curation-lineage-summary"><ShieldCheck size={15} /><div><strong>{simulationOnly ? 'Mock 只验证知识维护链路' : '决策触发，不依赖人工发布'}</strong><small>{simulationOnly ? 'simulation evidence · preview only' : 'decision.adopted · Level 3 evidence · fixed versions'}</small></div></div>
          <button className="text-link" onClick={() => onOpenModal('events')}>查看自动维护审计记录 <ArrowRight size={14} /></button>
        </aside>
        <section className="curation-editor-panel">
          <div className="curation-panel-heading"><span>STRUCTURED EXPERIENCE / {activeDraft.code}</span><strong>{activeDraft.category}</strong><em>{published ? `${activeChange?.nextVersion || '固定版本'} · 自动维护` : '等待策略处理'}</em></div>
          <nav className="curation-editor-tabs" aria-label="经验编辑层级">
            {[['definition', '01', '适用定义'], ['playbook', '02', '执行准则'], ['evidence', '03', '证据治理']].map(([id, number, label]) => <button key={id} className={editorTab === id ? 'active' : ''} onClick={() => setEditorTab(id)}><small>{number}</small><span>{label}</span>{id === 'definition' ? <CheckCircle2 size={13} /> : id === 'playbook' && hasStructuredContext(activeDraft) ? <CheckCircle2 size={13} /> : id === 'evidence' && hasEvidence(activeDraft) ? <CheckCircle2 size={13} /> : <CircleDot size={13} />}</button>)}
          </nav>
          {editorTab === 'definition' && <div className="curation-editor-stage">
            <label className="wide"><span>经验标题</span><input value={activeDraft.title || ''} disabled={published} onChange={(event) => updateDraft('title', event.target.value)} /></label>
            <label className="wide"><span>核心结论</span><textarea value={activeDraft.conclusion || ''} disabled={published} onChange={(event) => updateDraft('conclusion', event.target.value)} /></label>
            <ControlledSelect label="算子" category="operators" value={activeDraft.operator || ''} library={optionLibrary} disabled={published} onChange={(value) => updateControlled('operator', value)} />
            <ControlledSelect label="数据布局" category="layouts" value={activeDraft.layout || ''} library={optionLibrary} disabled={published} onChange={(value) => updateControlled('layout', value)} />
            <ControlledMultiChoice label="数据类型" category="dtypes" values={dtypeValues} library={optionLibrary} disabled={published} onChange={(values) => updateControlled('dtype', values.join(' / '))} wide />
            <ControlledSelect label="Shape 桶" category="shapes" value={activeDraft.shape || ''} library={optionLibrary} disabled={published} onChange={(value) => updateControlled('shape', value)} />
            <ControlledSelect label="Runtime / 驱动配置" category="runtimes" value={activeDraft.runtime || ''} library={optionLibrary} disabled={published} onChange={(value) => updateControlled('runtime', value)} />
            <ControlledMultiChoice label="适配硬件" category="hardware" values={activeDraft.hardware || []} library={optionLibrary} disabled={published} onChange={(values) => updateControlled('hardware', values)} wide />
            <div className="derived-scope wide"><ShieldCheck size={15} /><div><span>自动生成的适用范围</span><strong>{deriveScope(activeDraft)}</strong></div><em>DERIVED</em></div>
          </div>}
          {editorTab === 'playbook' && <div className="curation-editor-stage">
            <ControlledSelect label="触发条件 / 问题特征" category="triggers" value={activeDraft.trigger || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('trigger', value)} wide />
            <ControlledMultiChoice label="执行步骤" category="procedures" values={procedureValues} library={optionLibrary} disabled={published} onChange={(values) => updateDraft('procedure', values.join('\n'))} wide />
            <ControlledSelect label="预期收益" category="gains" value={activeDraft.expectedGain || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('expectedGain', value)} wide />
            <ControlledSelect label="约束与回退" category="guardrails" value={activeDraft.constraints || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('constraints', value)} />
            <ControlledSelect label="禁用条件" category="contraindications" value={activeDraft.contraindications || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('contraindications', value)} />
            <ControlledSelect label="失败尝试与重开条件" category="failures" value={activeDraft.failedAttempts || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('failedAttempts', value)} wide />
          </div>}
          {editorTab === 'evidence' && <div className="curation-editor-stage">
            <ControlledSelect label="验证门禁" category="validations" value={activeDraft.validation || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('validation', value)} wide />
            <ControlledMultiChoice label="证据引用" category="evidence" values={activeDraft.evidenceRefs || []} library={optionLibrary} disabled={published} onChange={(values) => updateDraft('evidenceRefs', values)} wide />
            <label><span>证据等级</span><select value={activeDraft.evidenceLevel || 'Level 3'} disabled={published} onChange={(event) => updateDraft('evidenceLevel', event.target.value)}><option>Level 1</option><option>Level 2</option><option>Level 3</option></select></label>
            <label><span>置信度</span><select value={activeDraft.confidence || '高'} disabled={published} onChange={(event) => updateDraft('confidence', event.target.value)}><option>低</option><option>中</option><option>高</option></select></label>
            <ControlledSelect label="来源 Mission" category="missions" value={activeDraft.sourceMission || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('sourceMission', value)} />
            <ControlledSelect label="来源 Candidate" category="candidates" value={activeDraft.sourceCandidate || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('sourceCandidate', value)} />
            <ControlledSelect label="Git Commit" category="commits" value={activeDraft.sourceCommit || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('sourceCommit', value)} />
            <ControlledSelect label="维护者" category="owners" value={activeDraft.owner || ''} library={optionLibrary} disabled={published} onChange={(value) => updateDraft('owner', value)} />
          </div>}
        </section>
        <aside className="curation-publish-panel maintenance-panel">
          <div className="curation-panel-heading"><span>AUTOMATION PIPELINE</span><strong>自动维护流水线</strong><em>{maintenanceComplete ? 'COMPLETED' : 'PENDING'}</em></div>
          <div className={`maintenance-result ${maintenanceComplete ? 'completed' : ''}`}><span><Activity size={16} /></span><div><small>{knowledgeMaintenance.trigger}</small><strong>{maintenanceComplete ? (simulationOnly ? '仿真经验预览已生成' : '知识资产已自动更新') : '等待效果决策触发'}</strong><p>{maintenanceComplete ? (simulationOnly ? '结构化提取和查重流程已跑通；接入真实硬件证据后才会生成正式版本。' : `${knowledgeMaintenance.summary.autoPublished} 条经验已生成固定版本，无需人工发布。`) : '候选采用后将自动启动维护。'}</p></div></div>
          <div className="maintenance-steps">
            {(knowledgeMaintenance.steps || []).map((step, index) => <div key={step.id} className={`maintenance-step ${step.status}`}><span>{step.status === 'completed' ? <Check size={13} /> : index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}
          </div>
          <div className="maintenance-change-card">
            <span>{activeChange?.action === 'update' ? 'MATCHED ASSET' : 'NEW ASSET'}</span>
            <strong>{activeChange?.targetTitle || activeDraft.title}</strong>
            <div><em>{activeChange?.previousVersion || 'NEW'}</em><ArrowRight size={13} /><em>{activeChange?.nextVersion || 'PENDING'}</em></div>
            <p>{activeChange?.reason || '等待策略生成维护结果。'}</p>
            <small><ShieldCheck size={12} /> {activeChange?.scopeDelta || '等待范围校验'}</small>
          </div>
          <div className="maintenance-policy-note"><LockKeyhole size={14} /><div><strong>{knowledgeMaintenance.policy?.label}</strong><span>{knowledgeMaintenance.policy?.rule}</span><small>{knowledgeMaintenance.policy?.exception}</small></div></div>
          <button className="ghost-action maintenance-library-action" onClick={onViewLibrary}><BookOpen size={15} /> 在知识库中查看固定版本</button>
        </aside>
      </section>
    </main>
  );
}

function KnowledgeView({ catalog = knowledgeCatalog, setView, onOpenModal, missionContext, activeMission, references = [], onReference }) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hardwareFilter, setHardwareFilter] = useState('all');
  const [readinessFilter, setReadinessFilter] = useState('reusable');
  const [filterOpen, setFilterOpen] = useState(true);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [taskRerank, setTaskRerank] = useState(true);
  const normalizedQuery = query.trim().toLowerCase();
  const queryTokens = normalizedQuery.split(/[\s,，/·]+/).filter(Boolean);
  const getHardwareKeys = (asset) => asset.hardwareKeys || knowledgeHardwareMap[asset.id] || [];
  const structuredCatalog = catalog.map(normalizeKnowledgeAsset);
  const currentMissionId = activeMission?.id || 'MIS_01JH7R';
  const referenceIds = new Set(references.filter((item) => item.missionId === currentMissionId).map((item) => item.assetId));
  const missionHardware = (activeMission?.hardware || ['C500', 'CUDA']).map((item) => ({ C500: 'c500', CUDA: 'nvidia', 'ROCm MI300': 'amd' }[item])).filter(Boolean);
  const missionText = `${activeMission?.title || 'MLA Paged KV Cache'} ${activeMission?.goal || 'paged_attention small batch latency'} ${activeMission?.metric || 'latency p50'}`.toLowerCase();
  const scoreAsset = (asset) => {
    const assetHardware = getHardwareKeys(asset);
    const searchable = [asset.title, asset.description, asset.tags?.join(' '), asset.scope, asset.operator, asset.dtype, asset.layout, asset.shape, asset.runtime, asset.trigger, asset.procedure?.join(' '), asset.contraindications, asset.failedAttempts, asset.evidenceRefs?.join(' ')].join(' ').toLowerCase();
    const reasons = [];
    let score = 34;
    const hardwareMatches = assetHardware.filter((key) => missionHardware.includes(key));
    if (hardwareMatches.length) { score += 24; reasons.push(`覆盖当前任务的 ${hardwareMatches.map((key) => ({ c500: 'C500', nvidia: 'CUDA', amd: 'ROCm' }[key])).join(' / ')}`); }
    const contextTerms = ['paged_attention', 'attention', 'small batch', 'latency', 'fp16', 'bf16'].filter((term) => missionText.includes(term) && searchable.includes(term));
    if (contextTerms.length) { score += Math.min(18, contextTerms.length * 6); reasons.push(`命中算子与问题特征：${contextTerms.slice(0, 3).join(' · ')}`); }
    if (asset.evidenceLevel === 'Level 3') { score += 10; reasons.push('具备 Level 3 完整证据'); }
    if (asset.procedure?.length && asset.validation) { score += 8; reasons.push('包含执行步骤与验证门禁'); }
    if (referenceIds.has(asset.id) || asset.referenced) { score += 4; reasons.unshift('已被当前任务固定版本引用'); }
    queryTokens.forEach((token) => { if (searchable.includes(token)) score += 5; });
    return { asset, searchable, score: Math.min(98, score), reasons: reasons.slice(0, 3) };
  };
  const rankedAssets = structuredCatalog.map(scoreAsset);
  const visibleAssets = rankedAssets.filter(({ asset, searchable }) => {
    const matchesType = typeFilter === 'all' || asset.kind.toLowerCase() === typeFilter;
    const hardwareKeys = getHardwareKeys(asset);
    const matchesHardware = hardwareFilter === 'all' || (hardwareFilter === 'cross' ? hardwareKeys.length > 1 : hardwareKeys.includes(hardwareFilter));
    const isReferenced = referenceIds.has(asset.id) || asset.referenced;
    const matchesReadiness = readinessFilter === 'all' || (readinessFilter === 'reusable' && (asset.kind !== 'Experience' || (asset.procedure.length && asset.validation))) || (readinessFilter === 'level3' && asset.evidenceLevel === 'Level 3') || (readinessFilter === 'referenced' && isReferenced);
    return matchesType && matchesHardware && matchesReadiness && (!queryTokens.length || queryTokens.every((token) => searchable.includes(token)));
  }).sort((left, right) => taskRerank || queryTokens.length ? right.score - left.score : right.asset.updated.localeCompare(left.asset.updated));
  const typeOptions = [
    ['all', '全部', structuredCatalog.length],
    ['experience', 'Experience', structuredCatalog.filter((asset) => asset.kind === 'Experience').length],
    ['skill', 'Skill', structuredCatalog.filter((asset) => asset.kind === 'Skill').length],
    ['tool', 'Tool', structuredCatalog.filter((asset) => asset.kind === 'Tool').length],
  ];
  const hardwareOptions = [
    { value: 'all', vendor: 'HARDWARE SCOPE', label: '全部硬件', note: '完整组织目录', count: structuredCatalog.length },
    { value: 'c500', vendor: 'METAX', label: '沐曦 C500', note: 'MXMACA 1.4+ · Guide v3.2', count: structuredCatalog.filter((asset) => getHardwareKeys(asset).includes('c500')).length },
    { value: 'nvidia', vendor: 'NVIDIA', label: 'CUDA GPU', note: 'SM80 / SM90 · Guide v4.1', count: structuredCatalog.filter((asset) => getHardwareKeys(asset).includes('nvidia')).length },
    { value: 'amd', vendor: 'AMD', label: 'MI300 / ROCm', note: 'CDNA2 / CDNA3 · Guide v2.6', count: structuredCatalog.filter((asset) => getHardwareKeys(asset).includes('amd')).length },
    { value: 'cross', vendor: 'PORTABLE', label: '跨平台准则', note: 'Correctness / reproducibility', count: structuredCatalog.filter((asset) => getHardwareKeys(asset).length > 1).length },
  ];
  const readinessOptions = [['all', '全部状态'], ['reusable', '可直接复用'], ['level3', 'Level 3'], ['referenced', '当前任务已引用']];
  const capabilityCoverage = [
    { capability: '性能诊断', note: 'Timeline / Roofline', c500: ['18', 'verified'], nvidia: ['15', 'verified'], amd: ['9', 'verified'] },
    { capability: '候选生成', note: 'Kernel / Runtime', c500: ['12', 'verified'], nvidia: ['11', 'verified'], amd: ['5', 'partial'] },
    { capability: '正确性验证', note: 'Golden / Tolerance', c500: ['24/24', 'verified'], nvidia: ['24/24', 'verified'], amd: ['18/24', 'partial'] },
    { capability: '知识沉淀', note: 'Evidence linked', c500: ['L3', 'verified'], nvidia: ['L3', 'verified'], amd: ['L2', 'partial'] },
  ];
  const activeHardwareLabel = hardwareOptions.find((option) => option.value === hardwareFilter)?.label;
  return (
    <main className="page detail-page">
      <section className="detail-heading">
        <div><span className="detail-overline">KNOWLEDGE / ORGANIZATION SCOPE</span><h1>组织知识资产</h1><p>沉淀经过验证的经验、可执行 Skill 和受控 Tool，并绑定固定版本与证据链。</p></div>
        {missionContext && <div className="detail-actions"><button className="ghost-action" onClick={() => setView('mission')}>返回任务总览</button></div>}
      </section>

      <section className="knowledge-scale-band">
        <div className="knowledge-scale-lead"><span>ORGANIZATION CORPUS</span><strong>68</strong><small>跨项目可复用资产</small></div>
        <div><span>已验证</span><strong>52</strong><small>76% validation coverage</small></div>
        <div><span>证据引用</span><strong>326</strong><small>Run / Mission citations</small></div>
        <div><span>平台覆盖</span><strong>11</strong><small>C500 · CUDA · ROCm 等</small></div>
        <div><span>近 30 天新增</span><strong>+14</strong><small>6 位维护者贡献</small></div>
      </section>

      <section className="hardware-guide-band">
        <div className="hardware-guide-heading">
          <div><span>HARDWARE PLAYBOOKS</span><strong>硬件经验准则</strong></div>
          <div className="hardware-guide-meta"><small>按架构、Runtime 与编译栈限制知识适用边界</small><button onClick={() => setCoverageOpen((value) => !value)}>{coverageOpen ? '收起覆盖矩阵' : '查看覆盖矩阵'}<ChevronDown size={13} className={coverageOpen ? 'open' : ''} /></button></div>
        </div>
        <div className="hardware-guide-options">{hardwareOptions.map((option) => <button key={option.value} className={`${hardwareFilter === option.value ? 'active' : ''} ${option.value === 'c500' ? 'featured' : ''}`} onClick={() => setHardwareFilter(option.value)}><PlatformMark platform={option.value} /><span className="hardware-option-copy"><span>{option.vendor}</span><strong>{option.label}</strong><small>{option.note}</small></span><em>{option.count}<small> assets</small></em></button>)}</div>
        {coverageOpen && <div className="hardware-coverage" aria-label="硬件能力覆盖矩阵">
          <div className="hardware-coverage-head"><span>能力覆盖</span><span><PlatformMark platform="c500" />沐曦 C500</span><span><PlatformMark platform="nvidia" />CUDA GPU</span><span><PlatformMark platform="amd" />MI300 / ROCm</span></div>
          {capabilityCoverage.map((row) => <div className="hardware-coverage-row" key={row.capability}><span><strong>{row.capability}</strong><small>{row.note}</small></span>{['c500', 'nvidia', 'amd'].map((key) => <span key={key} className={row[key][1]}>{row[key][1] === 'verified' ? <CheckCircle2 size={14} /> : <CircleDot size={14} />}<strong>{row[key][0]}</strong><small>{row[key][1] === 'verified' ? '已验证' : '部分覆盖'}</small></span>)}</div>)}
          <div className="hardware-coverage-foot"><ShieldCheck size={14} /><span>统计基于固定版本资产及其有效证据引用，不以目录条目数量替代能力成熟度。</span></div>
        </div>}
      </section>

      <section className="knowledge-search"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="知识检索" placeholder="检索算子、dtype、shape、瓶颈、Runtime 或 Evidence ID" /><span>{queryTokens.length ? `${queryTokens.length} 个检索条件` : '结构化全文检索'}</span><button aria-label="筛选" className={filterOpen ? 'active' : ''} onClick={() => setFilterOpen((value) => !value)}><Filter size={17} /></button></section>
      {filterOpen && <div className="knowledge-filter-stack">
        <div className="knowledge-filter-bar"><span>资产类型</span>{typeOptions.map(([value, label, count]) => <button key={value} className={typeFilter === value ? 'active' : ''} onClick={() => setTypeFilter(value)}>{label}<em>{count}</em></button>)}<div className="filter-assurance"><ShieldCheck size={13} /> 固定版本优先</div></div>
        <div className="knowledge-filter-bar"><span>复用准备度</span>{readinessOptions.map(([value, label]) => <button key={value} className={readinessFilter === value ? 'active' : ''} onClick={() => setReadinessFilter(value)}>{label}</button>)}</div>
      </div>}

      <section className={`mission-match-band ${taskRerank ? 'active' : ''}`}>
        <div className="mission-match-icon"><Gauge size={19} /></div>
        <div><span>CURRENT MISSION CONTEXT</span><strong>{activeMission?.title || 'MLA Paged KV Cache'}</strong><small>{(activeMission?.hardware || ['C500', 'CUDA']).join(' / ')} · {activeMission?.metric || 'latency p50'} · {activeMission?.goal || 'small batch 固定开销优化'}</small></div>
        <button className={taskRerank ? 'active' : ''} onClick={() => setTaskRerank((value) => !value)}><SlidersHorizontal size={15} /> {taskRerank ? '按任务匹配' : '按更新时间'}</button>
      </section>

      <section className="knowledge-layout library-only">
        <div className="knowledge-list">
          <div className="list-caption"><span>{visibleAssets.length} 个可用资产 · {activeHardwareLabel}</span><em>{taskRerank ? '按适配度与证据强度排序' : '按最近更新排序'}</em></div>
          {visibleAssets.map(({ asset, score, reasons }) => {
            const AssetIcon = asset.icon;
            const assetHardware = getHardwareKeys(asset);
            const hardwareMeta = assetHardware.map((key) => ({ c500: 'C500', nvidia: 'CUDA', amd: 'ROCm' }[key])).join(' / ');
            const isReferenced = referenceIds.has(asset.id) || asset.referenced;
            const openAsset = () => onOpenModal('asset', { ...asset, hardwareLabel: assetHardware.map((key) => hardwareLabels[key]).join(' · '), matchReasons: reasons, matchScore: score, isReferenced });
            return <article className={`knowledge-row structured ${isReferenced ? 'featured' : ''}`} key={asset.id}>
              <span className={`knowledge-type ${asset.tone}`}><AssetIcon size={18} /></span>
              <div className="knowledge-row-main"><div className="asset-meta">{asset.kind.toUpperCase()} · {asset.version} · {hardwareMeta} · {asset.evidenceLevel}</div><h2>{asset.title}</h2><p>{asset.description}</p>{asset.kind === 'Experience' && <div className="asset-applicability"><span>{asset.operator}</span><span>{asset.dtype}</span><span>{asset.shape}</span><strong>{asset.expectedGain}</strong></div>}<div className="asset-match-reason"><ShieldCheck size={13} /><span>{reasons[0] || '适用范围与固定版本可被组织 Mission 检索'}</span></div><div className="asset-tags">{asset.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div></div>
              <div className="knowledge-row-actions"><span className="match-score"><small>任务适配</small><strong>{score}</strong><em>/100</em></span><button className="asset-open" aria-label={`打开 ${asset.kind}：${asset.title}`} onClick={openAsset}><ArrowRight size={16} /></button>{asset.kind === 'Experience' && <button className={`asset-reference ${isReferenced ? 'done' : ''}`} disabled={isReferenced} onClick={() => onReference(asset, reasons)}>{isReferenced ? <><Check size={13} /> 已引用</> : <><BookOpen size={13} /> 引用到任务</>}</button>}</div>
            </article>;
          })}
          {visibleAssets.length === 0 && <div className="knowledge-empty"><Search size={25} /><strong>未找到同时满足条件的资产</strong><span>可减少检索条件，或切换硬件和复用准备度。</span><button onClick={() => { setQuery(''); setTypeFilter('all'); setHardwareFilter('all'); setReadinessFilter('all'); }}>清除筛选</button></div>}
        </div>

      </section>
    </main>
  );
}

function Dialog({ title, eyebrow, children, onClose, width = '520px' }) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ '--dialog-width': width }} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header"><div><span>{eyebrow || 'OPERATOR STUDIO'}</span><h2>{title}</h2></div><button aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}

function SearchDialog({ onClose, onNavigate }) {
  const [query, setQuery] = useState('');
  const results = [
    { view: 'mission', icon: Grid2X2, title: '优化任务详情', meta: 'Mission · MIS_01JH7R' },
    { view: 'iterations', icon: History, title: 'MLA Paged KV Cache 迭代详情', meta: 'Candidate pool · Accept Gate' },
    { view: 'code', icon: Code2, title: 'Async plan descriptor cache', meta: 'Code · Candidate 02' },
    { view: 'experiments', icon: TestTube2, title: '跨环境验证', meta: 'Test plan · TPL_01JH7R' },
    { view: 'knowledge', icon: BookOpen, title: '短序列下优先量化固定开销', meta: 'Experience · validated' },
  ];
  const visible = results.filter((result) => !query.trim() || `${result.title} ${result.meta}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Dialog title="全局搜索" eyebrow="WORKSPACE SEARCH" onClose={onClose} width="600px">
      <div className="dialog-search"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、代码、实验或知识资产" /><kbd>ESC</kbd></div>
      <div className="dialog-results">{visible.map(({ view, icon: Icon, title, meta }) => <button key={title} className="dialog-result" onClick={() => onNavigate(view)}><span><Icon size={17} /></span><div><strong>{title}</strong><small>{meta}</small></div><ArrowRight size={15} /></button>)}{visible.length === 0 && <div className="dialog-empty">没有匹配的工作区内容</div>}</div>
      <div className="dialog-footnote"><Search size={13} /> 支持 Mission ID、候选名称、环境名称和 Experience 关键词。</div>
    </Dialog>
  );
}

function MatrixEditor({ onClose, initialValue, onSave }) {
  const [environments, setEnvironments] = useState(initialValue?.environments || ['C500', 'CUDA']);
  const [stages, setStages] = useState(initialValue?.stages || ['Correctness', 'Probe', 'Full Benchmark']);
  const toggle = (list, value, setter) => setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  return (
    <Dialog title="编辑测试矩阵" eyebrow="TEST PLAN · TPL_01JH7R" onClose={onClose} width="560px">
      <div className="editor-section"><span className="dialog-label">执行环境</span><div className="check-grid">{['C500', 'CUDA', 'ROCm MI300'].map((item) => <label key={item} className={`check-item ${item === 'ROCm MI300' ? 'disabled' : ''}`}><input type="checkbox" checked={environments.includes(item)} disabled={item === 'ROCm MI300'} onChange={() => toggle(environments, item, setEnvironments)} /><span>{item}</span><small>{item === 'ROCm MI300' ? 'offline' : 'online'}</small></label>)}</div></div>
      <div className="editor-section"><span className="dialog-label">验证阶段</span><div className="check-grid">{['Correctness', 'Probe', 'Full Benchmark'].map((item) => <label key={item} className="check-item"><input type="checkbox" checked={stages.includes(item)} onChange={() => toggle(stages, item, setStages)} /><span>{item}</span></label>)}</div></div>
      <div className="matrix-summary"><span>将创建 {environments.length * stages.length} 个 Test Task</span><small>Correctness Gate 会阻止未通过候选进入性能阶段。</small></div>
      <div className="dialog-actions"><button className="ghost-action" onClick={onClose}>取消</button><button className="primary-action" disabled={!environments.length || !stages.length} onClick={() => { onSave({ environments, stages }); onClose(); }}>保存矩阵</button></div>
    </Dialog>
  );
}

function KnowledgeEvidenceDrawer({ onClose, onNavigate, notify }) {
  const [selected, setSelected] = useState(missionKnowledge[0]);
  const Icon = selected.icon;
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="knowledge-drawer" role="dialog" aria-modal="true" aria-label="知识依据" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header">
          <div><span>MISSION CONTEXT · MIS_01JH7R</span><h2>知识依据</h2></div>
          <button aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="drawer-body">
          <section className="evidence-summary">
            <div className="evidence-summary-title"><div><span className="drawer-overline">本次判断由以下资产支持</span><strong>缓存 plan descriptor，并将 host mirror 移出热路径</strong></div><span className="verified-badge"><CheckCircle2 size={14} /> 已验证</span></div>
            <p>系统只展示和当前 Mission、候选补丁及运行环境直接相关的知识，长文档与原始日志保留在知识库中。</p>
            <div className="evidence-stat-grid"><div><strong>3</strong><span>引用资产</span></div><div><strong>2</strong><span>关联 Run</span></div><div><strong>100%</strong><span>固定版本</span></div></div>
          </section>

          <div className="knowledge-drawer-layout">
            <nav className="drawer-asset-list" aria-label="关联知识资产">
              <span className="drawer-section-label">关联资产</span>
              {missionKnowledge.map((item) => {
                const AssetIcon = item.icon;
                return <button key={item.source} className={selected.source === item.source ? 'selected' : ''} onClick={() => setSelected(item)}><span className={`drawer-asset-icon ${item.tone}`}><AssetIcon size={15} /></span><span><strong>{item.shortTitle}</strong><small>{item.kind} · {item.version}</small></span><ChevronRight size={14} /></button>;
              })}
            </nav>
            <section className="drawer-asset-detail">
              <div className="drawer-detail-type"><span className={`drawer-asset-icon ${selected.tone}`}><Icon size={16} /></span><span>{selected.kind.toUpperCase()} · {selected.version}</span></div>
              <h3>{selected.title}</h3>
              <p>{selected.reason}</p>
              <dl><div><dt>适用范围</dt><dd>{selected.scope}</dd></div><div><dt>证据状态</dt><dd>{selected.evidence}</dd></div><div><dt>来源标识</dt><dd>{selected.source}</dd></div></dl>
              <div className="drawer-detail-note"><ShieldCheck size={14} /><span>此资产已通过组织验证，仅允许授权 Mission 引用。</span></div>
            </section>
          </div>
        </div>
        <footer className="drawer-footer"><button className="ghost-action" onClick={() => { copyText(selected.source).then(() => notify('知识引用标识已复制。')); }}>复制引用</button><button className="primary-action" onClick={() => { onNavigate(); onClose(); }}>进入知识库 <ArrowRight size={14} /></button></footer>
      </aside>
    </div>
  );
}

function IterationDetailDrawer({ iteration, onClose, onNavigate, notify }) {
  const baseline = operatorIterations[0];
  const isFailureRecord = iteration.recordType === 'failure';
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="iteration-detail-drawer" role="dialog" aria-modal="true" aria-label={`${iteration.label} ${isFailureRecord ? '失败记录' : '迭代详情'}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header"><div><span>{isFailureRecord ? 'FAILURE RECORD · NOT A CANDIDATE' : 'OPERATOR ITERATION'} · {iteration.version}</span><h2>{iteration.label}</h2></div><button aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
        <div className="iteration-drawer-body">
          <section className="iteration-drawer-summary">
            <div><span className={`iteration-status ${iteration.tone}`}>{iteration.status}</span><h3>{iteration.title}</h3><p>{iteration.hypothesis}</p></div>
            <div className="iteration-drawer-delta"><span>相对基线</span><strong>{iteration.delta}</strong><small>{iteration.c500}μs on C500</small></div>
          </section>

          <section className="iteration-detail-section">
            <div className="iteration-detail-heading"><Gauge size={16} /><strong>跨硬件结果</strong></div>
            <div className="iteration-result-grid"><div><span>C500</span><small>{baseline.c500}μs baseline</small><strong>{iteration.c500}μs</strong></div><div><span>CUDA A100</span><small>{baseline.cuda}μs baseline</small><strong>{iteration.cuda ? `${iteration.cuda}μs` : isFailureRecord ? '未进入验证' : '运行中'}</strong></div><div><span>Correctness</span><small>required 24 / 24</small><strong>{iteration.correctness}</strong></div></div>
          </section>

          <section className="iteration-detail-section">
            <div className="iteration-detail-heading"><Code2 size={16} /><strong>优化假设与变更</strong></div>
            <div className="iteration-change-box"><p>{iteration.change}</p><span><GitBranch size={13} /> {iteration.files}</span></div>
          </section>

          <section className="iteration-detail-section">
            <div className="iteration-detail-heading"><ShieldCheck size={16} /><strong>证据与决策</strong></div>
            <div className={`iteration-decision-box ${iteration.tone}`}><div><span>DECISION</span><strong>{iteration.decision}</strong></div><p>{iteration.decisionReason}</p><small>{iteration.evidence}</small></div>
          </section>

          {isFailureRecord ? <>
            <section className="failure-detail-ledger"><div><span>失败 Gate</span><strong>{iteration.failure?.gate}</strong></div><div><span>错误指纹</span><code>{iteration.failure?.code}</code></div><div><span>受影响用例</span><strong>{iteration.failure?.affectedCases} cases</strong></div><div><span>处置</span><strong>退出候选池</strong></div></section>
            <section className="failure-experience-detail"><Lightbulb size={18} /><div><span>NEGATIVE EXPERIENCE · {iteration.extractedExperience?.status}</span><strong>{iteration.extractedExperience?.title}</strong><p>{iteration.extractedExperience?.rule}</p><small>{iteration.extractedExperience?.reuse}</small></div></section>
            <section className="failure-artifact-list"><span>保留的审计工件</span><div>{(iteration.retainedArtifacts || []).map((artifact) => <code key={artifact}>{artifact}</code>)}</div></section>
          </> : <section className="iteration-linked-knowledge"><BookOpen size={16} /><div><span>关联知识资产</span><strong>{iteration.knowledge}</strong></div><ChevronRight size={15} /></section>}
        </div>
        <footer className="drawer-footer"><button className="ghost-action" onClick={() => { copyText(`${iteration.label}: ${iteration.hypothesis}\n${iteration.decision}`); notify(`${iteration.label} 摘要已复制。`); }}>复制摘要</button>{isFailureRecord ? <button className="primary-action" onClick={onClose}>完成</button> : <><button className="ghost-action" onClick={() => { onNavigate('experiments'); onClose(); }}>查看验证</button><button className="primary-action" onClick={() => { onNavigate('code'); onClose(); }}>查看代码 <ArrowRight size={14} /></button></>}</footer>
      </aside>
    </div>
  );
}

function AssetDetailDialog({ asset, onClose, onReference, notify }) {
  const isExperience = asset.kind === 'Experience';
  const procedure = toLines(asset.procedure);
  const evidenceRefs = asset.evidenceRefs || [];
  return <Dialog title={asset.title} eyebrow={`${asset.kind} · ${asset.version} · ${asset.evidenceLevel || 'VERIFIED'}`} onClose={onClose} width="780px">
    <div className="asset-detail structured-detail">
      <div className="asset-detail-head"><CheckCircle2 size={18} /><span>已通过组织验证 · 固定版本 · {asset.confidence || '中'}置信度</span></div>
      <p className="asset-conclusion">{asset.description || '该资产已绑定适用范围与证据引用，可由授权 Mission 检索和复用。'}</p>
      {asset.matchReasons?.length > 0 && <div className="asset-match-panel"><Gauge size={18} /><div><span>MATCH EXPLANATION · {asset.matchScore}/100</span><strong>为什么匹配当前任务</strong><p>{asset.matchReasons.join('；')}</p></div></div>}

      {isExperience && <>
        <section className="asset-detail-section">
          <div className="asset-section-title"><span>01</span><div><small>APPLICABILITY</small><strong>适用判断</strong></div></div>
          <div className="asset-judgement-grid"><div><span>算子 / 数据类型</span><strong>{asset.operator}</strong><small>{asset.dtype}</small></div><div><span>Shape / Layout</span><strong>{asset.shape}</strong><small>{asset.layout}</small></div><div><span>Runtime 边界</span><strong>{asset.runtime}</strong><small>{asset.hardwareLabel}</small></div><div className="gain"><span>预期收益</span><strong>{asset.expectedGain}</strong><small>{asset.confidence}置信度 · {asset.evidenceLevel}</small></div></div>
          <div className="asset-trigger"><CircleDot size={15} /><div><span>何时使用</span><p>{asset.trigger}</p></div></div>
        </section>

        <section className="asset-detail-section">
          <div className="asset-section-title"><span>02</span><div><small>ACTION PLAYBOOK</small><strong>执行步骤</strong></div></div>
          <ol className="asset-procedure">{procedure.map((step, index) => <li key={`${index}-${step}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol>
        </section>

        <section className="asset-detail-section boundary-section">
          <div className="asset-section-title"><span>03</span><div><small>BOUNDARIES &amp; GATES</small><strong>边界与验证</strong></div></div>
          <div className="asset-boundary-grid"><div><span><ShieldCheck size={14} /> 验证门禁</span><p>{asset.validation}</p></div><div><span><TriangleAlert size={14} /> 禁用条件</span><p>{asset.contraindications}</p></div><div><span><LockKeyhole size={14} /> 约束与回退</span><p>{asset.constraints || '超出适用范围时回退 current best。'}</p></div><div><span><History size={14} /> 失败经验</span><p>{asset.failedAttempts}</p></div></div>
        </section>
      </>}

      <section className="asset-detail-section">
        <div className="asset-section-title"><span>{isExperience ? '04' : '01'}</span><div><small>EVIDENCE &amp; PROVENANCE</small><strong>证据与来源</strong></div></div>
        <div className="asset-evidence"><div className="asset-evidence-title"><span>EVIDENCE LINEAGE</span><strong>资产证据链</strong><em>可审计 · 可复现</em></div><div className="asset-evidence-flow"><div><i>01</i><span><small>MISSION</small><strong>{asset.sourceMission}</strong><em>{asset.owner}</em></span></div><ArrowRight size={15} /><div><i>02</i><span><small>RUN / EVIDENCE</small><strong>{evidenceRefs[1] || evidenceRefs[0] || 'verified run set'}</strong><em>{asset.validation}</em></span></div><ArrowRight size={15} /><div><i>03</i><span><small>CANDIDATE</small><strong>{asset.sourceCandidate}</strong><em>commit · {asset.sourceCommit}</em></span></div><ArrowRight size={15} /><div><i>04</i><span><small>KNOWLEDGE</small><strong>{asset.id}</strong><em>{asset.version} · fixed</em></span></div></div></div>
        {evidenceRefs.length > 0 && <div className="asset-reference-ledger"><span>Evidence refs</span><div>{evidenceRefs.map((reference) => <button key={reference} onClick={() => copyText(reference).then(() => notify(`已复制 ${reference}`))}><FileText size={12} />{reference}</button>)}</div></div>}
      </section>

      <dl><div><dt>适配硬件</dt><dd>{asset.hardwareLabel || '沐曦 MetaX C500 · NVIDIA CUDA · AMD ROCm'}</dd></div><div><dt>适用范围</dt><dd>{asset.scope || '按资产版本约束'}</dd></div><div><dt>执行权限</dt><dd>{asset.permissions || 'organization:read'}</dd></div><div><dt>验证记录</dt><dd>{asset.evidence || asset.validation || '固定版本验证'}</dd></div><div><dt>维护者 / 更新</dt><dd>{asset.owner || 'Knowledge Steward'} · {asset.updated || '2026-08-03'}</dd></div></dl>
      <div className="asset-detail-actions"><button className="ghost-action" onClick={() => { copyText(asset.id || asset.title).then(() => notify('资产标识已复制。')); }}>复制资产 ID</button>{isExperience && <button className="primary-action" disabled={asset.isReferenced} onClick={() => onReference(asset, asset.matchReasons || [])}>{asset.isReferenced ? <><Check size={14} /> 已引用到当前任务</> : <><BookOpen size={14} /> 引用到当前任务</>}</button>}<button className="ghost-action" onClick={onClose}>关闭</button></div>
    </div>
  </Dialog>;
}

function OptionLibraryDialog({ library = defaultKnowledgeOptionLibrary, onClose }) {
  const categories = Object.entries(library.categories || {});
  const [activeCategory, setActiveCategory] = useState(categories[0]?.[0] || 'operators');
  const active = library.categories?.[activeCategory] || { label: '选项', owner: 'Organization Admin', options: [] };
  const optionCount = categories.reduce((total, [, category]) => total + category.options.length, 0);
  return <Dialog title="知识字段库" eyebrow={`CONTROLLED VOCABULARY · ${library.schemaVersion}`} onClose={onClose} width="760px">
    <div className="option-library-summary"><div><span>字段分类</span><strong>{categories.length}</strong></div><div><span>启用选项</span><strong>{optionCount}</strong></div><div><span>Schema</span><strong>{library.schemaVersion}</strong></div><div><span>最近更新</span><strong>{library.updated}</strong></div></div>
    <div className="option-library-layout">
      <nav aria-label="知识字段分类">{categories.map(([key, category]) => <button key={key} className={activeCategory === key ? 'active' : ''} onClick={() => setActiveCategory(key)}><span>{category.label}</span><em>{category.options.length}</em><ChevronRight size={13} /></button>)}</nav>
      <section><header><div><span>FIELD DICTIONARY</span><strong>{active.label}</strong></div><small>{active.owner} · organization scope</small></header><div className="option-library-table"><div className="option-library-head"><span>显示名称</span><span>稳定代码</span><span>状态</span></div>{active.options.map((option) => <div className="option-library-row" key={option.code}><span><strong>{option.label}</strong><small>{option.value}</small></span><code>{option.code}</code><em><CheckCircle2 size={12} /> 启用</em></div>)}</div></section>
    </div>
    <div className="option-library-footer"><ShieldCheck size={14} /><span>organization scope</span><strong>{library.schemaVersion}</strong><span>由字段所有者审核</span></div>
  </Dialog>;
}

function HumanInterventionDrawer({ stage, decisionReview, paused, activeMission, candidateEvaluations = defaultCandidateEvaluations, currentBest, benchmarkStatus, testMatrix, onClose, onRequestReview, onResolveReview, onCancelReview }) {
  const request = decisionReview?.request;
  const pending = decisionReview?.status === 'awaiting_review';
  const resolved = decisionReview?.status === 'resolved';
  const decisionStage = request?.originStage || stage;
  const selectedCandidate = candidateEvaluations.find((candidate) => candidate.id === request?.candidateId) || candidateEvaluations.find((candidate) => candidate.id === currentBest?.candidateId) || candidateEvaluations.find((candidate) => ['accepted', 'eligible'].includes(candidate.classification)) || candidateEvaluations[0];
  const baselineCandidate = candidateEvaluations.find((candidate) => candidate.id === 'candidate-01');
  const hasEvidence = benchmarkStatus === 'complete' || ['evidence', 'curation', 'published'].includes(stage);
  const missionId = activeMission?.id || '当前 Mission';
  const missionTitle = activeMission?.title || '当前优化任务';
  const hardwareLabel = activeMission?.hardware?.join(' + ') || testMatrix?.environments?.join(' + ') || '目标硬件';
  const metricLabel = activeMission?.metric || '性能指标';
  const defaultOutcome = decisionStage === 'evidence' ? 'adopt' : decisionStage === 'validation' ? 'supplement' : 'redirect';
  const [activePanel, setActivePanel] = useState('overview');
  const [outcome, setOutcome] = useState(defaultOutcome);
  const [resolutionOutcome, setResolutionOutcome] = useState(request?.outcome || defaultOutcome);
  const [note, setNote] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const canCreate = Boolean(selectedCandidate) && !pending && !resolved && ['candidate', 'validation', 'evidence'].includes(stage);
  const availableOutcomes = {
    adopt: decisionStage === 'evidence',
    supplement: ['validation', 'evidence'].includes(decisionStage),
    redirect: ['candidate', 'validation', 'evidence'].includes(decisionStage),
  };
  const outcomeMeta = {
    adopt: { label: '采用候选', detail: '更新 current best，并启动知识自动维护', impact: `${selectedCandidate?.label || '当前候选'} 将成为 current best，关联经验进入版本化维护。`, icon: CheckCircle2 },
    supplement: { label: '补充验证', detail: '保留补丁，返回异构验证并刷新证据', impact: '当前采用结论暂停，验证矩阵重新开放执行。', icon: TestTube2 },
    redirect: { label: '调整优化方向', detail: '恢复候选检查点，依据新意见生成方案', impact: '补丁与后续证据失效，流程返回候选阶段。', icon: GitBranch },
  };
  useEffect(() => {
    if (!request) return;
    setResolutionOutcome(request.outcome || defaultOutcome);
    setResolutionNote('');
    setActivePanel('overview');
  }, [request?.requestedAt]);
  const submit = async () => {
    if (!selectedCandidate) return;
    setBusy(true);
    const accepted = await onRequestReview({ id: selectedCandidate.id }, { outcome, note: note.trim() });
    setBusy(false);
    if (accepted) { setNote(''); setActivePanel('overview'); }
  };
  const resolve = async () => {
    setBusy(true);
    const accepted = await onResolveReview(request, { outcome: resolutionOutcome, note: resolutionNote.trim() || request?.note });
    setBusy(false);
    if (accepted) onClose();
  };
  const cancel = async () => {
    setBusy(true);
    const accepted = await onCancelReview();
    setBusy(false);
    if (accepted) onClose();
  };
  const selectedOutcome = pending ? resolutionOutcome : outcome;
  const SelectedImpactIcon = outcomeMeta[selectedOutcome]?.icon || GitBranch;
  const stageSummary = stage === 'evidence' ? `Level 3 证据已完成，系统建议采用 ${selectedCandidate?.label || '当前候选'}。` : stage === 'validation' ? '候选补丁正在验证，当前尚不能更新 current best。' : stage === 'candidate' ? '候选方案仍可调整，尚未形成采用证据。' : '当前流程已经形成处理结论。';
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="intervention-drawer" role="dialog" aria-modal="true" aria-label="人工介入" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header intervention-header">
          <div><span>MISSION CONTROL · {missionId}</span><h2>{pending ? '处理人工介入' : '人工介入'}</h2></div>
          <div className="intervention-header-actions">{pending && <em>流程已阻塞</em>}<button aria-label="关闭" onClick={onClose}><X size={17} /></button></div>
        </header>
        <div className="intervention-context-strip">
          <div><span>介入对象</span><strong>{selectedCandidate?.label || '当前候选'}</strong><small>{selectedCandidate?.title || missionTitle}</small></div>
          <div><span>来源阶段</span><strong>{stageMeta[decisionStage]?.status || decisionStage}</strong><small>Mission {missionId}</small></div>
          <div><span>当前状态</span><strong>{pending ? '等待人工处置' : resolved ? '事项已结束' : '允许主动介入'}</strong><small>审计链完整保留</small></div>
        </div>
        <nav className="intervention-view-tabs" aria-label="人工介入视图">
          <button className={activePanel === 'overview' ? 'active' : ''} onClick={() => setActivePanel('overview')}><FileText size={14} /> 情况概览</button>
          <button className={activePanel === 'decision' ? 'active' : ''} disabled={resolved || (!pending && !canCreate)} onClick={() => setActivePanel('decision')}><ShieldCheck size={14} /> {pending ? '处置决定' : '介入意见'}</button>
        </nav>
        <div className="intervention-body">
          {activePanel === 'overview' && <div className="intervention-overview">
            <section className={`intervention-status-lead ${pending ? 'attention' : ''}`}><span>{pending ? <TriangleAlert size={19} /> : <ShieldCheck size={19} />}</span><div><small>{pending ? 'WORKFLOW REQUEST' : 'DECISION CONTEXT'}</small><strong>{pending ? `${outcomeMeta[request?.outcome]?.label || '人工介入'}请求待处理` : stageSummary}</strong><p>{pending ? '先核对候选、证据与影响，再选择接受原意见或给出新的处置。' : '以下信息来自当前 Mission 的候选、Benchmark 与 Decision Report。尚未形成证据时不会展示其他任务的指标。'}</p></div></section>
            <section className="intervention-metrics"><div><span>当前最佳</span><strong>{hasEvidence ? (baselineCandidate?.c500 != null ? `${baselineCandidate.c500}μs` : currentBest?.value || '—') : '待验证'}</strong><small>{metricLabel} · {hardwareLabel}</small></div><div><span>候选结果</span><strong>{hasEvidence && selectedCandidate?.c500 != null ? `${selectedCandidate.c500}μs` : '待验证'}</strong><small>{hasEvidence ? (selectedCandidate?.delta || '已形成') : '等待 Full Benchmark'}</small></div><div><span>正确性</span><strong>{hasEvidence ? (selectedCandidate?.correctness || '—') : '待验证'}</strong><small>{hardwareLabel}</small></div><div><span>证据</span><strong>{hasEvidence ? (selectedCandidate?.evidenceLevel || selectedCandidate?.evidence || '已形成') : '形成中'}</strong><small>{testMatrix?.environments?.length || 0} 个环境</small></div></section>
            <section className="intervention-info-section"><div className="intervention-info-heading"><span>策略信号</span><strong>采用前风险检查</strong></div><div className="intervention-signal-table">{(decisionReview?.signals || []).map((signal) => <div key={signal.id}><span>{signal.label}</span><strong>{signal.value}</strong><em className={signal.triggered ? 'blocked' : ''}>{signal.triggered ? 'BLOCK' : 'CLEAR'}</em></div>)}</div></section>
            <section className="intervention-info-section"><div className="intervention-info-heading"><span>影响范围</span><strong>执行不同指令会发生什么</strong></div><div className="intervention-consequence-list">{Object.entries(outcomeMeta).map(([key, item]) => <div key={key} className={!availableOutcomes[key] ? 'disabled' : ''}><span>{key === 'adopt' ? <CheckCircle2 size={15} /> : key === 'supplement' ? <TestTube2 size={15} /> : <GitBranch size={15} />}</span><div><strong>{item.label}</strong><small>{availableOutcomes[key] ? item.impact : '当前阶段尚不具备执行条件'}</small></div></div>)}</div></section>
            {pending && <section className="intervention-request-detail"><div><span>原请求</span><strong>{outcomeMeta[request?.outcome]?.label}</strong><em>{request?.submittedBy || 'Yilin Lu'} · {request?.requestedAt ? new Date(request.requestedAt).toLocaleString('zh-CN', { hour12: false }) : '刚刚'}</em></div><p>{request?.note}</p></section>}
            {resolved && <section className="intervention-resolution-note"><CheckCircle2 size={20} /><div><strong>当前没有待处理的人工介入</strong><p>上一项介入已形成“{outcomeMeta[decisionReview.resolution?.outcome]?.label || decisionReview.resolution?.outcome}”结论，详情保留在审计链。</p></div></section>}
            <div className="intervention-footer"><button className="ghost-action" onClick={onClose}>返回任务</button>{!resolved && (pending || canCreate) && <button className="primary-action" onClick={() => setActivePanel('decision')}><ArrowRight size={14} /> {pending ? '进入处置决定' : '填写介入意见'}</button>}</div>
          </div>}
          {activePanel === 'decision' && <section className="intervention-decision-panel">
            <div className="intervention-section-title"><div><span>{pending ? '处置决定' : '主动介入'}</span><strong>{pending ? '可以覆盖原请求并给出新的指令' : '选择希望流程执行的指令'}</strong></div><em>{pending ? 'RESPONSE' : 'NEW REQUEST'}</em></div>
            <div className="intervention-outcome-grid" role="group" aria-label={pending ? '人工介入处置结果' : '人工介入请求类型'}>{Object.entries(outcomeMeta).map(([key, item]) => { const Icon = item.icon; const selected = selectedOutcome === key; return <button key={key} className={selected ? 'selected' : ''} disabled={!availableOutcomes[key]} onClick={() => pending ? setResolutionOutcome(key) : setOutcome(key)}><span><Icon size={16} /></span><div><strong>{item.label}</strong><small>{item.detail}</small></div>{selected && <Check size={14} />}</button>; })}</div>
            <label className="intervention-note"><span>{pending ? '处理意见' : '介入原因与执行要求'}</span><textarea value={pending ? resolutionNote : note} onChange={(event) => pending ? setResolutionNote(event.target.value) : setNote(event.target.value)} disabled={paused || busy} aria-label={pending ? '处理意见' : '介入意见'} placeholder={pending ? '补充你的判断依据；留空则沿用原请求意见' : '说明为什么需要介入，以及希望 Agent 如何继续'} /></label>
            <div className="intervention-impact"><SelectedImpactIcon size={15} /><span><strong>{outcomeMeta[selectedOutcome]?.label}</strong><small>{outcomeMeta[selectedOutcome]?.impact}</small></span></div>
            <div className="intervention-footer">{pending ? <button className="ghost-action" disabled={paused || busy} onClick={cancel}><X size={14} /> 撤回原请求</button> : <button className="ghost-action" onClick={() => setActivePanel('overview')}><ArrowLeft size={14} /> 返回概览</button>}<button className="primary-action" disabled={paused || busy || (!pending && note.trim().length < 4)} onClick={pending ? resolve : submit}><LockKeyhole size={14} /> {busy ? '正在提交' : pending ? '提交处置决定' : '提交介入请求'}</button></div>
          </section>}
        </div>
      </aside>
    </div>
  );
}

function ProjectRepositoryDialog({ projects = [], activeProjectId, activeMission, onClose, onCreate, onSelectProject, onArchive, onDelete, onOpenMission, onSelectDirectory, onBrowseDirectories, onCreateDirectory, onInspectSources, onReinitialize, onBootstrapProject, busy }) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', root: '', defaultBranch: 'HEAD', initializeGit: true, gitUrl: '', gitRef: 'HEAD' });
  const [browser, setBrowser] = useState(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [layerInspect, setLayerInspect] = useState({});
  const [layerBusy, setLayerBusy] = useState(null);
  const [bootstrapDrafts, setBootstrapDrafts] = useState({});
  const browse = async (target = '') => {
    setBrowserBusy(true); setBrowserError('');
    try { setBrowser(await onBrowseDirectories(target)); } catch (error) { setBrowserError(error.message); }
    setBrowserBusy(false);
  };
  const selectDirectory = async () => {
    setBrowserBusy(true); setBrowserError('');
    try {
      const selection = await onSelectDirectory(draft.root);
      if (!selection.cancelled && selection.path) {
        setDraft((current) => ({ ...current, root: selection.path }));
        setBrowser(null);
      }
    } catch (error) {
      try {
        setBrowser(await onBrowseDirectories(draft.root));
        setBrowserError(`系统文件夹选择器未能打开，已切换到内置浏览：${error.message}`);
      } catch (fallbackError) {
        setBrowserError(`无法打开文件夹选择器：${fallbackError.message || error.message}`);
      }
    }
    setBrowserBusy(false);
  };
  const createFolder = async () => {
    if (!browser?.path || !newFolderName.trim()) return;
    setBrowserBusy(true); setBrowserError('');
    try {
      const created = await onCreateDirectory(browser.path, newFolderName.trim());
      setBrowser(created); setDraft((current) => ({ ...current, root: created.path })); setNewFolderName('');
    } catch (error) { setBrowserError(error.message); }
    setBrowserBusy(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!draft.root.trim()) return;
    if (!await onCreate(draft)) return;
    setDraft({ name: '', root: '', defaultBranch: 'HEAD', initializeGit: true, gitUrl: '', gitRef: 'HEAD' });
    setBrowser(null);
    setCreating(false);
  };
  const submitBootstrap = async (project) => {
    const current = bootstrapDrafts[project.id] || { gitUrl: '', gitRef: project.defaultBranch || 'HEAD' };
    if (!current.gitUrl?.trim()) return;
    const result = await onBootstrapProject(project, current);
    if (result?.projectId) {
      const inspection = await onInspectSources(project.id);
      setLayerInspect((state) => ({ ...state, [project.id]: inspection }));
      setBootstrapDrafts((state) => ({ ...state, [project.id]: { gitUrl: '', gitRef: project.defaultBranch || 'HEAD' } }));
    }
  };
  const inspectLayers = async (project) => {
    if (layerInspect[project.id]) { setLayerInspect((current) => ({ ...current, [project.id]: null })); return; }
    setLayerBusy(project.id);
    try { const result = await onInspectSources(project.id); setLayerInspect((current) => ({ ...current, [project.id]: result })); } catch (error) { setLayerInspect((current) => ({ ...current, [project.id]: { error: error.message } })); }
    setLayerBusy(null);
  };
  return <Dialog title="项目与仓库" eyebrow="PROJECT REGISTRY" onClose={onClose} width="560px">
    <div className="project-registry-dialog">
      <div className="project-registry-intro"><div><strong>项目代码分层管理</strong><span>第三方源码、实际迭代代码与 Mission Snapshot 严格分开管理；候选 Diff 只计算 Iteration Repository。</span></div><button className="ghost-action" onClick={() => setCreating((value) => !value)}>{creating ? <><X size={14} />取消</> : <><Plus size={14} />新建项目</>}</button></div>
      {creating && <form className="project-create-form" onSubmit={submit}>
        <label><span>项目名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：MLA Kernels" /></label>
        <label className="project-path-field"><span>项目根目录</span><div><input required value={draft.root} onChange={(event) => setDraft((current) => ({ ...current, root: event.target.value }))} placeholder="选择项目根目录或创建新目录" /><button type="button" className="browse-folder-action" disabled={browserBusy} onClick={selectDirectory}><FolderOpen size={14} />{browserBusy ? '正在打开' : '选择文件夹'}</button></div></label>
        {browser && <div className="folder-browser"><div className="folder-browser-head"><button type="button" className="icon-action" disabled={!browser.parent || browserBusy} title="返回上级目录" onClick={() => browse(browser.parent)}><ArrowLeft size={14} /></button><code title={browser.path}>{browser.path}</code><button type="button" className="ghost-action" onClick={() => { setDraft((current) => ({ ...current, root: browser.path })); setBrowser(null); }}><Check size={13} />选择此文件夹</button></div><div className="folder-browser-list">{browser.entries.map((entry) => <button type="button" key={entry.path} onClick={() => browse(entry.path)}><FolderOpen size={14} /><span>{entry.name}</span><ChevronRight size={13} /></button>)}{!browser.entries.length && <span className="folder-browser-empty">当前文件夹没有子目录</span>}</div><div className="folder-create-row"><input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="新文件夹名称" /><button type="button" className="ghost-action" disabled={browserBusy || !newFolderName.trim()} onClick={createFolder}><FolderPlus size={14} />创建并进入</button></div></div>}
        {browserError && <p className="folder-browser-error folder-browser-error-standalone">目录浏览失败：{browserError}</p>}
        <label><span>默认基线</span><input value={draft.defaultBranch} onChange={(event) => setDraft((current) => ({ ...current, defaultBranch: event.target.value }))} /></label>
        <label className="git-init-option"><input type="checkbox" checked={draft.initializeGit} onChange={(event) => setDraft((current) => ({ ...current, initializeGit: event.target.checked }))} /><span><strong>创建三层目录并初始化迭代仓库</strong><small>自动创建 repository、sources、Mission Snapshots 和 artifacts；仅 repository 建立 Git 基线。</small></span></label>
        <div className="repository-bootstrap-panel">
          <div><GitPullRequestArrow size={15} /><span><strong>从 Git URL 拉取初始基线</strong><small>留空则只登记本地仓库；填写后会把代码拉入空的 repository 目录。</small></span></div>
          <label><span>Git URL</span><input value={draft.gitUrl} onChange={(event) => setDraft((current) => ({ ...current, gitUrl: event.target.value }))} placeholder="https://example.com/team/repo.git" /></label>
          <label><span>Branch / Commit</span><input value={draft.gitRef} onChange={(event) => setDraft((current) => ({ ...current, gitRef: event.target.value }))} placeholder="main 或具体 commit" /></label>
        </div>
        <button className="primary-action" disabled={busy || !draft.root.trim()} type="submit">{busy ? '正在初始化项目' : '创建项目'}</button>
      </form>}
      <div className="project-registry-list">{projects.map((project) => { const current = project.id === activeProjectId; const strict = project.layout === 'three-layer' && project.root && project.sourceRoot && project.runtimeRoot; const inspected = layerInspect[project.id]; const layers = inspected?.layers || {}; const sources = inspected?.inspection?.sources || []; const sourceReady = inspected?.inspection?.ready; const repositoryInspection = inspected?.repositoryInspection; const baselineEmpty = repositoryInspection?.ready && repositoryInspection.baselineEmpty; const bootstrapDraft = bootstrapDrafts[project.id] || { gitUrl: '', gitRef: project.defaultBranch || 'HEAD' }; return <article key={project.id} className={current ? 'current' : ''}><button type="button" className="project-registry-select" disabled={busy || current} onClick={() => onSelectProject(project)}><span className="project-registry-mark"><FolderGit2 size={17} /></span><span className="project-registry-copy"><strong>{project.name}</strong><code>{project.repository}</code><small>{current ? `当前项目${activeMission?.projectId === project.id ? ` · Mission ${activeMission.id}` : ''}` : `${project.missionCount || 0} 个 Mission`} · {strict ? '三层结构' : '需要重新初始化'}{project.repositoryBootstrap?.head ? ` · ${project.repositoryBootstrap.head}` : ''}</small></span><span className="project-registry-switch">{current ? <><Check size={14} />当前</> : <>切换<ChevronRight size={14} /></>}</span></button><div className="project-registry-actions">{strict ? <button className="ghost-action" disabled={layerBusy === project.id} onClick={() => inspectLayers(project)}><Layers3 size={14} />{layerBusy === project.id ? '检查中' : inspected ? '收起结构' : '查看三层结构'}</button> : <button className="ghost-action reinitialize" disabled={busy} onClick={() => onReinitialize(project)}><Layers3 size={14} />重新初始化</button>}{current && project.missionCount > 0 && <button className="ghost-action" onClick={onOpenMission}>进入 Mission</button>}{project.status === 'active' && <button className="icon-action" title="归档项目" onClick={() => onArchive(project)}><Archive size={15} /></button>}{!project.missionCount && <button className="icon-action danger" title="删除项目" onClick={() => onDelete(project)}><Trash2 size={15} /></button>}</div>{inspected && <div className="project-layer-inspector">{inspected.error ? <p className="project-layer-error">结构检查失败：{inspected.error}</p> : <><div className="project-layer-grid"><div><span>项目根目录</span><code>{layers.root}</code></div><div><span>Iteration Repository</span><code>{layers.repository}</code></div><div><span>Repository 基线</span><code>{repositoryInspection?.ready ? `${repositoryInspection.trackedFiles || 0} files · ${repositoryInspection.head || 'HEAD'}` : (repositoryInspection?.detail || '未检查')}</code></div><div><span>Source Registry</span><code>{layers.sources}</code></div><div><span>Mission Snapshot</span><code>{layers.activeSnapshot || '尚未创建'}</code></div><div><span>Artifacts</span><code>{layers.artifacts}</code></div></div>{baselineEmpty && <div className="repository-bootstrap-panel compact"><div><GitPullRequestArrow size={15} /><span><strong>当前基线为空，需要补齐真实代码</strong><small>请输入权威 Git URL 和分支或提交，系统会拉取到空的 Iteration Repository 并重建 Mission Snapshot。</small></span></div><label><span>Git URL</span><input value={bootstrapDraft.gitUrl} onChange={(event) => setBootstrapDrafts((state) => ({ ...state, [project.id]: { ...bootstrapDraft, gitUrl: event.target.value } }))} placeholder="https://example.com/team/repo.git" /></label><label><span>Branch / Commit</span><input value={bootstrapDraft.gitRef} onChange={(event) => setBootstrapDrafts((state) => ({ ...state, [project.id]: { ...bootstrapDraft, gitRef: event.target.value } }))} placeholder="main 或具体 commit" /></label><button className="primary-action" disabled={busy || !bootstrapDraft.gitUrl.trim()} onClick={() => submitBootstrap(project)}><GitPullRequestArrow size={14} />补齐基线</button></div>}<div className="project-source-status"><strong>第三方来源 {sources.length} 个</strong><em className={sourceReady ? 'clean' : 'dirty'}>{sourceReady ? '可作为固定引用' : '存在问题，阻止候选'}</em>{sources.length ? sources.map((source) => <span key={`${source.id}-${source.commit}`}><b>{source.id}</b><code>{source.commit?.slice(0, 12) || '无 Commit'}</code><small>{source.clean ? 'clean' : `${source.changedFiles?.length || 0} 个未提交变更`}</small></span>) : <small>Codex 尚未登记第三方仓库</small>}</div></>}</div>}</article>; })}</div>
      <div className="project-registry-note"><ShieldCheck size={14} /><span>有运行中或历史 Mission 的项目不能删除，只能归档，保证 Patch、Run 和审计记录可追溯。</span></div>
    </div>
  </Dialog>;
}

function ModalLayer({ modal, closeModal, setView, notify, testMatrix, onSaveMatrix, unreadCount, onMarkNotifications, workspace, onWorkspaceChange, missionPaused, onTogglePause, auditEvents, onReferenceKnowledge, optionLibrary, stage, decisionReview, activeProjectId, activeMission, candidateEvaluations, currentBest, benchmarkStatus, onRequestReview, onResolveReview, onCancelReview, projects, onCreateProject, onSelectProject, onArchiveProject, onDeleteProject, onOpenMission, onSelectDirectory, onBrowseDirectories, onCreateDirectory, onInspectSources, onReinitializeProject, onBootstrapProject, projectBusy }) {
  if (!modal) return null;
  if (modal.type === 'intervention') return <HumanInterventionDrawer stage={stage} decisionReview={decisionReview} paused={missionPaused} activeMission={activeMission} candidateEvaluations={candidateEvaluations} currentBest={currentBest} benchmarkStatus={benchmarkStatus} testMatrix={testMatrix} onClose={closeModal} onRequestReview={onRequestReview} onResolveReview={onResolveReview} onCancelReview={onCancelReview} />;
  if (modal.type === 'search') return <SearchDialog onClose={closeModal} onNavigate={(view) => { setView(view); closeModal(); }} />;
  if (modal.type === 'matrix') return <MatrixEditor onClose={closeModal} initialValue={testMatrix} onSave={(value) => { onSaveMatrix(value); notify(`测试矩阵已更新：${value.environments.length} 个环境，${value.stages.length} 个阶段。`); }} />;
  if (modal.type === 'knowledgeEvidence') return <KnowledgeEvidenceDrawer onClose={closeModal} onNavigate={() => setView('knowledge')} notify={notify} />;
  if (modal.type === 'iterationDetail') return <IterationDetailDrawer iteration={modal.iteration} onClose={closeModal} onNavigate={setView} notify={notify} />;
  if (modal.type === 'optionLibrary') return <OptionLibraryDialog library={optionLibrary} onClose={closeModal} />;
  if (modal.type === 'notifications') return <Dialog title="通知中心" eyebrow="NOTIFICATIONS" onClose={closeModal} width="460px"><div className="notification-list"><div className={unreadCount > 0 ? 'unread' : ''}><span className="notification-dot blue" /><p><strong>Candidate 02 等待你的审批</strong><small>Mission MIS_01JH7R · 3 分钟前</small></p><em>{unreadCount > 0 ? '待处理' : '已读'}</em></div><div><span className="notification-dot green" /><p><strong>C500 Worker 已完成 Correctness</strong><small>Test task tsk.c500-prod-01 · 18 分钟前</small></p><em>已读</em></div><div><span className="notification-dot gray" /><p><strong>Profile timeline Tool 发布新版本</strong><small>v1.8.0 · 昨天</small></p><em>已读</em></div></div><div className="dialog-actions"><button className="ghost-action" disabled={!unreadCount} onClick={() => { onMarkNotifications(); notify('通知已全部标记为已读。'); }}>全部标记已读</button><button className="primary-action" onClick={closeModal}>完成</button></div></Dialog>;
  if (modal.type === 'repository') return <ProjectRepositoryDialog projects={projects} activeProjectId={activeProjectId} activeMission={activeMission} onClose={closeModal} onCreate={onCreateProject} onSelectProject={onSelectProject} onArchive={onArchiveProject} onDelete={onDeleteProject} onOpenMission={onOpenMission} onSelectDirectory={onSelectDirectory} onBrowseDirectories={onBrowseDirectories} onCreateDirectory={onCreateDirectory} onInspectSources={onInspectSources} onReinitialize={onReinitializeProject} onBootstrapProject={onBootstrapProject} busy={projectBusy} />;
  if (modal.type === 'user') return <Dialog title="个人中心" eyebrow="ACCOUNT" onClose={closeModal} width="420px"><div className="profile-detail"><span className="profile-large">YL</span><div><strong>Yilin Lu</strong><span>算子工程师 · 本地项目模式</span><small>Local Codex Runtime</small></div></div><div className="profile-menu"><button onClick={() => { notify('个人偏好已打开。'); closeModal(); }}><Settings2 size={16} /> 个人偏好 <ChevronRight size={15} /></button><button onClick={() => { notify('已复制当前用户 ID。'); closeModal(); }}><Copy size={16} /> 复制用户 ID <ChevronRight size={15} /></button><button className="danger" onClick={() => { notify('本地 Runtime 不提供组织身份登录。'); closeModal(); }}><LogOut size={16} /> 断开本地会话 <ChevronRight size={15} /></button></div></Dialog>;
  if (modal.type === 'missionActions') {
    const missionId = activeMission?.id || 'unknown-mission';
    const measurements = activeMission?.benchmark?.result?.benchmark || [];
    const summary = [`Mission ${missionId}`, activeMission?.title || 'Untitled mission', ...measurements.map((item) => `${item.environment}: ${item.value}${item.unit}`)].join('\n');
    return <Dialog title="任务操作" eyebrow={`MISSION ${missionId}`} onClose={closeModal} width="430px"><div className="action-list"><button onClick={() => { copyText(missionId).then(() => notify('Mission ID 已复制。')); closeModal(); }}><Copy size={16} /><div><strong>复制 Mission ID</strong><small>用于问题反馈或工程协作</small></div><ChevronRight size={15} /></button><button onClick={() => { downloadText(`${missionId}-summary.txt`, summary); notify('任务摘要已下载。'); closeModal(); }}><Download size={16} /><div><strong>导出任务摘要</strong><small>包含当前任务和测试测量值</small></div><ChevronRight size={15} /></button><button onClick={() => { onTogglePause(); notify(missionPaused ? 'Mission 已恢复，可继续提交操作。' : 'Mission 已暂停，新的 Agent Action 与测试提交已停止。'); closeModal(); }}><Pause size={16} /><div><strong>{missionPaused ? '恢复 Mission' : '暂停 Mission'}</strong><small>切换新的 Agent Action 与测试提交</small></div><ChevronRight size={15} /></button></div></Dialog>;
  }
  if (modal.type === 'events') return <Dialog title="事件记录" eyebrow="AUDIT TRAIL · MIS_01JH7R" onClose={closeModal} width="640px"><div className="event-log">{(auditEvents?.length ? auditEvents : [{ time: '10:42:23', title: 'Policy Engine 等待代码审批', detail: 'approval.apl_01JH7R · patch apply', tone: 'warning', icon: ShieldCheck }, { time: '10:42:19', title: 'Candidate Agent 生成 Candidate 02', detail: '2 files · +37 −18 · digest recorded', tone: 'blue', icon: Code2 }, { time: '10:42:11', title: 'Research Agent 引用固定开销 Experience', detail: 'exp.short-seq.fixed-overhead@1.2 · validated', tone: 'green', icon: Search }]).map((event) => { const iconMap = { Activity, ShieldCheck, Code2, Search, CheckCircle2, TestTube2, TriangleAlert, BookOpen }; const EventIcon = typeof event.icon === 'string' ? (iconMap[event.icon] || Activity) : (event.icon || Activity); return <div key={`${event.time}-${event.title}`}><time>{event.time}</time><span className={`event-symbol ${event.tone || 'blue'}`}><EventIcon size={14} /></span><p><strong>{event.title}</strong><small>{event.detail}</small></p></div>; })}</div></Dialog>;
  if (modal.type === 'stageDetail') return <Dialog title={`${modal.stage.label}阶段`} eyebrow={`STAGE ${modal.stage.number} · ${modal.state}`} onClose={closeModal} width="430px"><div className="stage-detail"><div className="stage-detail-icon"><CheckCircle2 size={22} /></div><h3>{modal.stage.caption}</h3><p>{modal.state === '已完成' ? '该阶段已满足进入下一阶段的条件，相关事件和产物已写入 Mission 审计链。' : modal.state === '进行中' ? 'Agent 正在执行当前阶段动作，完成后会产生新的可审查产物。' : '该阶段尚未开始，前置证据完成后才会自动解锁。'}</p><div className="stage-detail-meta"><span>状态</span><strong>{modal.state}</strong><span>输出</span><strong>{modal.stage.id === 'validation' ? 'Test Plan / Run' : modal.stage.id === 'evidence' ? 'Decision Report' : 'Agent Action'}</strong></div></div></Dialog>;
  if (modal.type === 'editorActions') return <Dialog title="编辑器操作" eyebrow="CODE REVIEW" onClose={closeModal} width="390px"><div className="action-list"><button onClick={() => { copyText('diff --git a/kernels/paged_attention.cu b/kernels/paged_attention.cu\n+auto& plan = plan_cache.get_or_build(args.signature());').then(() => notify('Patch 内容已复制。')); closeModal(); }}><Copy size={16} /><div><strong>复制 Patch</strong><small>复制当前候选的 unified diff</small></div><ChevronRight size={15} /></button><button onClick={() => { downloadText('candidate-02.diff', 'diff --git a/kernels/paged_attention.cu b/kernels/paged_attention.cu\n+auto& plan = plan_cache.get_or_build(args.signature());'); notify('Diff 摘要已下载。'); closeModal(); }}><Download size={16} /><div><strong>下载 Diff 摘要</strong><small>用于离线审查和工程对接</small></div><ChevronRight size={15} /></button><button onClick={() => { setView('experiments'); closeModal(); }}><FileText size={16} /><div><strong>查看关联测试</strong><small>tests/paged_attention_cases.yaml</small></div><ChevronRight size={15} /></button></div></Dialog>;
  if (modal.type === 'asset') return <AssetDetailDialog asset={normalizeKnowledgeAsset(modal)} onClose={closeModal} onReference={onReferenceKnowledge} notify={notify} />;
  if (['repository', 'environments', 'settings'].includes(modal.type)) {
    const content = {
      repository: { title: '仓库与工作副本', eyebrow: 'PROJECT / REPOSITORY', icon: FolderGit2, heading: activeMission?.repository || '未绑定仓库', text: '项目绑定一个真实 Git 仓库；当前 Mission 的 Snapshot 工作副本由系统在项目目录内自动创建和隔离。', rows: [['当前 Mission', activeMission?.id || '未选择'], ['工作副本', activeMission?.workflowRecovery?.worktree?.path || '.operator-studio/workspaces/<missionId>/workspace'], ['工作副本策略', '项目内 Managed Snapshot'], ['生命周期', '随 Mission 归档或清理']] },
      environments: { title: '执行环境', eyebrow: 'EXECUTION CLOUD', icon: Cpu, heading: '2 个 Worker 在线', text: '调度器会按环境指纹路由 Test Task，历史 Run 不会被环境升级覆盖。', rows: [['C500 Production 01', 'online · mxmaca 1.4.0'], ['CUDA A100 Reference', 'online · cuda 3.2.1'], ['ROCm MI300', 'offline · adapter not registered']] },
      settings: { title: '项目策略', eyebrow: 'PROJECT POLICY', icon: Settings2, heading: `${activeMission?.repository || '未绑定仓库'} / Mission policy`, text: '这里的设置影响自动采用策略、测试队列和代码工作副本的生命周期。', rows: [['Adoption policy', 'automatic gate'], ['Full Benchmark', '串行队列'], ['Workspace', 'Mission 独立副本']] },
    }[modal.type];
    const Icon = content.icon;
    return <Dialog title={content.title} eyebrow={content.eyebrow} onClose={closeModal} width="500px"><div className="info-dialog"><div className="info-dialog-icon"><Icon size={21} /></div><h3>{content.heading}</h3><p>{content.text}</p><dl>{content.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><button className="primary-action" onClick={() => { notify(`${content.title}已刷新。`); closeModal(); }}>刷新状态</button></div></Dialog>;
  }
  return null;
}

function Toast({ children }) {
  return <div className="toast"><CheckCircle2 size={16} /> {children}</div>;
}

export default function App() {
  const [view, setView] = useState('mission');
  const [stage, setStage] = useState('candidate');
  const [missionContext, setMissionContext] = useState(true);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null);
  const [workspace, setWorkspace] = useState('Matrix Lab');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(2);
  const [missionPaused, setMissionPaused] = useState(false);
  const [patchApplied, setPatchApplied] = useState(false);
  const [agentState, setAgentState] = useState({ status: 'idle', phase: '待启动', progress: 0, goal: '', messages: [], artifacts: [], currentAction: null });
  const [missionsState, setMissionsState] = useState([]);
  const [projects, setProjects] = useState([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeMissionId, setActiveMissionId] = useState('MIS_01JH7R');
  const [agentProfiles, setAgentProfiles] = useState([]);
  const [capabilityRegistry, setCapabilityRegistry] = useState({ skills: [], tools: [] });
  const [benchmarkStatus, setBenchmarkStatus] = useState('idle');
  const [benchmarkProgress, setBenchmarkProgress] = useState(0);
  const [benchmarkLogs, setBenchmarkLogs] = useState([]);
  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [testMatrix, setTestMatrix] = useState({ environments: ['C500', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] });
  const [knowledgeDraftsState, setKnowledgeDraftsState] = useState([]);
  const [candidateEvaluations, setCandidateEvaluations] = useState([]);
  const [failureRecords, setFailureRecords] = useState([]);
  const [publishedAssets, setPublishedAssets] = useState([]);
  const [knowledgeMaintenance, setKnowledgeMaintenance] = useState(defaultKnowledgeMaintenance);
  const [decisionReview, setDecisionReview] = useState({ status: 'idle', requiresApproval: false, signals: [] });
  const [workflowRecovery, setWorkflowRecovery] = useState({ worktree: null, checkpoints: [], lastRecovery: null, invalidatedArtifacts: [] });
  const [currentBest, setCurrentBest] = useState({ candidateId: null, version: null, value: '—', improvement: '—', status: 'empty' });
  const [knowledgeReferences, setKnowledgeReferences] = useState([]);
  const [knowledgeOptionLibrary, setKnowledgeOptionLibrary] = useState(defaultKnowledgeOptionLibrary);
  const [auditEvents, setAuditEvents] = useState([]);
  const [workspaceFilesState, setWorkspaceFilesState] = useState([]);
  const [backendStatus, setBackendStatus] = useState('connecting');
  const [backendError, setBackendError] = useState('');
  const [intentIssue, setIntentIssue] = useState(null);
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [runtimePreflight, setRuntimePreflight] = useState(null);
  const [researchAgent, setResearchAgent] = useState({ status: 'idle', phase: '待调研', progress: 0, synchronous: false, direction: null, notes: [], messages: [], artifacts: [] });
  const [researchNotes, setResearchNotes] = useState([]);
  const [iterationStats, setIterationStats] = useState(null);
  const draftSaveTimers = useRef({});
  const knowledgeDraftsRef = useRef([]);
  const previousBenchmarkStatusRef = useRef('idle');
  const backendRequestSequenceRef = useRef(0);
  const lastAppliedBackendSequenceRef = useRef(0);
  const lastBackendUpdatedAtRef = useRef('');

  const openModal = (type, data = {}) => setModal({ type, ...data });
  const closeModal = () => setModal(null);
  const notify = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  };
  const applyBackendState = (state) => {
    if (!state) return;
    if (state.updatedAt && lastBackendUpdatedAtRef.current && state.updatedAt < lastBackendUpdatedAtRef.current) return;
    if (state.updatedAt) lastBackendUpdatedAtRef.current = state.updatedAt;
    const completedBenchmark = previousBenchmarkStatusRef.current === 'running' && state.benchmark?.status === 'complete';
    if (completedBenchmark && state.stage === 'published') {
      setView((current) => current === 'experiments' ? 'decision' : current);
      notify('Accept Gate 已自动采用，已进入效果决策结果；可继续查看知识维护。');
    }
    if (state.benchmark?.status) previousBenchmarkStatusRef.current = state.benchmark.status;
    if (state.stage) setStage(state.stage);
    if (typeof state.patchApplied === 'boolean') setPatchApplied(state.patchApplied);
    if (state.agent) setAgentState(state.agent);
    if (Array.isArray(state.missions)) setMissionsState(state.missions);
    if (Array.isArray(state.projects)) setProjects(state.projects.map((project) => ({ ...project, missionCount: (state.missions || []).filter((mission) => mission.projectId === project.id).length, runningMissionCount: (state.missions || []).filter((mission) => mission.projectId === project.id && mission.status === 'running').length })));
    if (state.activeProjectId) setActiveProjectId(state.activeProjectId);
    if (state.activeMissionId) setActiveMissionId(state.activeMissionId);
    if (Array.isArray(state.agentProfiles)) setAgentProfiles(state.agentProfiles);
    if (state.capabilityRegistry) setCapabilityRegistry(state.capabilityRegistry);
    if (state.runtime) setRuntimeInfo(state.runtime);
    if (state.benchmark) {
      setBenchmarkStatus(state.benchmark.status);
      setBenchmarkProgress(state.benchmark.progress || 0);
      setBenchmarkLogs(state.benchmark.logs || []);
      setBenchmarkResult(state.benchmark.result || null);
    }
    if (state.testMatrix) setTestMatrix(state.testMatrix);
    if (Array.isArray(state.knowledgeDrafts)) {
      setKnowledgeDraftsState(state.knowledgeDrafts);
      knowledgeDraftsRef.current = state.knowledgeDrafts;
    }
    if (Array.isArray(state.candidateEvaluations)) setCandidateEvaluations(state.candidateEvaluations);
    if (Array.isArray(state.failureRecords)) setFailureRecords(state.failureRecords);
    if (Array.isArray(state.publishedAssets)) setPublishedAssets(state.publishedAssets.map((asset) => ({ ...asset, icon: typeof asset.icon === 'string' ? Lightbulb : (asset.icon || Lightbulb) })));
    if (state.knowledgeMaintenance?.policy) setKnowledgeMaintenance(state.knowledgeMaintenance);
    if (state.decisionReview?.policy) setDecisionReview(state.decisionReview);
    if (state.workflowRecovery?.worktree) setWorkflowRecovery(state.workflowRecovery);
    if (state.currentBest?.candidateId) setCurrentBest(state.currentBest);
    if (Array.isArray(state.knowledgeReferences)) setKnowledgeReferences(state.knowledgeReferences);
    if (state.knowledgeOptionLibrary?.categories) setKnowledgeOptionLibrary(state.knowledgeOptionLibrary);
    if (state.workspace) setWorkspace(state.workspace);
    if (typeof state.unreadCount === 'number') setUnreadCount(state.unreadCount);
    if (typeof state.missionPaused === 'boolean') setMissionPaused(state.missionPaused);
    if (Array.isArray(state.auditEvents)) setAuditEvents(state.auditEvents);
    if (state.researchAgent) setResearchAgent(state.researchAgent);
    if (Array.isArray(state.researchNotes)) setResearchNotes(state.researchNotes);
    if (state.iterationStats) setIterationStats(state.iterationStats);
  };

  const requestBackend = async (path, options = {}, silent = false) => {
    const requestSequence = ++backendRequestSequenceRef.current;
    try {
      const result = await apiRequest(path, options);
      setBackendStatus('online');
      setBackendError('');
      if (result.state && requestSequence >= lastAppliedBackendSequenceRef.current) {
        lastAppliedBackendSequenceRef.current = requestSequence;
        applyBackendState(result.state);
      }
      return result;
    } catch (error) {
      if (error.status) {
        setBackendStatus('online');
        setBackendError('');
      } else {
        setBackendStatus('offline');
        setBackendError(error.message);
      }
      if (error.details?.status) setIntentIssue(error.details);
      if (!silent) notify(error.message);
      return null;
    }
  };

  const navigateMission = (nextView) => { setMissionContext(true); setView(nextView); };
  const navigateAny = (nextView) => { setMissionContext(!['knowledge', 'missions', 'capabilities'].includes(nextView)); setView(nextView); };
  const openMissionStep = (item) => { setMissionContext(true); setView(item.view); notify(`已进入任务阶段：${item.label}`); };
  const navigateGlobal = (target) => {
    if (target === 'knowledge') { setMissionContext(false); setView('knowledge'); return; }
    if (target === 'missions') { setMissionContext(false); setView('missions'); return; }
    if (target === 'capabilities') { setMissionContext(false); setView('capabilities'); return; }
    setMissionContext(true); setView('mission');
  };
  const startAgentMission = async (goal) => {
    if (missionPaused || !goal?.trim()) return;
    const result = await requestBackend(`/api/missions/${encodeURIComponent(activeMissionId)}/runs`, { method: 'POST', body: JSON.stringify({ goal: goal.trim() }) });
    if (!result) return;
    setIntentIssue(null);
    setMissionContext(true);
    setView('mission');
    notify('Agent Run 已启动，正在建立任务上下文。');
  };
  const cancelAgentMission = async () => {
    if (!agentState.runId || !['running', 'cancel_requested'].includes(agentState.status)) return;
    const result = await requestBackend(`/api/missions/${encodeURIComponent(activeMissionId)}/runs/${encodeURIComponent(agentState.runId)}/cancel`, { method: 'POST' });
    if (result) notify('Agent stop requested.');
  };
  const startResearch = async (direction) => {
    if (missionPaused) return;
    const body = direction?.trim() ? { direction: direction.trim() } : {};
    const result = await requestBackend(`/api/missions/${encodeURIComponent(activeMissionId)}/research`, { method: 'POST', body: JSON.stringify(body) });
    if (result) notify('研究员已启动，正在后台调研最新算子做法。');
  };
  const cancelResearch = async () => {
    if (!researchAgent.runId || !['running', 'cancel_requested'].includes(researchAgent.status)) return;
    const result = await requestBackend(`/api/missions/${encodeURIComponent(activeMissionId)}/research/${encodeURIComponent(researchAgent.runId)}/cancel`, { method: 'POST' });
    if (result) notify('研究员已请求取消。');
  };
  const createMission = async (input) => {
    if (missionPaused || !input?.goal?.trim()) return;
    const result = await requestBackend('/api/missions', { method: 'POST', body: JSON.stringify(input) });
    if (!result) return;
    setMissionContext(true);
    setView('mission');
    notify('Mission 已创建，Agent 可以开始接管。');
  };
  const selectMission = async (missionId) => {
    const result = await requestBackend(`/api/missions/${encodeURIComponent(missionId)}/select`, { method: 'POST' });
    if (!result) return;
    setMissionContext(true);
    setView('mission');
    notify('已切换 Mission 工作区。');
  };
  const createProject = async (input) => {
    setProjectBusy(true);
    const result = await requestBackend('/api/projects', { method: 'POST', body: JSON.stringify(input) });
    setProjectBusy(false);
    if (result?.state?.projects) { setProjects(result.state.projects); notify('项目已登记，可用于创建新的 Mission。'); return true; }
    return false;
  };
  const selectProject = async (project) => {
    setProjectBusy(true);
    const result = await requestBackend(`/api/projects/${encodeURIComponent(project.id)}/select`, { method: 'POST' });
    setProjectBusy(false);
    if (!result) return;
    closeModal();
    if (result.selectedMissionId) {
      setMissionContext(true);
      setView('mission');
      notify(`已切换到项目“${project.name}”及其当前 Mission。`);
    } else {
      setMissionContext(false);
      setView('missions');
      notify(`已切换到项目“${project.name}”，请创建首个 Mission。`);
    }
  };
  const browseDirectories = async (target = '') => (await apiRequest(`/api/filesystem/directories${target ? `?path=${encodeURIComponent(target)}` : ''}`)).directory;
  const selectDirectory = async (initialPath = '') => apiRequest('/api/filesystem/select-directory', { method: 'POST', body: JSON.stringify({ initialPath }) });
  const createDirectory = async (parent, name) => (await apiRequest('/api/filesystem/directories', { method: 'POST', body: JSON.stringify({ parent, name }) })).directory;
  const inspectProjectSources = async (projectId) => apiRequest(`/api/projects/${encodeURIComponent(projectId)}/sources`);
  const bootstrapProject = async (project, input) => {
    setProjectBusy(true);
    const result = await requestBackend(`/api/projects/${encodeURIComponent(project.id)}/bootstrap`, { method: 'POST', body: JSON.stringify(input) });
    setProjectBusy(false);
    if (!result?.project) return null;
    applyBackendState(result.state);
    notify(`Iteration Repository 已补齐：${result.bootstrap?.trackedFiles || 0} 个文件。`);
    return { projectId: project.id };
  };
  const reinitializeProject = async (project) => {
    if (!window.confirm(`确认将项目“${project.name}”重新初始化为严格三层结构？旧 Runtime 会保留为备份，Mission 将回到待启动状态。`)) return;
    setProjectBusy(true);
    const result = await requestBackend(`/api/projects/${encodeURIComponent(project.id)}/reinitialize`, { method: 'POST' });
    setProjectBusy(false);
    if (result?.state) {
      applyBackendState(result.state);
      notify('项目已重新初始化为严格三层结构。');
    }
  };
  const archiveProject = async (project) => {
    if (!window.confirm(`确认归档项目“${project.name}”？归档不会删除历史 Mission。`)) return;
    setProjectBusy(true);
    const result = await requestBackend(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) });
    setProjectBusy(false);
    if (result?.state?.projects) { setProjects(result.state.projects); notify('项目已归档。'); }
  };
  const deleteProject = async (project) => {
    if (!window.confirm(`确认删除项目“${project.name}”？该操作不可恢复。`)) return;
    setProjectBusy(true);
    const result = await requestBackend(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    setProjectBusy(false);
    if (result?.state?.projects) { setProjects(result.state.projects); notify('项目已删除。'); }
  };
  const handleMissionAction = () => {
    if (stage === 'diagnosis') navigateMission('iterations');
    else if (stage === 'candidate') navigateMission('code');
    else if (stage === 'validation') navigateMission('experiments');
    else if (stage === 'evidence') navigateMission('decision');
    else navigateMission('curation');
  };
  const applyPatch = async (candidateId = candidateEvaluations[0]?.id) => {
    if (missionPaused || patchApplied) return false;
    const result = await requestBackend('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: candidateId }) });
    if (!result) return false;
    if (result.workspace?.files) setWorkspaceFilesState(result.workspace.files);
    navigateMission('experiments');
    notify('Patch 自动策略检查通过，已写入隔离工作区并准备异构测试。');
    return true;
  };
  const runBenchmark = async () => {
    if (missionPaused || benchmarkStatus === 'running' || benchmarkStatus === 'complete') return;
    const result = await requestBackend('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ matrix: testMatrix }) });
    if (!result) return;
    navigateMission('experiments');
    notify('测试矩阵已提交，正在收集跨环境结果。');
  };
  const adoptCandidate = async (candidate, note) => {
    if (missionPaused) return;
    const result = await requestBackend('/api/actions/adopt', { method: 'POST', body: JSON.stringify({ candidate: candidate.id, note }) });
    if (!result) return false;
    navigateMission('curation');
    notify('策略建议已执行，候选采用结果和知识维护记录已写入审计链。');
    return true;
  };
  const requestDecisionReview = async (candidate, review) => {
    if (missionPaused) return false;
    const result = await requestBackend('/api/actions/request-review', { method: 'POST', body: JSON.stringify({ candidate: candidate.id, ...review }) });
    if (!result) return false;
    notify('人工介入事项已创建，效果决策流程现在处于阻塞状态。');
    return true;
  };
  const resolveDecisionReview = async (review, resolution = {}) => {
    if (missionPaused || !review) return false;
    const outcome = resolution.outcome || review.outcome;
    const note = resolution.note || review.note;
    const result = await requestBackend('/api/actions/resolve-review', { method: 'POST', body: JSON.stringify({ outcome, note }) });
    if (!result) return false;
    if (outcome === 'adopt') {
      navigateMission('curation');
      notify('审批意见已处理，候选已采用并进入知识自动维护。');
    } else if (outcome === 'redirect') {
      navigateMission('code');
      notify('人工介入已调整优化方向，候选工作区已恢复。');
    } else {
      navigateMission('experiments');
      notify('审批意见已处理，流程已返回补充验证阶段。');
    }
    return true;
  };
  const cancelDecisionReview = async () => {
    if (missionPaused) return false;
    const result = await requestBackend('/api/actions/cancel-review', { method: 'POST' });
    if (!result) return false;
    notify('人工意见已撤回，流程恢复为条件式策略决策。');
    return true;
  };
  const rollbackStage = async () => {
    if (missionPaused) return false;
    const result = await requestBackend('/api/actions/rollback-stage', { method: 'POST' });
    if (!result) return false;
    navigateMission('code');
    notify('已恢复补丁应用前的候选工作区，后续测试与证据已标记为失效。');
    return true;
  };
  const revertAdoption = async () => {
    if (missionPaused) return false;
    const result = await requestBackend('/api/actions/revert-adoption', { method: 'POST' });
    if (!result) return false;
    navigateMission('decision');
    notify('已恢复上一稳定版本，已采用候选的关联知识已标记为被替代。');
    return true;
  };
  const rejectCandidate = async (candidate) => {
    if (missionPaused) return;
    const result = await requestBackend('/api/actions/reject', { method: 'POST', body: JSON.stringify({ candidate: candidate.id }) });
    if (!result) return;
    navigateMission('experiments');
    notify('候选已退回验证阶段。');
  };
  const updateKnowledgeDraft = (draftId, patch) => {
    const current = knowledgeDraftsRef.current.find((draft) => draft.id === draftId);
    if (!current) return;
    const updated = { ...current, ...patch };
    const nextDrafts = knowledgeDraftsRef.current.map((draft) => draft.id === draftId ? updated : draft);
    knowledgeDraftsRef.current = nextDrafts;
    setKnowledgeDraftsState(nextDrafts);
    window.clearTimeout(draftSaveTimers.current[draftId]);
    draftSaveTimers.current[draftId] = window.setTimeout(() => {
      requestBackend(`/api/knowledge/drafts/${encodeURIComponent(draftId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    }, 450);
  };
  const referenceKnowledge = async (asset, reasons = []) => {
    const result = await requestBackend('/api/knowledge/references', { method: 'POST', body: JSON.stringify({ assetId: asset.id, title: asset.title, version: asset.version, reason: reasons[0] || `适用于当前任务：${asset.scope}` }) });
    if (!result) return;
    setModal((current) => current?.type === 'asset' && current.id === asset.id ? { ...current, isReferenced: true } : current);
    notify(`“${asset.title}”已按固定版本引用到当前任务。`);
  };
  const updateMatrix = async (value) => {
    const previous = testMatrix;
    setTestMatrix(value);
    const result = await requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ testMatrix: value }) });
    if (!result) setTestMatrix(previous);
  };
  const togglePause = () => { const next = !missionPaused; setMissionPaused(next); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ missionPaused: next }) }); };
  const markNotificationsRead = () => { setUnreadCount(0); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ unreadCount: 0 }) }); };
  const changeWorkspace = (value) => { setWorkspace(value); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ workspace: value }) }); notify(`已切换到 ${value}。`); };

  useEffect(() => {
    let mounted = true;
    const sync = async () => {
      try {
        const stateResult = await apiRequest('/api/state');
        const workspaceResult = await apiRequest('/api/workspace');
        const projectsResult = await apiRequest('/api/projects');
        const preflightResult = await apiRequest(`/api/runtime/preflight?missionId=${encodeURIComponent(stateResult.state.activeMissionId)}`);
        if (!mounted) return;
        setBackendStatus('online'); setBackendError('');
        applyBackendState(stateResult.state);
        setWorkspaceFilesState(workspaceResult.files || []);
        setProjects(projectsResult.projects || []);
        setRuntimePreflight(preflightResult.preflight || null);
      } catch (error) {
        if (mounted) { setBackendStatus('offline'); setBackendError(error.message); }
      }
    };
    sync();
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!activeMissionId) return undefined;
    let cancelled = false;
    setRuntimePreflight(null);
    apiRequest(`/api/runtime/preflight?missionId=${encodeURIComponent(activeMissionId)}`)
      .then((result) => { if (!cancelled) setRuntimePreflight(result.preflight || null); })
      .catch((error) => { if (!cancelled) setRuntimePreflight({ ready: false, agentCheck: { detail: error.message } }); });
    return () => { cancelled = true; };
  }, [activeMissionId]);
  useEffect(() => {
    if (!activeMissionId) return undefined;
    let closed = false;
    let fallbackTimer = null;
    let source = null;
    const sync = () => requestBackend('/api/state', {}, true);
    const startFallback = () => {
      if (fallbackTimer || closed) return;
      sync();
      fallbackTimer = window.setInterval(sync, 2500);
    };
    const handleState = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.state) {
          setBackendStatus('online');
          setBackendError('');
          applyBackendState(payload.state);
        }
      } catch (error) {
        setBackendError(error.message);
      }
    };
    if (typeof window.EventSource === 'function') {
      source = new window.EventSource(`/api/missions/${encodeURIComponent(activeMissionId)}/events/stream`);
      source.addEventListener('state', handleState);
      source.addEventListener('error', startFallback);
    } else {
      startFallback();
    }
    return () => {
      closed = true;
      if (source) source.close();
      if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, [activeMissionId]);
  useEffect(() => {
    if (benchmarkStatus === 'complete' && stage === 'evidence' && view === 'experiments') {
      navigateMission('decision');
      notify(benchmarkResult?.environment?.liveHardware === true ? 'Full Benchmark 完成，已生成真实硬件证据。' : 'Mock Benchmark 完成，已生成流程验证证据。');
    }
  }, [benchmarkStatus, stage, view, benchmarkResult]);
  useEffect(() => () => Object.values(draftSaveTimers.current).forEach((timer) => window.clearTimeout(timer)), []);
  useEffect(() => {
    const handleKeyboard = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openModal('search'); }
      if (event.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [view, activeMissionId]);

  const formalPublishedAssets = publishedAssets.filter((asset) => asset.status === 'published');
  const publishedKnowledgeIds = new Set(formalPublishedAssets.map((asset) => asset.id));
  const effectiveCatalog = [...formalPublishedAssets, ...knowledgeCatalog.filter((asset) => !publishedKnowledgeIds.has(asset.id))];
  const activeMission = missionsState.find((mission) => mission.id === activeMissionId);
  const activeProject = projects.find((project) => project.id === activeProjectId) || projects.find((project) => project.repository === activeMission?.repository) || null;
  let content;
  if (view === 'iterations') content = <IterationsView candidateEvaluations={candidateEvaluations} failureRecords={failureRecords} onOpenModal={openModal} />;
  else if (view === 'code') content = <CodeView patchApplied={patchApplied} workspaceFiles={workspaceFilesState} candidateEvaluations={candidateEvaluations} currentAction={agentState.currentAction} onApplyPatch={applyPatch} onOpenModal={openModal} paused={missionPaused} />;
  else if (view === 'experiments') content = <ExperimentsView benchmarkStatus={benchmarkStatus} benchmarkProgress={benchmarkProgress} benchmarkLogs={benchmarkLogs} benchmarkResult={benchmarkResult} testMatrix={testMatrix} canRollback={Boolean(workflowRecovery?.checkpoints?.length)} onRunBenchmark={runBenchmark} onRollbackStage={rollbackStage} onOpenModal={openModal} paused={missionPaused} />;
  else if (view === 'decision') content = <DecisionView stage={stage} decisionReview={decisionReview} currentBest={currentBest} workflowRecovery={workflowRecovery} candidateEvaluations={candidateEvaluations} activeMission={activeMission} onRollbackStage={rollbackStage} onRevertAdoption={revertAdoption} onOpenModal={openModal} onViewCuration={() => navigateMission('curation')} paused={missionPaused} />;
  else if (view === 'curation') content = <CurationView drafts={knowledgeDraftsState} publishedAssets={publishedAssets} knowledgeMaintenance={knowledgeMaintenance} activeMission={activeMission} onUpdateDraft={updateKnowledgeDraft} onViewLibrary={() => navigateGlobal('knowledge')} onOpenModal={openModal} optionLibrary={knowledgeOptionLibrary} />;
  else if (view === 'knowledge') content = <KnowledgeView catalog={effectiveCatalog} setView={navigateMission} onOpenModal={openModal} missionContext={missionContext} activeMission={activeMission} references={knowledgeReferences} onReference={referenceKnowledge} />;
  else if (view === 'capabilities') content = <CapabilitiesView agentProfiles={agentProfiles} capabilityRegistry={capabilityRegistry} />;
  else if (view === 'missions') content = <MissionHub missions={missionsState} projects={projects} activeProjectId={activeProjectId} activeMissionId={activeMissionId} onSelect={selectMission} onCreate={createMission} />;
  else content = <AgentWorkbenchView stage={stage} activeMission={missionsState.find((mission) => mission.id === activeMissionId)} agentState={agentState} agentProfiles={agentProfiles} capabilityRegistry={capabilityRegistry} runtimeInfo={runtimeInfo} runtimePreflight={runtimePreflight} intentIssue={intentIssue} onStartAgent={startAgentMission} onCancelAgent={cancelAgentMission} onAdvance={handleMissionAction} setView={navigateMission} onOpenModal={openModal} paused={missionPaused} researchAgent={researchAgent} researchNotes={researchNotes} iterationStats={iterationStats} onStartResearch={startResearch} onCancelResearch={cancelResearch} />;

  return (
    <>
      <AppShell view={view} stage={stage} decisionReview={decisionReview} missionContext={missionContext} activeMission={activeMission} activeProject={activeProject} unreadCount={unreadCount} mobileNavOpen={mobileNavOpen} missionPaused={missionPaused} backendStatus={backendStatus} backendError={backendError} runtimeInfo={runtimeInfo} onToggleMobileNav={setMobileNavOpen} onGlobalNavigate={navigateGlobal} onMissionStep={openMissionStep} onOpenModal={openModal}>
        {content}
      </AppShell>
      <ModalLayer modal={modal} closeModal={closeModal} setView={navigateAny} notify={notify} testMatrix={testMatrix} onSaveMatrix={updateMatrix} unreadCount={unreadCount} onMarkNotifications={markNotificationsRead} workspace={workspace} onWorkspaceChange={changeWorkspace} missionPaused={missionPaused} onTogglePause={togglePause} auditEvents={auditEvents} onReferenceKnowledge={referenceKnowledge} optionLibrary={knowledgeOptionLibrary} stage={stage} decisionReview={decisionReview} activeProjectId={activeProjectId} activeMission={activeMission} candidateEvaluations={candidateEvaluations} currentBest={currentBest} benchmarkStatus={benchmarkStatus} onRequestReview={requestDecisionReview} onResolveReview={resolveDecisionReview} onCancelReview={cancelDecisionReview} projects={projects} onCreateProject={createProject} onSelectProject={selectProject} onArchiveProject={archiveProject} onDeleteProject={deleteProject} onOpenMission={() => { closeModal(); setMissionContext(true); setView('mission'); }} onSelectDirectory={selectDirectory} onBrowseDirectories={browseDirectories} onCreateDirectory={createDirectory} onInspectSources={inspectProjectSources} onReinitializeProject={reinitializeProject} onBootstrapProject={bootstrapProject} projectBusy={projectBusy} />
      {toast && <Toast>{toast}</Toast>}
    </>
  );
}
