// Experiment input/storage adapter. Mission workflow remains in the production API.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyExperienceStore, validateExperienceStore, EXPERIENCE_LIMITS } from './experience-contract.mjs';
import { createExperienceRepository } from './experience-repository.mjs';
import { resolveExperimentMemoryMode } from './experiment-memory.mjs';

const SCHEMA = 'operator-studio.independent-experiment/v1';
const AGENT_POLICY = 'claude-safe-mode-confined-fresh-session-v2';
const fail = (message) => Object.assign(new Error(message), { code: 'EXPERIMENT_ISOLATION_INVALID' });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const absolute = (value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) throw fail('An absolute non-root path is required.');
  return path.resolve(value);
};
const assertDigest = (value) => { if (!/^[a-f0-9]{64}$/.test(value || '')) throw fail('A pinned SHA-256 identity is required.'); };
// Refuse linked ancestors/files instead of allowing a second experiment to alias the first.
const checkPath = async (file) => {
  const target = absolute(file);
  let current = path.parse(target).root;
  for (const segment of path.relative(current, target).split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink() || (!info.isDirectory() && current !== target) || (info.isFile() && info.nlink !== 1)) throw fail('Experiment paths must not contain links or aliases.');
  }
};
const readRegular = async (file, limit) => {
  await checkPath(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit) throw fail('Experiment input is not a bounded regular file.');
  return readFile(file);
};
const inputName = (name) => {
  const parts = String(name).split('/');
  if (!name || name.includes('\\') || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)
    || ['.', '..', '.git', '.claude', '.codex', '.mcp.json', 'claude.md', 'claude.local.md', 'agents.md'].includes(part.toLowerCase())
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || part.endsWith('.'))) throw fail('Initial input names must be portable and must not contain Agent configuration or Git history.');
  return name;
};
const layout = (rootDir) => ({
  rootDir, dataDir: path.join(rootDir, 'data'), runtimeDir: path.join(rootDir, 'runtime'),
  inputDir: path.join(rootDir, 'input'), experienceDir: path.join(rootDir, 'runtime', 'experiences'),
});
const environmentFor = (paths, manifestDigest, condition) => ({
  OPERATOR_EXPERIMENT_ROOT: paths.rootDir, OPERATOR_EXPERIMENT_MANIFEST_SHA256: manifestDigest,
  OPERATOR_STORAGE_ROOT: paths.rootDir, OPERATOR_DATA_DIR: paths.dataDir, OPERATOR_RUNTIME_DIR: paths.runtimeDir,
  OPERATOR_BRIDGE_DIR: path.join(paths.runtimeDir, 'agent-bridge'),
  OPERATOR_LOCAL_C500_DIR: path.join(paths.runtimeDir, 'local-c500'),
  OPERATOR_EXECUTION_PACKAGE_DIR: path.join(paths.runtimeDir, 'execution-packages'),
  OPERATOR_RUNTIME_MODE: 'claude-code', OPERATOR_EXPERIENCE_CONDITION: condition,
  OPERATOR_CLAUDE_EXPERIMENT_ISOLATION: '1',
});

/** Freeze a validated read of a repository, or an explicit empty initial history.
 * Exclusive creation never edits/replaces the source repository or a prior snapshot. */
export async function freezeExperienceSnapshot({ snapshotPath, repository = null }) {
  const file = absolute(snapshotPath);
  await checkPath(file);
  if (repository && path.resolve(repository.path) === file) throw fail('Snapshot must not replace its source store.');
  const store = validateExperienceStore(repository ? await repository.read() : emptyExperienceStore());
  const bytes = Buffer.from(canonical(store) + '\n');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return { snapshotPath: file, snapshotDigest: digest(bytes), revision: store.revision, records: store.records.length };
}

/** Reserve a NEW directory; a partial preparation is retained and is not resumable.
 * Resume uses inspectIndependentExperiment, never copies the initial store again. */
export async function createIndependentExperiment({ rootDir, experimentId, snapshotPath, snapshotDigest,
  files, configuration = {}, condition = 'local-only', memoryMode }) {
  const root = absolute(rootDir);
  const snapshot = absolute(snapshotPath);
  assertDigest(snapshotDigest);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(experimentId || '')) throw fail('Invalid experiment identity.');
  if (!['local-only', 'facts-only'].includes(condition)) throw fail('Independent experiments support local-only or facts-only conditions.');
  const resolvedMemoryMode = resolveExperimentMemoryMode(memoryMode, condition);
  if (inside(root, snapshot)) throw fail('Frozen snapshot must remain outside the writable experiment.');
  await checkPath(root);
  const snapshotBytes = await readRegular(snapshot, EXPERIENCE_LIMITS.storeBytes);
  if (digest(snapshotBytes) !== snapshotDigest) throw fail('Initial experience snapshot changed.');
  const store = validateExperienceStore(JSON.parse(snapshotBytes));
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length < 1 || Object.keys(files).length > 256) throw fail('A bounded initial source file map is required.');
  const sources = Object.entries(files).map(([name, content]) => {
    inputName(name);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 4 * 1024 * 1024) throw fail('Initial source must be bounded UTF-8 text.');
    return { path: name, sha256: digest(Buffer.from(content)), bytes: Buffer.byteLength(content) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(sources.map((item) => item.path.toLowerCase())).size !== sources.length
    || sources.reduce((sum, item) => sum + item.bytes, 0) > 16 * 1024 * 1024) throw fail('Initial files collide or exceed the total limit.');
  const configurationBytes = canonical(configuration);
  if (!configurationBytes || configurationBytes.length > 256 * 1024) throw fail('A bounded JSON configuration is required.');
  const manifest = { schemaVersion: SCHEMA, experimentId, rootDir: root, condition, memoryMode: resolvedMemoryMode,
    snapshot: { sha256: snapshotDigest, revision: store.revision, records: store.records.length },
    configuration: JSON.parse(configurationBytes), configurationDigest: digest(configurationBytes),
    sources, sourceDigest: digest(canonical(sources)), memoryPolicy: resolvedMemoryMode === 'continuous-chain' ? 'explicit-continuous-chain' : 'fixed-start-learn-within-experiment',
    agentPolicy: AGENT_POLICY, createdAt: new Date().toISOString() };
  const paths = layout(root);
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root); // EEXIST is intentional: no silent reuse/reset of a previous experiment.
  await mkdir(paths.experienceDir, { recursive: true });
  await mkdir(paths.dataDir);
  await mkdir(paths.inputDir);
  await writeFile(path.join(root, 'initial-experiences.json'), snapshotBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(paths.experienceDir, 'experiences.json'), snapshotBytes, { flag: 'wx', mode: 0o600 });
  for (const source of sources) {
    const target = path.join(paths.inputDir, ...source.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, files[source.path], { flag: 'wx', mode: 0o600 });
  }
  const bytes = canonical(manifest) + '\n';
  // Published last. A crashed preparation cannot be mistaken for a usable experiment.
  await writeFile(path.join(root, 'experiment.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { ...paths, manifest, manifestDigest: digest(bytes), environment: environmentFor(paths, digest(bytes), condition) };
}

export async function inspectIndependentExperiment({ rootDir, manifestDigest }) {
  const root = absolute(rootDir);
  assertDigest(manifestDigest);
  const bytes = await readRegular(path.join(root, 'experiment.json'), 512 * 1024);
  if (digest(bytes) !== manifestDigest) throw fail('Experiment manifest differs from its pinned identity.');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== SCHEMA || manifest.rootDir !== root) throw fail('Experiment schema or root identity differs.');
  const snapshotBytes = await readRegular(path.join(root, 'initial-experiences.json'), EXPERIENCE_LIMITS.storeBytes);
  if (digest(snapshotBytes) !== manifest.snapshot.sha256) throw fail('Frozen initial experience copy changed.');
  const initial = validateExperienceStore(JSON.parse(snapshotBytes));
  const paths = layout(root);
  // Absence must be an error here; ordinary repository.read() treats absence as empty.
  await readRegular(path.join(paths.experienceDir, 'experiences.json'), EXPERIENCE_LIMITS.storeBytes);
  const current = await createExperienceRepository({ rootDir: paths.experienceDir }).read();
  if (current.revision < initial.revision || canonical(current.records.slice(0, initial.records.length)) !== canonical(initial.records)) throw fail('Writable experience history no longer contains the frozen initial history.');
  for (const source of manifest.sources) {
    inputName(source.path);
    const content = await readRegular(path.join(paths.inputDir, ...source.path.split('/')), 4 * 1024 * 1024);
    if (content.length !== source.bytes || digest(content) !== source.sha256) throw fail('Initial task source changed.');
  }
  const observed = [];
  const walk = async (directory, prefix = '') => {
    await checkPath(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isSymbolicLink()) throw fail('Initial task tree contains a link.');
      if (item.isDirectory()) await walk(path.join(directory, item.name), relative + '/');
      else observed.push(relative);
    }
  };
  await walk(paths.inputDir);
  if (canonical(observed.sort()) !== canonical(manifest.sources.map((item) => item.path).sort())) throw fail('Initial task tree contains unrecorded files.');
  for (const target of [paths.dataDir, paths.runtimeDir, path.join(paths.runtimeDir, 'agent-bridge'), path.join(paths.runtimeDir, 'local-c500'), path.join(paths.runtimeDir, 'execution-packages')]) await checkPath(target);
  return { ...paths, manifest, manifestDigest, environment: environmentFor(paths, manifestDigest, manifest.condition),
    currentExperienceRevision: current.revision, currentExperienceRecords: current.records.length };
}

/** Startup admission, before storage migration, provider calls or listening. */
export async function inspectExperimentEnvironment(environment = process.env) {
  if (!Object.hasOwn(environment, 'OPERATOR_EXPERIMENT_ROOT')) return null;
  const experiment = await inspectIndependentExperiment({ rootDir: environment.OPERATOR_EXPERIMENT_ROOT,
    manifestDigest: environment.OPERATOR_EXPERIMENT_MANIFEST_SHA256 });
  if (experiment.manifest.agentPolicy !== AGENT_POLICY) throw fail('Experiment Agent policy differs from this Runtime; prepare a new experiment and retain the old evidence.');
  for (const [key, expected] of Object.entries(experiment.environment)) {
    if (environment[key] !== expected) throw fail(`Independent experiment environment mismatch: ${key}`);
  }
  return { experimentId: experiment.manifest.experimentId, manifestDigest: experiment.manifestDigest,
    snapshotDigest: experiment.manifest.snapshot.sha256, sourceDigest: experiment.manifest.sourceDigest,
    configurationDigest: experiment.manifest.configurationDigest, condition: experiment.manifest.condition,
    memoryMode: resolveExperimentMemoryMode(experiment.manifest.memoryMode, experiment.manifest.condition),
    initialRepositoryRevision: experiment.manifest.snapshot.revision, initialRecordCount: experiment.manifest.snapshot.records,
    memoryPolicy: experiment.manifest.memoryPolicy, agentPolicy: experiment.manifest.agentPolicy,
    currentExperienceRevision: experiment.currentExperienceRevision, currentExperienceRecords: experiment.currentExperienceRecords };
}

// Path-level provider admission complements CLI read confinement. It is not an OS sandbox.
export async function inspectExperimentAgentAccess({ rootDir, workspace, directories = [], bridgeDir }) {
  const root = absolute(rootDir);
  for (const value of [workspace, bridgeDir, ...directories]) {
    const target = absolute(value);
    if (!inside(root, target) || target === root) throw fail('Agent working/configuration roots must belong to this experiment.');
    await checkPath(target);
  }
}
