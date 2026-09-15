import { appendExperience, experienceError, readExperiences, retrieveExperienceContext, retrieveExperienceSelection, updateExperience } from '../experience-contract.mjs';
import { applyKernelWikiSnapshot } from '../kernel-wiki-import.mjs';

// selectionMetadata 只能经显式 KernelWiki 导入入口写入。通用 create/update 一律拒绝，
// 避免给普通 CRUD 开一条元数据后门，也保证旧 schema-1 记录/快照零迁移。
const withoutSelectionMetadata = (value, api) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'selectionMetadata')) {
    throw experienceError('EXPERIENCE_INVALID', `selectionMetadata is not writable through ${api}; it is only accepted by the explicit KernelWiki import API.`, 400);
  }
  return value;
};

export function createExperienceService({ repository, now, createId } = {}) {
  if (!repository || typeof repository.read !== 'function' || typeof repository.transact !== 'function') throw new TypeError('repository.read and repository.transact are required');
  if (typeof now !== 'function') throw new TypeError('now must be an injected ISO timestamp function');
  if (typeof createId !== 'function') throw new TypeError('createId must be an injected identifier function');
  return Object.freeze({
    read: async (id = null, options) => readExperiences(await repository.read(), id, options),
    create: async (input) => {
      withoutSelectionMetadata(input, 'create');
      return repository.transact((draft) => appendExperience(draft, input, { id: createId(), now: now(), source: 'human' }));
    },
    update: async (id, patch, options) => {
      withoutSelectionMetadata(patch, 'update');
      return repository.transact((draft) => updateExperience(draft, id, patch, options, { now: now() }));
    },
    recordObservation: async (input) => repository.transact((draft) => appendExperience(draft, input, { id: createId(), now: now(), source: 'execution' })),
    retrieve: async (query) => retrieveExperienceContext(await repository.read(), query, { now: now() }),
    retrieveWithSelection: async (query) => retrieveExperienceSelection(await repository.read(), query, { now: now() }),
    // 生产导入入口：纯 apply 负责快照/摘要/幂等/版本推进/全量校验，这里只提供唯一事务边界
    // 与注入时钟。没有第二个 repository、side-index 文件或第二套存储事务。
    importKernelWiki: async (snapshot, { projectId, author } = {}) => repository.transact(
      (draft) => applyKernelWikiSnapshot(draft, snapshot, { projectId, now: now(), author }),
    ),
  });
}
