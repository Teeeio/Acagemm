import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const dataDir = process.env.OPERATOR_DATA_DIR ? path.resolve(process.env.OPERATOR_DATA_DIR) : path.join(rootDir, 'data');
const runtimeDir = process.env.OPERATOR_RUNTIME_DIR ? path.resolve(process.env.OPERATOR_RUNTIME_DIR) : path.join(rootDir, 'runtime');
const statePath = path.join(dataDir, 'mock-db.json');
const workspaceTemplate = path.join(rootDir, 'demo-assets', 'mla-kernels');
export const workspaceDir = path.join(runtimeDir, 'mla-kernels');

export const knowledgeDrafts = [
  { id: 'exp.async-plan-cache', code: 'EXP-01', category: '通用优化经验', title: '短序列下的 Async plan descriptor cache', conclusion: '当设备 Kernel 已低于 50μs 时，缓存 plan descriptor 并将 host mirror 移出热路径，可以稳定降低固定开销。', scope: 'C500 / CUDA · paged_attention · batch 1–8 · seq_len ≤ 1024', constraints: '保留 host mirror fallback；必须通过 24 / 24 Correctness Gate。', hardware: ['C500', 'CUDA'], evidence: '2 个 Level 3 Run' },
  { id: 'exp.c500-plan-cache-boundary', code: 'EXP-02', category: '沐曦 C500 专项准则', title: '沐曦 C500 plan cache 与 host mirror 边界准则', conclusion: '在 MXMACA 1.4+ 环境中，descriptor cache 应按 Shape signature 分桶，host mirror 仅在缓存未就绪时回退同步路径。', scope: 'MetaX C500 · MXMACA 1.4+ · paged_attention · small batch', constraints: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。', hardware: ['C500'], evidence: 'C500 41.8μs · Level 3' },
  { id: 'exp.cross-platform-adoption-gate', code: 'EXP-03', category: '跨平台验证准则', title: 'C500 / CUDA 跨平台候选采用门禁', conclusion: '跨平台候选只有在 Correctness、目标平台性能和固定环境证据同时通过后，才能替换 current best。', scope: 'C500 / CUDA · operator candidate adoption · Full Benchmark', constraints: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。', hardware: ['C500', 'CUDA'], evidence: '24 / 24 · 2 个固定环境' },
];

export const createSeedState = () => ({
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  stage: 'candidate',
  patchApplied: false,
  benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] },
  testMatrix: { environments: ['C500', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] },
  knowledgeDrafts: structuredClone(knowledgeDrafts),
  publishedAssets: [],
  workspace: 'Matrix Lab',
  unreadCount: 2,
  missionPaused: false,
  auditEvents: [
    { time: '10:42:23', title: 'Policy Engine 等待代码审批', detail: 'approval.apl_01JH7R · patch apply', tone: 'warning', icon: 'ShieldCheck' },
    { time: '10:42:19', title: 'Candidate Agent 生成 Candidate 02', detail: '2 files · +37 −18 · digest recorded', tone: 'blue', icon: 'Code2' },
    { time: '10:42:11', title: 'Research Agent 引用固定开销 Experience', detail: 'exp.short-seq.fixed-overhead@1.2 · validated', tone: 'green', icon: 'Search' },
  ],
});

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

export async function ensureStorage() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  if (!(await exists(statePath))) await saveState(createSeedState());
  if (!(await exists(workspaceDir))) await cp(workspaceTemplate, workspaceDir, { recursive: true });
}

export async function loadState() {
  await ensureStorage();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  return refreshBenchmark(state);
}

export async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statePath);
  return next;
}

export async function resetDemoData() {
  const state = await saveState(createSeedState());
  if (await exists(workspaceDir)) await rm(workspaceDir, { recursive: true, force: true });
  await cp(workspaceTemplate, workspaceDir, { recursive: true });
  return state;
}

export function addAuditEvent(state, title, detail, tone = 'blue', icon = 'Activity') {
  const event = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), title, detail, tone, icon };
  state.auditEvents = [event, ...(state.auditEvents || [])].slice(0, 30);
  return event;
}

async function refreshBenchmark(state) {
  if (state.benchmark?.status !== 'running' || !state.benchmark.startedAt) return state;
  const elapsed = Date.now() - new Date(state.benchmark.startedAt).getTime();
  const progress = Math.min(100, Math.max(0, Math.floor((elapsed / state.benchmark.durationMs) * 100 / 10) * 10));
  state.benchmark.progress = progress;
  state.benchmark.logs = buildBenchmarkLogs(progress);
  if (progress >= 100) {
    state.benchmark.status = 'complete';
    state.stage = 'evidence';
    if (!state.benchmark.completedAt) {
      state.benchmark.completedAt = new Date().toISOString();
      addAuditEvent(state, 'Full Benchmark 已完成', 'C500 41.8μs · CUDA 36.1μs · 24/24', 'green', 'CheckCircle2');
    }
  }
  return saveState(state);
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

export async function applyCandidatePatch() {
  await ensureStorage();
  await mkdir(path.join(workspaceDir, 'kernels'), { recursive: true });
  const patchedSource = `#include "paged_attention.hpp"\n#include "plan_cache.hpp"\n\nPlan run_paged_attention(const AttentionArgs& args, const KvCache& kv_cache) {\n  auto& plan = plan_cache.get_or_build(args.signature());\n  if (LIKELY(plan.host_mirror_ready())) {\n    launch_paged_kernel(plan.device_view(), kv_cache);\n  } else {\n    plan_cache.enqueue_host_mirror(plan);\n  }\n  return plan;\n}\n`;
  const cacheHeader = `#pragma once\n\nclass PlanCache {\n public:\n  Plan& get_or_build(Signature signature);\n  void enqueue_host_mirror(const Plan& plan);\n};\n`;
  await writeFile(path.join(workspaceDir, 'kernels', 'paged_attention.cu'), patchedSource, 'utf8');
  await writeFile(path.join(workspaceDir, 'kernels', 'plan_cache.hpp'), cacheHeader, 'utf8');
  return { workspace: path.relative(rootDir, workspaceDir).replaceAll('\\', '/'), files: workspaceFiles };
}
