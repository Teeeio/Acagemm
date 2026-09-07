import { appendExperience, readExperiences, retrieveExperienceContext, updateExperience } from '../experience-contract.mjs';

export function createExperienceService({ repository, now, createId } = {}) {
  if (!repository || typeof repository.read !== 'function' || typeof repository.transact !== 'function') throw new TypeError('repository.read and repository.transact are required');
  if (typeof now !== 'function') throw new TypeError('now must be an injected ISO timestamp function');
  if (typeof createId !== 'function') throw new TypeError('createId must be an injected identifier function');
  return Object.freeze({
    read: async (id = null, options) => readExperiences(await repository.read(), id, options),
    create: async (input) => repository.transact((draft) => appendExperience(draft, input, { id: createId(), now: now(), source: 'human' })),
    update: async (id, patch, options) => repository.transact((draft) => updateExperience(draft, id, patch, options, { now: now() })),
    recordObservation: async (input) => repository.transact((draft) => appendExperience(draft, input, { id: createId(), now: now(), source: 'execution' })),
    retrieve: async (query) => retrieveExperienceContext(await repository.read(), query, { now: now() }),
  });
}
