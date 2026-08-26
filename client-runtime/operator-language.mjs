const adapters = [
  {
    id: 'pytorch-python',
    label: 'PyTorch Python',
    entry: 'run.py',
    allowedFiles: ['run.py'],
    requiredFiles: ['run.py'],
    sourceExtensions: ['.py'],
    agentInstruction: 'Implement the optimized operator in PyTorch Python inside run.py. Do not add native extension source files.',
  },
  {
    id: 'triton',
    label: 'Triton',
    entry: 'run.py',
    allowedFiles: ['run.py'],
    requiredFiles: ['run.py'],
    sourceExtensions: ['.py'],
    requiredContent: /(?:import|from)\s+triton\b|@triton\.jit/,
    agentInstruction: 'Implement the optimized operator as a Triton kernel in run.py. The run(inputs) bridge must launch the @triton.jit kernel on C500 through the installed PyTorch/MXMACA environment.',
  },
  {
    id: 'cuda-cpp-extension',
    label: 'CUDA C++ Extension',
    entry: 'run.py',
    allowedFiles: ['run.py', 'operator.cu', 'operator.cpp', 'CMakeLists.txt'],
    requiredFiles: ['run.py'],
    requiredAny: ['operator.cu'],
    sourceExtensions: ['.cu', '.cpp'],
    agentInstruction: 'Implement the optimized operator in operator.cu (and operator.cpp only when a binding is needed). run.py is a thin executable bridge that builds/loads the extension with the target machine toolchain and exposes the fixed test contract.',
  },
  {
    id: 'mxmaca-cpp-extension',
    label: 'MXMACA C++ Extension',
    entry: 'run.py',
    allowedFiles: ['run.py', 'operator.cu', 'operator.cpp', 'CMakeLists.txt'],
    requiredFiles: ['run.py'],
    requiredAny: ['operator.cu', 'operator.cpp'],
    sourceExtensions: ['.cu', '.cpp'],
    agentInstruction: 'Implement the optimized operator as an MXMACA-compatible native extension in operator.cu/operator.cpp. run.py is only the build/load and fixed test-contract bridge. Use the C500 machine toolchain exposed by the test environment; do not replace the native operator with a PyTorch implementation.',
  },
];

export const operatorLanguageOptions = adapters.map(({ requiredContent, ...adapter }) => structuredClone(adapter));

export const normalizeOperatorLanguage = (input) => {
  const id = typeof input === 'string' ? input : input?.id;
  const adapter = adapters.find((item) => item.id === id) || adapters[0];
  const { requiredContent, ...publicAdapter } = adapter;
  return structuredClone(publicAdapter);
};

export const operatorLanguageInstruction = (input) => {
  const adapter = adapters.find((item) => item.id === normalizeOperatorLanguage(input).id) || adapters[0];
  return [
    `Implementation language contract: ${adapter.label} (${adapter.id}).`,
    adapter.agentInstruction,
    `Allowed candidate files: ${adapter.allowedFiles.join(', ')}.`,
    `Executable entry: ${adapter.entry}.`,
  ].join('\n');
};

export const validateOperatorLanguageCandidate = ({ language, changedFiles = [], entryContent = '' } = {}) => {
  const adapter = adapters.find((item) => item.id === normalizeOperatorLanguage(language).id) || adapters[0];
  const files = changedFiles.map((file) => String(file).replaceAll('\\', '/'));
  const unexpected = files.filter((file) => !adapter.allowedFiles.includes(file));
  const missing = adapter.requiredFiles.filter((file) => !files.includes(file));
  const anySatisfied = !adapter.requiredAny?.length || adapter.requiredAny.some((file) => files.includes(file));
  const contentMatches = !adapter.requiredContent || adapter.requiredContent.test(String(entryContent || ''));
  return {
    passed: unexpected.length === 0 && missing.length === 0 && anySatisfied && contentMatches,
    language: adapter.id,
    unexpected,
    missing,
    missingAny: anySatisfied ? [] : adapter.requiredAny,
    contentMismatch: !contentMatches,
  };
};
