import path from 'node:path';
import { createHash } from 'node:crypto';

export const safeMissionId = (missionId) => String(missionId || 'mission').replace(/[^a-zA-Z0-9._-]/g, '_');

export const projectIdForRepository = (repository = '') => `PRJ_${createHash('sha256').update(String(repository || 'repository')).digest('hex').slice(0, 32).toUpperCase()}`;

export const projectNameForRepository = (repository = '') => path.basename(String(repository || 'repository').replaceAll('\\', '/')) || 'repository';
