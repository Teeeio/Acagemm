import assert from 'node:assert/strict';
import { createExecutionPackageRoutes } from '../client-runtime/server/execution-package-routes.mjs';
let response;
const route = createExecutionPackageRoutes({
  json: (_res, status, body) => { response = { status, body }; },
  readJson: async () => ({ binding: { missionId: 'm', workspaceId: 'w', candidateId: 'c' } }),
  imports: { import: async (input) => ({ packageDigest: 'p1', ...input }) },
});
assert.equal(await route({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/execution-packages/import' } }), true);
assert.equal(response.status, 201); assert.equal(response.body.packageDigest, 'p1');
assert.equal(await route({ request: { method: 'GET' }, response: {}, url: { pathname: '/api/execution-packages/import' } }), false);
console.log('[execution-package-routes] import route mapping passed');
