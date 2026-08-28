import assert from 'node:assert/strict';
import {
  normalizeOperatorLanguage,
  operatorLanguageInstruction,
  operatorLanguageOptions,
  validateOperatorLanguageCandidate,
} from '../client-runtime/operator-language.mjs';

assert.deepEqual(operatorLanguageOptions.map((item) => item.id), [
  'pytorch-python',
  'triton',
  'cuda-cpp-extension',
  'mxmaca-cpp-extension',
]);
assert.equal(normalizeOperatorLanguage('unknown').id, 'pytorch-python');
assert.match(operatorLanguageInstruction('triton'), /@triton\.jit/);

assert.equal(validateOperatorLanguageCandidate({ language: 'pytorch-python', changedFiles: ['run.py'], entryContent: 'def run(): pass' }).passed, true);
assert.equal(validateOperatorLanguageCandidate({ language: 'triton', changedFiles: ['run.py'], entryContent: 'def run(): pass' }).contentMismatch, true);
assert.equal(validateOperatorLanguageCandidate({ language: 'triton', changedFiles: ['run.py'], entryContent: 'import triton\n@triton.jit\ndef kernel(): pass' }).passed, true);
assert.equal(validateOperatorLanguageCandidate({ language: 'cuda-cpp-extension', changedFiles: ['run.py'], entryContent: '' }).passed, false);
assert.equal(validateOperatorLanguageCandidate({ language: 'cuda-cpp-extension', changedFiles: ['run.py', 'operator.cu'], entryContent: '' }).passed, true);
assert.deepEqual(validateOperatorLanguageCandidate({ language: 'mxmaca-cpp-extension', changedFiles: ['run.py', 'notes.txt', 'operator.cpp'], entryContent: '' }).unexpected, ['notes.txt']);

const contractFor = (kernelFile) => ({
  allowedFiles: ['run.py', kernelFile, 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
  requiredWorkspaceFiles: ['run.py', kernelFile, 'torch_ref.py', 'test_correctness.py', 'bench_perf.py', 'report.md'],
  requiredChangedFiles: ['run.py'],
  requiredChangedAny: [kernelFile],
});
for (const kernelFile of ['paged_mqa_logits.py', 'flash_mla.py']) {
  const contract = contractFor(kernelFile);
  const workspaceFiles = [...contract.requiredWorkspaceFiles];
  assert.equal(validateOperatorLanguageCandidate({ language: 'triton', changedFiles: ['run.py', kernelFile], workspaceFiles, entryContent: 'import triton\n@triton.jit\ndef kernel(): pass', contract }).passed, true);
  assert.deepEqual(validateOperatorLanguageCandidate({ language: 'triton', changedFiles: ['run.py', 'report.md'], workspaceFiles, entryContent: 'import triton', contract }).missingAny, [kernelFile]);
  assert.deepEqual(validateOperatorLanguageCandidate({ language: 'triton', changedFiles: ['run.py', kernelFile], workspaceFiles: workspaceFiles.filter((file) => file !== 'report.md'), entryContent: 'import triton', contract }).missingWorkspace, ['report.md']);
}
const mqaContract = contractFor('paged_mqa_logits.py');
assert.deepEqual(validateOperatorLanguageCandidate({ language: 'triton', changedFiles: ['run.py', 'flash_mla.py'], workspaceFiles: mqaContract.requiredWorkspaceFiles, entryContent: 'import triton', contract: mqaContract }).unexpected, ['flash_mla.py'], 'the two Mission workspaces must reject each other\'s kernel file');

console.log('[operator-language] adapter selection and candidate admission passed');
