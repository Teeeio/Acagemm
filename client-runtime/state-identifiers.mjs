import path from 'node:path';

export const safeMissionId = (missionId) => String(missionId || 'mission').replace(/[^a-zA-Z0-9._-]/g, '_');

export const projectIdForRepository = (repository = '') => `PRJ_${Buffer.from(String(repository || 'repository')).toString('hex').slice(0, 16).toUpperCase()}`;

export const projectNameForRepository = (repository = '') => path.basename(String(repository || 'repository').replaceAll('\\', '/')) || 'repository';
