import assert from 'node:assert/strict';
import { createIterationService } from '../client-runtime/application/iteration-service.mjs';
const names = ['startResearch', 'cancelResearch', 'registerSources', 'countSources', 'startMainRound', 'startBaseline', 'researchDirForMission'];
const service = createIterationService(Object.fromEntries(names.map((name) => [name, () => name])));
assert.deepEqual(Object.keys(service), names);
assert.throws(() => createIterationService({}), /requires startResearch/);
console.log('[iteration-service] public dependency contract passed');
