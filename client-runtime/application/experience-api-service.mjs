import { experienceError } from '../experience-contract.mjs';

export function createExperienceApiService({ loadState, experiences } = {}) {
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
    for (const key of ['projectId', 'allowedProjectIds', 'evidence', 'verification', 'source', 'kind']) {
      if (Object.hasOwn(body, key)) throw experienceError('EXPERIENCE_INVALID', key + ' is not a writable API field.');
    }
    return body;
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
  });
}
