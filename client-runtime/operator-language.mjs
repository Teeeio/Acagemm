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
    // The language adapter states the language, not the device. Which machine the
    // run targets is decided by the Mission's hardware/test matrix, so a generic
    // Triton Mission must not be told it runs on C550 through MXMACA — that
    // wording belongs to the fixed C550 Profiles, which supply their own prompt.
    agentInstruction: 'Implement the optimized operator as a Triton kernel in run.py. The run(inputs) bridge must launch the @triton.jit kernel on the target device through the installed PyTorch/Triton environment.',
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
    agentInstruction: 'Implement the optimized operator as an MXMACA-compatible native extension in operator.cu/operator.cpp. run.py is only the build/load and fixed test-contract bridge. Use the selected MetaX machine toolchain exposed by the test environment; do not replace the native operator with a PyTorch implementation.',
  },
  { id: 'ascend-cpp-extension', label: 'Ascend C++ binding', entry: 'run.py',
    allowedFiles: ['run.py', 'operator.cpp', 'CMakeLists.txt'], requiredFiles: ['run.py'], requiredAny: ['operator.cpp'], sourceExtensions: ['.cpp'],
    agentInstruction: 'Implement an Ascend910B C++ binding in operator.cpp. run.py uses the installed TorchNPU NpuExtension metadata through operator_studio_ascend.load_npu_extension. Use only the target image toolchain; raw Ascend C device kernels need an explicitly admitted release-specific recipe. Never fall back to CPU or CUDA.' },
];

export const operatorLanguageOptions = adapters.map(({ requiredContent, ...adapter }) => structuredClone(adapter));

// An unrecognized id is not PyTorch. Substituting adapters[0] here would let any
// caller that skips the intake check pin a Mission to a language nobody chose,
// and would silently apply PyTorch's file contract to it. The projection layer
// must tolerate a historical record (never throw while loading), so the unknown
// case is represented explicitly and rejects candidates instead of accepting
// them under the wrong language's rules.
export const UNKNOWN_OPERATOR_LANGUAGE_ID = 'unknown';
export const OPERATOR_LANGUAGE_UNSUPPORTED = 'GENERIC_MISSION_LANGUAGE_UNSUPPORTED';

const unknownAdapter = Object.freeze({
  id: UNKNOWN_OPERATOR_LANGUAGE_ID,
  label: '未知语言',
  entry: '',
  allowedFiles: [],
  requiredFiles: [],
  sourceExtensions: [],
  agentInstruction: 'This Mission names an implementation language that is not a supported adapter, so no language contract can be applied.',
});

// Aliases the Mission spec entry accepts. Stored records carry both the canonical
// `id` and the raw `language` the requester typed, so resolving only `id` would
// let the two disagree — and the value that was actually validated is `language`.
const languageAliases = Object.freeze({
  python: 'pytorch-python',
  pytorch: 'pytorch-python',
  'pytorch-python': 'pytorch-python',
  triton: 'triton',
  cuda: 'cuda-cpp-extension',
  'cuda-cpp': 'cuda-cpp-extension',
  'cuda-cpp-extension': 'cuda-cpp-extension',
  'mxmaca-cpp-extension': 'mxmaca-cpp-extension',
});

const declaredIds = (input) => {
  if (typeof input === 'string') return input ? [input] : [];
  if (!input || typeof input !== 'object') return [];
  return [input.id, input.language]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase());
};

const canonicalId = (value) => languageAliases[value] || value;

const findAdapter = (input) => {
  const [first] = declaredIds(input);
  if (!first) return null;
  return adapters.find((item) => item.id === canonicalId(first)) || null;
};

// One resolution rule for every projection helper, matching the intake rule:
// a caller that declared nothing keeps the historical PyTorch default (it never
// chose a language, so it has nothing to be wrong about), while a declared but
// unrecognized language resolves to the unknown adapter and is refused rather than
// silently judged under PyTorch's file contract (T01). Without this split, every
// legacy caller that omits `implementation` would suddenly be treated as unknown.
const adapterForInput = (input) => findAdapter(input) || (declaredIds(input).length ? unknownAdapter : adapters[0]);

export const isKnownOperatorLanguage = (input) => findAdapter(input) !== null;

export const normalizeOperatorLanguage = (input) => {
  const { requiredContent, ...publicAdapter } = adapterForInput(input);
  return structuredClone(publicAdapter);
};

// Intake/create paths call this. Two cases are deliberately different:
//   - no language declared at all keeps the historical PyTorch default, because
//     callers that never chose a language (internal creates, legacy records) have
//     nothing to be wrong about;
//   - a declared but unrecognized language is refused, because falling back to
//     PyTorch would silently pin the Mission to a language nobody chose and apply
//     PyTorch's file contract to it (T01).
// A record that declares both `id` and `language` must have them agree; otherwise
// the value that was validated is not the value that would be used.
export const assertKnownOperatorLanguage = (input) => {
  const ids = declaredIds(input).map(canonicalId);
  const adapter = findAdapter(input);
  const reject = (detail) => {
    const error = new Error(`${detail}。可选值：${adapters.map((item) => item.id).join(', ')}。`);
    error.code = OPERATOR_LANGUAGE_UNSUPPORTED;
    error.status = 400;
    return error;
  };
  if (!ids.length) return adapters[0];
  if (!adapter) throw reject(`不支持的实现语言：${declaredIds(input).join(' / ')}`);
  if (new Set(ids).size > 1) throw reject(`实现语言的 id 与 language 声明不一致：${declaredIds(input).join(' / ')}`);
  return adapter;
};

// required-existing and required-changed are different questions, and only one
// answer may serve both the prompt and the admission check. The entry file is the
// build/load bridge: it must exist in every candidate workspace (requiredFiles,
// checked against the workspace inventory). What the diff must *change* is the
// adapter's designated work file when it has one — for the native-extension
// languages that is operator.cu/operator.cpp — so a candidate whose whole change
// is inside the kernel file is not forced into a meaningless bridge edit. A
// contract supplied by a fixed Profile still wins unchanged, which keeps the
// built-in C550 Profile contracts exactly as frozen.
export const operatorLanguageChangedRequirement = (input, contract = null) => {
  const adapter = adapterForInput(input);
  const anyFiles = contract?.requiredChangedAny || adapter.requiredAny || [];
  const files = contract?.requiredChangedFiles || (adapter.requiredAny ? [] : adapter.requiredFiles);
  return { files, any: anyFiles, filesOnly: files.length > 0 };
};

// The workspace-existence requirement has exactly one source. It used to have three
// fallbacks — `adapter.requiredFiles` in the prompt, `[]` in the admission check and a
// hardcoded `['run.py']` where the workspace inventory is collected — so a generic
// Mission (one without a fixed Profile contract) was told a file "must exist in every
// complete candidate workspace" while nothing ever enforced it. A requirement the
// prompt states and the check skips is worse than no requirement: the agent is graded
// on a rule it cannot see being applied.
export const operatorLanguageWorkspaceRequirement = (input, contract = null) => {
  const adapter = adapterForInput(input);
  return [...(contract?.requiredWorkspaceFiles || adapter.requiredFiles)];
};

export const operatorLanguageInstruction = (input, contract = null) => {
  const adapter = adapterForInput(input);
  const allowedFiles = contract?.allowedFiles || adapter.allowedFiles;
  const requiredWorkspaceFiles = operatorLanguageWorkspaceRequirement(adapter, contract);
  const changed = operatorLanguageChangedRequirement(input, contract);
  const changedText = changed.files.length
    ? changed.files.join(', ')
    : changed.any.length ? `at least one of ${changed.any.join(', ')}` : 'any allowed file';
  return [
    `Implementation language contract: ${adapter.label} (${adapter.id}).`,
    adapter.agentInstruction,
    `Allowed candidate files: ${allowedFiles.join(', ')}.`,
    `Files that must exist in every complete candidate workspace: ${requiredWorkspaceFiles.join(', ')}.`,
    // Existence and change are separate requirements, so the prompt states both.
    // Without this line the admission check would enforce a change the agent was
    // never told about.
    `Files the candidate diff must change: ${changedText}.`,
    `Executable entry: ${adapter.entry}.`,
  ].join('\n');
};

export const validateOperatorLanguageCandidate = ({ language, changedFiles = [], workspaceFiles = [], entryContent = '', contract = null } = {}) => {
  const adapter = adapterForInput(language);
  const files = changedFiles.map((file) => String(file).replaceAll('\\', '/'));
  const available = workspaceFiles.map((file) => String(file).replaceAll('\\', '/'));
  // An unrecognized language has no file contract to check against, so the only
  // honest answer is to reject rather than to accept the candidate under some
  // other language's rules.
  if (adapter === unknownAdapter) {
    return {
      passed: false,
      language: UNKNOWN_OPERATOR_LANGUAGE_ID,
      unknownLanguage: true,
      unexpected: [], missing: [], missingWorkspace: [], missingAny: [],
      contentMismatch: false,
      contentPatternMatched: false,
      kernelRouteCovered: false,
      reason: `${OPERATOR_LANGUAGE_UNSUPPORTED}: 未知实现语言，无法套用任何语言契约。`,
    };
  }
  const allowedFiles = contract?.allowedFiles || adapter.allowedFiles;
  const changed = operatorLanguageChangedRequirement(adapter, contract);
  const requiredChangedFiles = changed.files;
  const requiredChangedAny = changed.any;
  // Same source as the line the prompt states, so the requirement the agent is given
  // is the requirement enforced here. The unknown-language adapter declares no
  // workspace files, so it still has nothing to enforce.
  const requiredWorkspaceFiles = operatorLanguageWorkspaceRequirement(adapter, contract);
  const unexpected = files.filter((file) => !allowedFiles.includes(file));
  const missing = requiredChangedFiles.filter((file) => !files.includes(file));
  const missingWorkspace = requiredWorkspaceFiles.filter((file) => !available.includes(file));
  const anySatisfied = !requiredChangedAny.length || requiredChangedAny.some((file) => files.includes(file));
  const contentMatches = !adapter.requiredContent || adapter.requiredContent.test(String(entryContent || ''));
  return {
    passed: unexpected.length === 0 && missing.length === 0 && missingWorkspace.length === 0 && anySatisfied && contentMatches,
    language: adapter.id,
    unknownLanguage: false,
    unexpected,
    missing,
    missingWorkspace,
    missingAny: anySatisfied ? [] : requiredChangedAny,
    contentMismatch: !contentMatches,
    // T30: the entry-content rule is a pattern match on the source text. It shows
    // the language was declared, not that a custom kernel was built and executed
    // under the fixed test contract, so it must never be reported as real
    // coverage of that kernel route. Only a completed Correctness run can say that.
    contentEvidence: adapter.requiredContent ? 'pattern_only' : 'not_required',
    contentPatternMatched: contentMatches,
    kernelRouteCovered: false,
  };
};
