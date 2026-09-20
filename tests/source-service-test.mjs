import assert from 'node:assert/strict';
import { createSourceService } from '../client-runtime/application/source-service.mjs';

const calls = [];
const service = createSourceService({
  readdir: async () => ['repo', '.git', 'notes'],
  stat: async (target) => { if (!target.endsWith('repo\\.git') && !target.endsWith('repo/.git')) throw new Error('missing'); return {}; },
  path: { join: (...parts) => parts.join('/') },
  workspaceManager: {
    git: async (args) => { calls.push(args); return { stdout: args[0] === 'rev-parse' ? 'abc\n' : 'https://example/repo\n' }; },
    updateSourceRegistry: async (input) => { calls.push(input); },
  },
});
const registered = await service.registerSources({ state: { activeMissionId: 'm1' }, mission: { sourceRoot: '/sources', projectRoot: '/project' } });
assert.equal(registered.count, 1);
assert.equal(registered.references[0].commit, 'abc');
// Registration produces a repository-level reference: it asserts the repository at a
// commit and names that scope explicitly. It must never fabricate a file path to look
// like a file reference (an empty path only ever meant "the whole repository").
assert.deepEqual(registered.references[0], { repository: 'https://example/repo', commit: 'abc', scope: 'repository' });
assert.equal(Object.hasOwn(registered.references[0], 'path'), false, 'a repository-level reference carries no path');
assert.deepEqual(await service.countSources({ mission: { sourceRoot: '/sources' } }), { count: 2 });
assert.deepEqual(await service.countSources({ mission: {} }), { count: 0 });
console.log('[source-service] registration, counting, and missing-root contracts passed');
