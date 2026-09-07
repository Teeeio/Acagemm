import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { projectRoot as rootDir, runtimeDir } from './storage-paths.mjs';
import { statePath } from './state-snapshot-storage.mjs';
import { copyWorkspaceSnapshot, workspaceManager } from './workspace-manager.mjs';
import { safeMissionId, projectNameForRepository } from './state-identifiers.mjs';

const workspaceTemplate = path.join(rootDir, 'test-fixtures', 'mla-kernels');

export const workspaceDir = path.join(runtimeDir, 'mla-kernels');

const missionWorkspaceRoot = path.join(runtimeDir, 'workspaces');

const workspaceCheckpointRoot = path.join(runtimeDir, 'checkpoints');

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

export const missionSourceDirFor = (missionId, repository = '', projectRoot = '') => path.join(missionRootFor(missionId, repository, projectRoot), 'sources');

export const baselineDirForMission = (missionId, repository = '', projectRoot = '') => path.join(missionRootFor(missionId, repository, projectRoot), 'baseline');

export const artifactDirForMission = (missionId, repository = '', projectRoot = '') => {
  const layout = projectLayoutFor(repository, projectRoot);
  return layout.root
    ? path.join(layout.runtimeRoot, 'artifacts', safeMissionId(missionId))
    : path.join(runtimeDir, 'artifacts', safeMissionId(missionId));
};

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

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

export async function ensureMissionWorkspace(missionId, repository = '', options = {}) {
  let sourceRepository = String(repository || '').trim();
  let projectRoot = String(options.projectRoot || '').trim();
  let sourceRoot = String(options.sourceRoot || '').trim();
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
  const target = workspaceDirForMission(missionId, sourceRepository, projectRoot);
  const missionRoot = path.dirname(target);
  const missionLocalSource = sourceRoot
    && path.resolve(sourceRoot).startsWith(`${path.resolve(missionRoot)}${path.sep}`);
  if (projectRoot) {
    await ensureProjectLayout({
      root: projectRoot,
      repository: sourceRepository,
      sourceRoot: missionLocalSource ? path.join(projectRoot, 'sources') : sourceRoot,
    });
  }
  await mkdir(missionRoot, { recursive: true });
  if (missionLocalSource) {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(researchDirForMission(missionId, sourceRepository, projectRoot), { recursive: true });
    await mkdir(baselineDirForMission(missionId, sourceRepository, projectRoot), { recursive: true });
  }
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

export const workspaceFiles = [
  { id: 'paged_attention.cu', path: 'kernels/paged_attention.cu', status: 'M', lines: [['context', '188', 'auto plan = build_attention_plan(args);'], ['remove', '189', 'auto workspace = allocate_workspace(plan.size());'], ['remove', '190', 'mirror_to_host(plan, host_plan);'], ['add', '189', 'auto& plan = plan_cache.get_or_build(args.signature());'], ['add', '190', 'if (LIKELY(plan.host_mirror_ready())) {'], ['add', '191', '  launch_paged_kernel(plan.device_view(), kv_cache);'], ['add', '192', '} else {'], ['add', '193', '  plan_cache.enqueue_host_mirror(plan);'], ['add', '194', '}'], ['context', '195', 'return plan;']], rationale: '缓存 descriptor 避免热路径重复分配；同步回退只保留在 host mirror 尚未就绪的边界场景。' },
  { id: 'plan_cache.hpp', path: 'kernels/plan_cache.hpp', status: 'A', lines: [['context', '1', '#pragma once'], ['add', '2', 'class PlanCache {'], ['add', '3', ' public:'], ['add', '4', '  Plan& get_or_build(Signature signature);'], ['add', '5', '  void enqueue_host_mirror(const Plan& plan);'], ['add', '6', '};']], rationale: '新增轻量 descriptor cache，将 plan 生命周期与请求 signature 绑定，避免重复构建。' },
  { id: 'paged_attention_cases.yaml', path: 'tests/paged_attention_cases.yaml', status: 'T', lines: [['context', '1', 'suite: paged_attention'], ['context', '2', 'platforms: [C550, CUDA]'], ['add', '3', 'correctness_cases: 24'], ['add', '4', 'shape: [1, 4, 128, 1024]'], ['add', '5', 'assert: max_abs_error <= 1e-3']], rationale: 'Correctness Gate 固定 24 个边界与回归用例，先通过正确性再进入性能阶段。' },
  { id: 'mla_paged_attention.yaml', path: 'benchmarks/mla_paged_attention.yaml', status: 'B', lines: [['context', '1', 'benchmark: mla_paged_attention'], ['context', '2', 'warmup: 50'], ['add', '3', 'repeats: 200'], ['add', '4', 'metric: latency_p50'], ['add', '5', 'environment_snapshot: fixed']], rationale: 'Benchmark 固定预热、重复次数与 Environment Snapshot，保证跨硬件结果可比。' },
];

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
  await workspaceManager.git(['config', 'core.longpaths', 'true'], target);
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
  // captureDiff uses intent-to-add for new files. Restore the index as well as
  // the filesystem so a rejected untracked candidate cannot survive as a
  // staged empty entry in the next round.
  await workspaceManager.git(['reset', '--mixed', 'HEAD'], target);
  await workspaceManager.inspect(target, { refresh: true });
  return { checkpointId: checkpoint.id, workspace: path.relative(rootDir, target).replaceAll('\\', '/'), restoredAt: new Date().toISOString() };
}

export const createStateWorkspace = ({ initializeStorage } = {}) => {
  if (typeof initializeStorage !== 'function') throw new TypeError('State Workspace requires an initializeStorage port.');
  async function applyCandidatePatch(missionId, candidateId = 'candidate-02') {
    await initializeStorage();
    const activeWorkspace = await ensureMissionWorkspace(missionId);
    await mkdir(path.join(activeWorkspace, 'kernels'), { recursive: true });
    const patchedSource = `#include "paged_attention.hpp"\n#include "plan_cache.hpp"\n\nPlan run_paged_attention(const AttentionArgs& args, const KvCache& kv_cache) {\n  auto& plan = plan_cache.get_or_build(args.signature());\n  if (LIKELY(plan.host_mirror_ready())) {\n    launch_paged_kernel(plan.device_view(), kv_cache);\n  } else {\n    plan_cache.enqueue_host_mirror(plan);\n  }\n  return plan;\n}\n`;
    const cacheHeader = `#pragma once\n\nclass PlanCache {\n public:\n  Plan& get_or_build(Signature signature);\n  void enqueue_host_mirror(const Plan& plan);\n};\n`;
    // The local adapter always validates the production run.py bridge, even in
    // full simulation. Keep the fixture native files for topology display, but
    // also materialize a unique, executable bridge for each candidate round.
    const bridge = `# Simulation candidate ${candidateId}\n# The scripted backend requires explicit operator and paged-KV identity markers.\noperatorIdentity = 'mla_paged_attention'\npage_size = 1\npage_ids = [0]\nkv_indices = [0]\nblock_tables = [0]\n\ndef get_inputs():\n    return {'values': list(range(64))}\n\ndef get_test_cases():\n    return [{'name': 'small-vector', 'category': 'minimal', 'inputs': {'values': [1, 2, 3, 4]}}]\n\ndef get_benchmark_inputs():\n    return [{'name': 'primary', 'inputs': get_inputs()}]\n\ndef reference(inputs):\n    return [value * 2 for value in inputs['values']]\n\ndef run(inputs):\n    return [value * 2 for value in inputs['values']]\n`;
    await writeFile(path.join(activeWorkspace, 'kernels', 'paged_attention.cu'), patchedSource, 'utf8');
    await writeFile(path.join(activeWorkspace, 'kernels', 'plan_cache.hpp'), cacheHeader, 'utf8');
    await writeFile(path.join(activeWorkspace, 'run.py'), bridge, 'utf8');
    return { workspace: path.relative(rootDir, activeWorkspace).replaceAll('\\', '/'), files: workspaceFiles };
  }

  async function createWorkspaceCheckpoint(missionId, stage = 'candidate', candidateId = null) {
    await initializeStorage();
    const activeWorkspace = await ensureMissionWorkspace(missionId);
    const stableDiff = await workspaceManager.captureDiff(activeWorkspace);
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
      stableDigest: stableDiff.digest,
      stableChangedFiles: stableDiff.changedFiles,
    };
  }
  return Object.freeze({ applyCandidatePatch, createWorkspaceCheckpoint });
};

export async function resetFixtureWorkspaces() {
  if (await exists(missionWorkspaceRoot)) await rm(missionWorkspaceRoot, { recursive: true, force: true });
  if (await exists(workspaceDir)) await rm(workspaceDir, { recursive: true, force: true });
  if (await exists(workspaceCheckpointRoot)) await rm(workspaceCheckpointRoot, { recursive: true, force: true });
};
