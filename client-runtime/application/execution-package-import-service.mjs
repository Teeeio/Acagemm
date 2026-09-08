const error = (message, code = 'PACKAGE_IMPORT_INVALID', status = 422) => Object.assign(new Error(message), { code, status, retryable: false });

/** Application use-case: import immutable source bytes, then issue admission. */
export const createExecutionPackageImportService = ({ store, importSource } = {}) => {
  if (!store || typeof store.prepare !== 'function' || typeof store.assemble !== 'function' || typeof importSource !== 'function') throw new TypeError('Execution package import requires a package store and source-import port.');
  const importAndPrepare = async (input = {}) => {
    if (!input.binding?.missionId || !input.binding?.workspaceId || !input.binding?.candidateId) throw error('Mission, Workspace and Candidate bindings are required.', 'PACKAGE_BINDING_REQUIRED');
    const assembled = await importSource(input);
    const admission = await store.prepare(assembled.packageDigest);
    return { packageDigest: assembled.packageDigest, manifest: assembled.manifest, admissionId: admission.admissionId, admission, source: assembled.source };
  };
  return Object.freeze({ import: importAndPrepare });
};
