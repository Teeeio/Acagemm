import { experienceError } from '../experience-contract.mjs';

export function createExperienceApiService({ loadState, experiences } = {}) {
  // 只要求既有的 read/create/update 端口：导入端口仅在真正调用导入时要求，避免既有
  // read/create/update-only 组合因构造函数新增必需端口而整体失效。
  if (typeof loadState !== 'function' || ['read', 'create', 'update'].some((name) => typeof experiences?.[name] !== 'function')) {
    throw new TypeError('Experience API requires read-only state and experience service ports.');
  }
  const project = async (projectId) => {
    const state = await loadState();
    if (typeof projectId !== 'string' || !state.projects?.some((item) => item.id === projectId)) {
      throw experienceError('EXPERIENCE_PROJECT_NOT_FOUND', 'Project does not exist in this local Runtime.', 404);
    }
    // This local API does not grant cross-project sharing or tenant authentication.
    return { projectId, allowedProjectIds: [projectId] };
  };
  const bodyObject = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw experienceError('EXPERIENCE_INVALID', 'Expected an experience object.');
    // selectionMetadata 是显式导入 API 的专属字段：通用 CRUD 必须拒绝它，否则
    // 调用者可以绕过导入路径直接盖章来源/审查元数据。
    for (const key of ['projectId', 'allowedProjectIds', 'evidence', 'verification', 'source', 'kind', 'selectionMetadata']) {
      if (Object.hasOwn(body, key)) throw experienceError('EXPERIENCE_INVALID', key + ' is not a writable API field.');
    }
    return body;
  };
  // 生产导入只接受快照与作者：快照内部结构由纯导入契约校验，调用者不得注入
  // projectId/scope/verification 等负载字段。
  const importBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw experienceError('EXPERIENCE_INVALID', 'Expected a kernel wiki import object.');
    for (const key of Object.keys(body)) {
      if (key !== 'snapshot' && key !== 'author') throw experienceError('EXPERIENCE_INVALID', key + ' is not a writable API field.');
    }
    if (!Object.hasOwn(body, 'snapshot')) throw experienceError('EXPERIENCE_INVALID', 'snapshot is required.');
    return { snapshot: body.snapshot, author: body.author };
  };
  return Object.freeze({
    async list(projectId) {
      return { statusCode: 200, payload: await experiences.read(null, await project(projectId)) };
    },
    async get(projectId, id, { version } = {}) {
      return { statusCode: 200, payload: await experiences.read(id, { ...await project(projectId), ...(version !== undefined ? { version } : {}) }) };
    },
    async create(projectId, body) {
      await project(projectId);
      return { statusCode: 201, payload: await experiences.create({ ...bodyObject(body), projectId }) };
    },
    async update(projectId, id, body) {
      await project(projectId);
      const { expectedVersion, ...patch } = bodyObject(body);
      return { statusCode: 200, payload: await experiences.update(id, patch, { projectId, expectedVersion }) };
    },
    async importKernelWiki(projectId, body) {
      if (typeof experiences.importKernelWiki !== 'function') throw new TypeError('The injected Experience service does not provide importKernelWiki.');
      const access = await project(projectId);
      const { snapshot, author } = importBody(body);
      return { statusCode: 200, payload: await experiences.importKernelWiki(snapshot, { projectId: access.projectId, author }) };
    },
  });
}
