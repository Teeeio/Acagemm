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

console.log('[operator-language] adapter selection and candidate admission passed');
