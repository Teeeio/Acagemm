import assert from 'node:assert/strict';
import { createExecutionPackageImportService } from '../client-runtime/application/execution-package-import-service.mjs';

let imported = 0; let prepared = 0;
const service = createExecutionPackageImportService({
  store: { assemble: () => {}, prepare: async (digest) => { prepared += 1; return { admissionId: 'a1', packageDigest: digest }; } },
  importSource: async (input) => { imported += 1; return { packageDigest: 'p1', manifest: {}, source: { type: 'directory' }, ...input }; },
});
await assert.rejects(() => service.import({}), (error) => error.code === 'PACKAGE_BINDING_REQUIRED');
const result = await service.import({ binding: { missionId: 'm', workspaceId: 'w', candidateId: 'c' }, sourcePath: 'source' });
assert.equal(result.packageDigest, 'p1');
assert.equal(result.admissionId, 'a1');
assert.equal(imported, 1); assert.equal(prepared, 1);
assert.throws(() => createExecutionPackageImportService({ store: {}, importSource: () => {} }), TypeError);
console.log('[execution-package-import-service] binding, import and admission orchestration passed');
