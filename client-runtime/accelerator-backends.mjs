// Pure composition descriptors. Implemented software is not hardware evidence.
const descriptor = (id, hardware, platform, device, runner, languages) => Object.freeze({
  id, hardware, target: Object.freeze({ platform, device }), runner,
  adapter: Object.freeze({ id: id === 'local-metax-c500' ? 'python-metax-c500' : 'python-' + id, version: '1', languages: Object.freeze(['python']) }),
  implementationLanguages: Object.freeze(languages),
  packagePort: Object.freeze({ adapterId: id === 'local-metax-c500' ? 'python-metax-c500' : 'python-' + id, language: 'python', environmentId: id === 'local-metax-c500' ? 'metax-c500' : id,
    candidateEntrypoint: 'run.py', acceptanceEntrypoint: 'oracle.py', candidateSourceExtensions: Object.freeze(id === 'local-metax-c500' ? ['.cu', '.cpp'] : ['.cpp']), checks: Object.freeze(['correctness', 'benchmark']) }),
});
export const ACCELERATOR_BACKENDS = Object.freeze([
  descriptor('local-metax-c500', 'C500', 'metax-maca', 'gpu', 'tools/metax-c500/runner.py', ['pytorch-python', 'mxmaca-cpp-extension', 'triton']),
  descriptor('local-ascend910b', 'Ascend910B', 'ascend-cann', 'npu', 'tools/ascend910b/runner.py', ['pytorch-python', 'ascend-cpp-extension']),
]);
export const findAcceleratorBackend = id => ACCELERATOR_BACKENDS.find(item => item.id === id) || null;
