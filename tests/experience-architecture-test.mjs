// Contract tests for the experience architecture dimension and cross-dimension AND.
// Pure in-memory contract coverage: no Agent, network, filesystem or hardware execution.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendExperience,
  emptyExperienceStore,
  readExperiences,
  retrieveExperienceContext,
  validateExperienceStore,
} from '../client-runtime/experience-contract.mjs';

const NOW = '2026-09-12T00:00:00.000Z';
const LATER = '2026-09-12T00:10:00.000Z';
const digest = (char) => char.repeat(64);
const rejects = (fn, code, label) => assert.throws(fn, (error) => error.code === code, label);
const human = (overrides = {}) => ({
  projectId: 'project-a',
  title: 'Historic reduction guidance',
  content: 'Compare against the independent reference before changing reduction order.',
  author: 'tester',
  ...overrides,
});
const evidence = (overrides = {}) => ({
  missionId: 'mission-one',
  candidateId: 'candidate-one',
  runId: 'run-one',
  patchDigest: digest('a'),
  packageDigest: digest('b'),
  environmentDigest: digest('c'),
  acceptanceDigest: digest('d'),
  hardware: 'nvidia-gpu',
  executionMode: 'gpu',
  outcome: 'passed',
  operation: 'test',
  liveHardware: true,
  ...overrides,
});
const query = (scope, overrides = {}) => ({
  projectId: 'project-a',
  missionId: 'mission-next',
  roundId: 'round-2',
  scope,
  ...overrides,
});

test('cross-dimension AND rejects an nvidia-gpu+sm100 record for an nvidia-gpu+sm86 query', () => {
  const store = emptyExperienceStore();
  appendExperience(store, human({ scope: { hardware: ['nvidia-gpu'], architecture: ['sm100'] } }), { id: 'EXP_AND', now: NOW });

  const foreignArchitecture = retrieveExperienceContext(store, query({ hardware: ['nvidia-gpu'], architecture: ['sm86'] }), { now: LATER });
  assert.equal(foreignArchitecture.items.length, 0, 'vendor match must not satisfy a different architecture dimension');
  assert.deepEqual(foreignArchitecture.versions, {});

  const ownArchitecture = retrieveExperienceContext(store, query({ hardware: ['nvidia-gpu'], architecture: ['sm100'] }), { now: LATER });
  assert.equal(ownArchitecture.items.length, 1);
  assert.equal(ownArchitecture.items[0].id, 'EXP_AND');
});

test('within-dimension OR is preserved for architecture and hardware', () => {
  const store = emptyExperienceStore();
  appendExperience(store, human({ title: 'Multi-architecture guidance', scope: { architecture: ['sm100', 'sm86'] } }), { id: 'EXP_ARCH_OR', now: NOW });
  appendExperience(store, human({ title: 'Multi-vendor guidance', scope: { hardware: ['nvidia-gpu', 'amd-gpu'] } }), { id: 'EXP_HW_OR', now: NOW });

  const byArchitecture = retrieveExperienceContext(store, query({ architecture: ['sm86'] }), { now: LATER });
  assert.deepEqual(byArchitecture.items.map((item) => item.id), ['EXP_ARCH_OR']);

  const byHardware = retrieveExperienceContext(store, query({ hardware: ['amd-gpu'] }), { now: LATER });
  assert.deepEqual(byHardware.items.map((item) => item.id).sort(), ['EXP_HW_OR']);
});

test('an undeclared architecture dimension does not constrain historical records', () => {
  const store = emptyExperienceStore();
  appendExperience(store, human({ scope: { hardware: ['nvidia-gpu'] } }), { id: 'EXP_NO_ARCH', now: NOW });

  const context = retrieveExperienceContext(store, query({ hardware: ['nvidia-gpu'], architecture: ['sm86'] }), { now: LATER });
  assert.equal(context.items.length, 1, 'absent architecture means "no constraint", not "must not match"');
  assert.equal(Object.hasOwn(context.items[0].scope, 'architecture'), false);
});

test('execution architecture is stamped only from the declared evidence', () => {
  const store = emptyExperienceStore();
  const { result } = appendExperience(store, {
    projectId: 'project-a',
    title: 'GPU observation',
    content: 'Shared GPU run passed; evidence remains non-publishable.',
    author: 'runner',
    evidence: evidence({ architecture: 'sm86' }),
  }, { id: 'EXP_STAMP', now: NOW, source: 'execution' });

  assert.deepEqual(result.experience.scope.architecture, ['sm86']);
  assert.deepEqual(result.experience.scope.hardware, ['nvidia-gpu']);
  assert.deepEqual(result.experience.verification, { status: 'observed', evidenceClass: 'hardware-observation', publishable: false });
  assert.equal(result.experience.evidence.architecture, 'sm86');
  assert.equal(validateExperienceStore(store), store);
});

test('an execution caller cannot stamp an architecture the evidence never declared', () => {
  const store = emptyExperienceStore();
  const input = (overrides) => ({
    projectId: 'project-a',
    title: 'Attempted stamp',
    content: 'The caller tries to attach an architecture without execution evidence.',
    author: 'runner',
    ...overrides,
  });

  // Review-required negative: evidence has no architecture while the caller scope declares one.
  rejects(() => appendExperience(store, input({
    scope: { hardware: ['nvidia-gpu'], architecture: ['sm100'] },
    evidence: evidence(),
  }), { id: 'EXP_BAD_MISSING', now: NOW, source: 'execution' }), 'EXPERIENCE_INVALID', 'missing evidence architecture must be rejected');

  // The caller may not contradict or broaden a declared evidence architecture either.
  rejects(() => appendExperience(store, input({
    scope: { hardware: ['nvidia-gpu'], architecture: ['sm100'] },
    evidence: evidence({ architecture: 'sm86' }),
  }), { id: 'EXP_BAD_MISMATCH', now: NOW, source: 'execution' }), 'EXPERIENCE_INVALID', 'scope must match evidence architecture exactly');

  rejects(() => appendExperience(store, input({
    scope: { hardware: ['nvidia-gpu'], architecture: ['sm86', 'sm90'] },
    evidence: evidence({ architecture: 'sm86' }),
  }), { id: 'EXP_BAD_MULTI', now: NOW, source: 'execution' }), 'EXPERIENCE_INVALID', 'execution scope architecture is single-valued');

  assert.equal(store.records.length, 0, 'rejected inputs must not be retained');
});

test('historical canonical stores without architecture validate with zero migration and stay readable', () => {
  const store = emptyExperienceStore();
  appendExperience(store, human({ scope: { hardware: ['nvidia-gpu'] } }), { id: 'EXP_OLD_HUMAN', now: NOW });
  appendExperience(store, {
    projectId: 'project-a',
    title: 'Old GPU observation',
    content: 'Recorded before architecture was collected from the driver.',
    author: 'runner',
    evidence: evidence(),
  }, { id: 'EXP_OLD_EXECUTION', now: NOW, source: 'execution' });

  const snapshot = JSON.stringify(store);
  assert.equal(validateExperienceStore(store), store, 'canonical validation must accept the old shape by reference');
  assert.equal(JSON.stringify(store), snapshot, 'validation must not rewrite or normalize migrated fields');

  const humanRecord = readExperiences(store, 'EXP_OLD_HUMAN', { projectId: 'project-a' }).experience;
  assert.equal(Object.hasOwn(humanRecord.scope, 'architecture'), false);
  const executionRecord = readExperiences(store, 'EXP_OLD_EXECUTION', { projectId: 'project-a' }).experience;
  assert.equal(Object.hasOwn(executionRecord.scope, 'architecture'), false);
  assert.equal(Object.hasOwn(executionRecord.evidence, 'architecture'), false);

  const context = retrieveExperienceContext(store, query({ hardware: ['nvidia-gpu'], architecture: ['sm86'] }), { now: LATER });
  assert.deepEqual(context.items.map((item) => item.id).sort(), ['EXP_OLD_EXECUTION', 'EXP_OLD_HUMAN']);
});

test('frozen historical snapshots never gain an architecture attribute', () => {
  const store = emptyExperienceStore();
  appendExperience(store, human({ scope: { hardware: ['nvidia-gpu'] } }), { id: 'EXP_FROZEN', now: NOW });

  const context = retrieveExperienceContext(store, query({ hardware: ['nvidia-gpu'], architecture: ['sm86'] }), { now: LATER });
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.items[0].scope));
  assert.equal(Object.hasOwn(context.items[0].scope, 'architecture'), false, 'the current architecture must not be projected onto history');

  const sm100 = retrieveExperienceContext(store, query({ hardware: ['nvidia-gpu'], architecture: ['sm100'] }), { now: LATER });
  assert.equal(sm100.items.length, 1, 'an undeclared historical record is not pinned to the current architecture');
  assert.equal(Object.hasOwn(sm100.items[0].scope, 'architecture'), false);
});
