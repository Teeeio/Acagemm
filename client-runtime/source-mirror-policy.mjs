import { readFile } from 'node:fs/promises';
import path from 'node:path';

const canonicalHosts = new Set(['github.com', 'gitlab.com']);
const fullObjectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

const policyError = (message, code, details = null) => {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
};

const parseHttpsRepository = (value, label) => {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw policyError(`${label} 必须是有效的 HTTPS Git 仓库地址。`, 'SOURCE_REPOSITORY_URL_INVALID');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw policyError(`${label} 只允许不含凭据、查询参数和片段的 HTTPS 地址。`, 'SOURCE_REPOSITORY_URL_UNSAFE');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment.replace(/\.git$/i, '')))) {
    throw policyError(`${label} 必须指向明确的仓库路径。`, 'SOURCE_REPOSITORY_URL_INVALID');
  }
  parsed.pathname = `/${segments.join('/').replace(/\.git$/i, '')}`;
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed;
};

export const normalizeRepositoryIdentity = (value) => {
  const parsed = parseHttpsRepository(value, 'Git 仓库地址');
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase();
};

export const validateCanonicalRepository = (value) => {
  const parsed = parseHttpsRepository(value, 'Canonical Source');
  if (!canonicalHosts.has(parsed.hostname)) {
    throw policyError(`Research Agent 返回了不受支持的 canonical source：${value}`, 'RESEARCH_SOURCE_SELECTION_UNSAFE');
  }
  if (parsed.pathname.split('/').filter(Boolean).length !== 2) {
    throw policyError(`Canonical Source 必须是 GitHub/GitLab 的 owner/repository 地址：${value}`, 'RESEARCH_SOURCE_SELECTION_UNSAFE');
  }
  return String(value).trim();
};

export const validateDiscoveredRepository = (value) => {
  parseHttpsRepository(value, 'Discovered Source');
  return String(value).trim();
};

const validateTransportRepository = (value) => {
  parseHttpsRepository(value, 'Transport Source');
  return String(value).trim();
};

const normalizeMirror = (entry, index) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw policyError(`mirrors[${index}] 必须是对象。`, 'SOURCE_MIRROR_CONFIG_INVALID');
  }
  const canonical = validateCanonicalRepository(entry.canonical);
  const transport = validateTransportRepository(entry.transport);
  const requiredCommit = String(entry.requiredCommit || '').trim().toLowerCase();
  const requiredTree = String(entry.requiredTree || '').trim().toLowerCase();
  if (!fullObjectIdPattern.test(requiredCommit)) {
    throw policyError(`mirrors[${index}].requiredCommit 必须是完整的 Git object id。`, 'SOURCE_MIRROR_COMMIT_REQUIRED');
  }
  if (requiredTree && !fullObjectIdPattern.test(requiredTree)) {
    throw policyError(`mirrors[${index}].requiredTree 必须是完整的 Git tree id。`, 'SOURCE_MIRROR_TREE_INVALID');
  }
  return {
    canonical,
    canonicalIdentity: normalizeRepositoryIdentity(canonical),
    transport,
    requiredCommit,
    requiredTree: requiredTree || null,
  };
};

export const parseSourceMirrorPolicy = (document, { configPath = null } = {}) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw policyError('Source mirror 配置必须是 JSON 对象。', 'SOURCE_MIRROR_CONFIG_INVALID');
  }
  if (Number(document.schemaVersion) !== 1 || !Array.isArray(document.mirrors)) {
    throw policyError('Source mirror 配置必须使用 schemaVersion=1 且包含 mirrors 数组。', 'SOURCE_MIRROR_CONFIG_INVALID');
  }
  const mirrors = document.mirrors.map(normalizeMirror);
  const identities = mirrors.map((entry) => entry.canonicalIdentity);
  if (new Set(identities).size !== identities.length) {
    throw policyError('Source mirror 配置包含重复的 canonical repository。', 'SOURCE_MIRROR_CONFIG_DUPLICATE');
  }
  return {
    schemaVersion: 1,
    configPath,
    configured: true,
    requireMirror: document.requireMirror === true,
    mirrors,
  };
};

export const loadSourceMirrorPolicy = async ({ configPath = process.env.OPERATOR_SOURCE_MIRROR_CONFIG } = {}) => {
  if (!configPath) return { schemaVersion: 1, configPath: null, configured: false, requireMirror: false, mirrors: [] };
  const resolvedPath = path.resolve(configPath);
  let document;
  try {
    document = JSON.parse(await readFile(resolvedPath, 'utf8'));
  } catch (cause) {
    throw policyError(`无法读取 Source mirror 配置：${cause.message}`, 'SOURCE_MIRROR_CONFIG_READ_FAILED', { configPath: resolvedPath });
  }
  return parseSourceMirrorPolicy(document, { configPath: resolvedPath });
};

export const resolveSourceTransport = (canonical, policy, { allowDiscoveredSources = false } = {}) => {
  let validatedCanonical;
  try {
    validatedCanonical = validateCanonicalRepository(canonical);
  } catch (error) {
    if (!allowDiscoveredSources || error.code !== 'RESEARCH_SOURCE_SELECTION_UNSAFE') throw error;
    validatedCanonical = validateDiscoveredRepository(canonical);
  }
  const canonicalIdentity = normalizeRepositoryIdentity(validatedCanonical);
  const mirror = policy?.mirrors?.find((entry) => entry.canonicalIdentity === canonicalIdentity) || null;
  if (!mirror && policy?.requireMirror) {
    throw policyError(`当前环境要求 Source mirror，但未配置 ${validatedCanonical}。`, 'SOURCE_MIRROR_REQUIRED', { canonical: validatedCanonical });
  }
  return mirror ? {
    mode: 'mirror',
    canonical: mirror.canonical,
    canonicalIdentity,
    transport: mirror.transport,
    requiredCommit: mirror.requiredCommit,
    requiredTree: mirror.requiredTree,
    configPath: policy.configPath,
  } : {
    mode: canonicalHosts.has(new URL(validatedCanonical).hostname.toLowerCase()) ? 'canonical' : 'discovered',
    canonical: validatedCanonical,
    canonicalIdentity,
    transport: validatedCanonical,
    requiredCommit: null,
    requiredTree: null,
    configPath: policy?.configPath || null,
  };
};

export const verifySourceTransportSnapshot = ({ resolution, commit, tree }) => {
  const actualCommit = String(commit || '').trim().toLowerCase();
  const actualTree = String(tree || '').trim().toLowerCase();
  if (!fullObjectIdPattern.test(actualCommit) || !fullObjectIdPattern.test(actualTree)) {
    throw policyError('克隆后的 Source 缺少完整 commit 或 tree identity。', 'SOURCE_SNAPSHOT_IDENTITY_INVALID');
  }
  if (resolution.requiredCommit && actualCommit !== resolution.requiredCommit) {
    throw policyError('Source mirror HEAD 与管理员固定 commit 不一致。', 'SOURCE_MIRROR_COMMIT_MISMATCH', {
      canonical: resolution.canonical,
      transport: resolution.transport,
      expected: resolution.requiredCommit,
      actual: actualCommit,
    });
  }
  if (resolution.requiredTree && actualTree !== resolution.requiredTree) {
    throw policyError('Source mirror tree 与管理员固定 tree 不一致。', 'SOURCE_MIRROR_TREE_MISMATCH', {
      canonical: resolution.canonical,
      transport: resolution.transport,
      expected: resolution.requiredTree,
      actual: actualTree,
    });
  }
  return {
    mode: resolution.mode,
    canonicalRepository: resolution.canonical,
    transportRepository: resolution.transport,
    commit: actualCommit,
    tree: actualTree,
    mirrorVerified: resolution.mode === 'mirror',
    pin: resolution.requiredTree ? 'commit+tree' : resolution.requiredCommit ? 'commit' : 'runtime-head',
    configPath: resolution.configPath,
  };
};
