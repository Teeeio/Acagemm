// Contract + filesystem-adapter tests; no Agent, network, workflow, or hardware execution.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createExperienceRepository } from '../client-runtime/experience-repository.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { EXPERIENCE_LIMITS } from '../client-runtime/experience-contract.mjs';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-experience-test-'));
let sequence = 0;
let time = '2026-09-07T12:00:00.000Z';
const roots = [];
const digest = (letter = 'a') => letter.repeat(64);
const makeService = (rootDir, filesystem) => createExperienceService({
  repository: createExperienceRepository({ rootDir, ...(filesystem ? { filesystem } : {}) }),
  now: () => time,
  createId: () => `EXP_${++sequence}`,
});
const setup = async (name) => {
  const rootDir = path.join(scratch, name);
  roots.push(rootDir);
  return { rootDir, service: makeService(rootDir), file: path.join(rootDir, 'experiences.json') };
};
const human = (overrides = {}) => ({
  projectId: 'project-a', visibility: 'project', title: 'Check reductions',
  content: 'Treat this as a suggestion; compare against the reference.', author: 'tester',
  scope: { operator: 'reduce_sum', hardware: ['cpu'], dtype: ['float32'], tags: ['reduction'], shape: { rank: 2 } },
  ...overrides,
});
const evidence = (overrides = {}) => ({
  missionId: 'mission-one', candidateId: 'candidate-one', runId: 'run-one',
  patchDigest: digest('a'), packageDigest: digest('b'), environmentDigest: digest('c'), acceptanceDigest: digest('d'),
  hardware: 'cpu', executionMode: 'cpu', outcome: 'passed', operation: 'correctness', ...overrides,
});
const observation = (overrides = {}) => human({
  title: 'CPU correctness outcome', content: 'CPU reference comparison passed.',
  evidence: evidence(), evidenceRefs: ['artifacts/run-one/result.json'], ...overrides,
});
const query = (overrides = {}) => ({
  projectId: 'project-a', missionId: 'next-mission', roundId: 'round-2',
  scope: { operator: 'reduce_sum', hardware: ['cpu'], dtype: ['float32'], tags: ['reduction'], shape: { rank: 2, length: 128 } },
  ...overrides,
});
const rejectsCode = (fn, code) => assert.rejects(fn, (error) => error.code === code);
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };

try {
  await test('dependencies and absolute storage root are explicit', async () => {
    assert.throws(() => createExperienceRepository({ rootDir: 'relative' }), /rootDir/);
    assert.throws(() => createExperienceService({}), /repository/);
    assert.throws(() => createExperienceService({ repository: { read() {}, transact() {} } }), /now/);
  });

  await test('empty reads do not create storage and human advice stays unverified', async () => {
    const { service, rootDir } = await setup('human');
    assert.deepEqual((await service.read(null, { projectId: 'project-a' })).experiences, []);
    await assert.rejects(fs.stat(rootDir), { code: 'ENOENT' });
    const created = await service.create(human());
    assert.equal(created.created, true);
    assert.equal(created.experience.source, 'human');
    assert.equal(created.experience.kind, 'guidance');
    assert.equal(created.experience.version, 1);
    assert.deepEqual(created.experience.verification, { status: 'unverified', evidenceClass: 'human-guidance', publishable: false });
    const context = await service.retrieve(query());
    assert.equal(context.items[0].useAs, 'suggestion');
    assert.equal(context.missionId, 'next-mission');
    assert.equal(context.items[0].id, created.experience.id);
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.items[0].scope.shape));
    assert.throws(() => { context.items[0].content = 'modified'; }, TypeError);
    created.experience.content = 'caller-owned mutation';
    assert.notEqual((await service.read(created.experience.id, { projectId: 'project-a' })).experience.content, 'caller-owned mutation');
  });

  await test('versions are append-only and an old round context does not change', async () => {
    const { service } = await setup('versions');
    const { experience } = await service.create(human());
    const before = await service.retrieve(query());
    time = '2026-09-07T12:01:00.000Z';
    const updated = await service.update(experience.id, { content: 'Revised advice', confidence: 'high' }, { projectId: 'project-a', expectedVersion: 1 });
    assert.equal(updated.experience.version, 2);
    assert.equal(updated.experience.createdAt, experience.createdAt);
    assert.equal(updated.experience.verification.status, 'unverified');
    assert.equal((await service.read(experience.id, { projectId: 'project-a', version: 1 })).experience.content, experience.content);
    assert.equal(before.items[0].version, 1);
    assert.equal((await service.retrieve(query())).items[0].version, 2);
    assert.deepEqual((await service.retrieve(query({ versions: { [experience.id]: 1 } }))).items, []);
    await rejectsCode(() => service.update(experience.id, { content: 'Lost update' }, { projectId: 'project-a', expectedVersion: 1 }), 'EXPERIENCE_VERSION_CONFLICT');
    await rejectsCode(() => service.update(experience.id, { content: 'No version' }, { projectId: 'project-a' }), 'EXPERIENCE_INVALID');
  });

  await test('scope, expiry, lifecycle, and project authorization filter retrieval', async () => {
    const { service } = await setup('filter');
    await service.create(human());
    await service.create(human({ scope: { operator: 'matmul' } }));
    await service.create(human({ scope: { hardware: ['c550'] } }));
    await service.create(human({ scope: { dtype: ['float16'] } }));
    await service.create(human({ scope: { shape: { rank: 3 } } }));
    await service.create(human({ scope: { tags: ['other'] } }));
    await service.create(human({ expiresAt: '2026-09-01T00:00:00.000Z' }));
    for (const status of ['archived', 'invalidated', 'conflicted']) {
      const { experience } = await service.create(human());
      await service.update(experience.id, { status }, { projectId: 'project-a', expectedVersion: 1 });
    }
    const shared = await service.create(human({ projectId: 'project-b', visibility: 'shared' }));
    await service.create(human({ projectId: 'project-b', visibility: 'project' }));
    assert.equal((await service.retrieve(query())).items.length, 1);
    assert.equal((await service.retrieve(query({ allowedProjectIds: ['project-b'] }))).items.length, 2);
    await rejectsCode(() => service.read(shared.experience.id, { projectId: 'project-a' }), 'EXPERIENCE_NOT_FOUND');
    assert.equal((await service.read(shared.experience.id, { projectId: 'project-a', allowedProjectIds: ['project-b'] })).experience.projectId, 'project-b');
    await rejectsCode(() => service.update(shared.experience.id, { content: 'Unauthorized' }, { projectId: 'project-a', expectedVersion: 1 }), 'EXPERIENCE_NOT_FOUND');
    await rejectsCode(() => service.retrieve({ missionId: 'm', roundId: 'r', scope: {} }), 'EXPERIENCE_INVALID');
  });

  await test('structured shape arrays retain repeated dimensions and require exact array matches', async () => {
    const { service } = await setup('shape-arrays');
    const created = await service.create(human({ scope: { shape: { dimensions: [128, 128] } } }));
    assert.deepEqual(created.experience.scope.shape.dimensions, [128, 128]);
    assert.equal((await service.retrieve(query({ scope: { shape: { dimensions: [128, 128] } } }))).items.length, 1);
    assert.equal((await service.retrieve(query({ scope: { shape: { dimensions: [128] } } }))).items.length, 0);
  });

  await test('execution observations bind all credentials and never authorize GPU publication', async () => {
    const { service } = await setup('observations');
    const cpu = await service.recordObservation(observation());
    assert.equal(cpu.experience.source, 'execution');
    assert.equal(cpu.experience.kind, 'observation');
    assert.equal(cpu.experience.verification.evidenceClass, 'cpu-development');
    assert.equal(cpu.experience.verification.publishable, false);
    assert.equal(cpu.experience.evidence.liveHardware, false);
    assert.equal((await service.retrieve(query())).items[0].useAs, 'development-record');
    const gpu = await service.recordObservation(observation({ scope: { hardware: ['c550'] }, evidence: evidence({ runId: 'run-gpu', hardware: 'c550', executionMode: 'gpu' }) }));
    assert.equal(gpu.experience.verification.evidenceClass, 'hardware-observation');
    assert.equal(gpu.experience.verification.publishable, false);
    const simulation = await service.recordObservation(observation({ scope: { hardware: ['c550'] }, evidence: evidence({ runId: 'run-sim', hardware: 'c550', executionMode: 'simulation' }) }));
    assert.equal(simulation.experience.verification.evidenceClass, 'simulation');
    assert.equal(simulation.experience.verification.status, 'unverified');
    assert.equal(simulation.experience.evidence.liveHardware, false);
    for (const key of ['missionId', 'candidateId', 'runId', 'patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest']) {
      const missing = evidence(); delete missing[key];
      await rejectsCode(() => service.recordObservation(observation({ evidence: missing })), 'EXPERIENCE_INVALID');
    }
    await rejectsCode(() => service.recordObservation(observation({ evidence: evidence({ hardware: 'c550' }) })), 'EXPERIENCE_INVALID');
    await rejectsCode(() => service.recordObservation(observation({ scope: { hardware: ['c550'] } })), 'EXPERIENCE_INVALID');
    await rejectsCode(() => service.recordObservation(observation({ evidence: evidence({ liveHardware: true }) })), 'EXPERIENCE_INVALID');
    await rejectsCode(() => service.update(cpu.experience.id, { content: 'Changed measured outcome' }, { projectId: 'project-a', expectedVersion: 1 }), 'EXPERIENCE_INVALID');
  });

  await test('same evidence is idempotent across instances and changed evidence conflicts', async () => {
    const { service, rootDir, file } = await setup('idempotency');
    const another = makeService(rootDir);
    const results = await Promise.all([service.recordObservation(observation()), another.recordObservation(observation())]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results[0].experience.id, results[1].experience.id);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).revision, 1);
    const unchanged = await fs.readFile(file, 'utf8');
    await rejectsCode(() => service.recordObservation(observation({ evidence: evidence({ packageDigest: digest('e') }) })), 'EXPERIENCE_EVIDENCE_CONFLICT');
    await rejectsCode(() => service.recordObservation(observation({ content: 'Incompatible interpretation' })), 'EXPERIENCE_EVIDENCE_CONFLICT');
    assert.equal(await fs.readFile(file, 'utf8'), unchanged);
    await service.update(results[0].experience.id, { status: 'archived' }, { projectId: 'project-a', expectedVersion: 1 });
    const retry = await another.recordObservation(observation());
    assert.equal(retry.created, false);
    assert.equal(retry.experience.status, 'archived');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).revision, 2);
  });

  await test('process-wide transactions serialize independent repository instances', async () => {
    const { service, rootDir } = await setup('concurrent');
    const another = makeService(rootDir);
    const values = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? service : another).create(human({ title: `Entry ${index}` }))));
    assert.equal((await service.read(null, { projectId: 'project-a' })).experiences.length, 12);
    const id = values[0].experience.id;
    const updates = await Promise.allSettled([service, another].map((api) => api.update(id, { content: 'Concurrent change' }, { projectId: 'project-a', expectedVersion: 1 })));
    assert.equal(updates.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(updates.find((result) => result.status === 'rejected').reason.code, 'EXPERIENCE_VERSION_CONFLICT');
  });

  await test('strict input whitelist, bounded values, unsafe keys, and paths are rejected', async () => {
    const { service } = await setup('inputs');
    for (const extra of [{ verification: { status: 'verified' } }, { source: 'execution' }, { path: '../outside' }, { id: '../bad' }, { content: 'x'.repeat(EXPERIENCE_LIMITS.content + 1) }, { visibility: 'public' }, { projectId: '../project' }]) {
      await rejectsCode(() => service.create(human(extra)), 'EXPERIENCE_INVALID');
    }
    await rejectsCode(() => service.create(human({ scope: JSON.parse('{"__proto__":{"polluted":true}}') })), 'EXPERIENCE_INVALID');
    await rejectsCode(() => service.create(human({ scope: { shape: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') } })), 'EXPERIENCE_INVALID');
    await rejectsCode(() => service.create(human({ scope: { shape: { matrix: Array.from({ length: 32 }, () => Array(32).fill(1)) } } })), 'EXPERIENCE_INVALID');
    const getter = human(); Object.defineProperty(getter, 'content', { enumerable: true, get() { throw new Error('getter executed'); } });
    await rejectsCode(() => service.create(getter), 'EXPERIENCE_INVALID');
    assert.equal({}.polluted, undefined);
    await rejectsCode(() => service.retrieve(query({ limit: EXPERIENCE_LIMITS.contextItems + 1 })), 'EXPERIENCE_INVALID');
  });

  await test('corruption is explicit and never silently replaced by an empty store', async () => {
    const { service, file, rootDir } = await setup('corrupt');
    await fs.mkdir(rootDir);
    for (const broken of ['{not json', '{"schemaVersion":99,"revision":0,"records":[]}', '{"schemaVersion":1,"revision":0,"records":[],"__proto__":{}}']) {
      await fs.writeFile(file, broken);
      await rejectsCode(() => service.read(null, { projectId: 'project-a' }), 'EXPERIENCE_STORE_CORRUPT');
      await rejectsCode(() => service.create(human()), 'EXPERIENCE_STORE_CORRUPT');
      assert.equal(await fs.readFile(file, 'utf8'), broken);
    }
  });

  await test('failed atomic replacement preserves prior bytes and cleans temporary files', async () => {
    const { service, file, rootDir } = await setup('atomic');
    await service.create(human());
    const before = await fs.readFile(file, 'utf8');
    const failing = makeService(rootDir, { ...fs, rename: async () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); } });
    await rejectsCode(() => failing.create(human()), 'EXPERIENCE_STORE_WRITE_FAILED');
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.deepEqual(await fs.readdir(rootDir), ['experiences.json']);
    await service.create(human());
    assert.equal((await service.read(null, { projectId: 'project-a' })).experiences.length, 2);
  });

  await test('repository transactions cannot rewrite history or commit asynchronous/no-op mutations', async () => {
    const { service, rootDir, file } = await setup('transaction-contract');
    await service.create(human());
    const repository = createExperienceRepository({ rootDir });
    const before = await fs.readFile(file, 'utf8');
    await rejectsCode(() => repository.transact((draft) => {
      draft.records[0].content = 'Rewritten history';
      return { changed: true, result: null };
    }), 'EXPERIENCE_HISTORY_CONFLICT');
    await assert.rejects(repository.transact((draft) => { draft.records.pop(); return { changed: false, result: null }; }), /no-op/);
    await assert.rejects(repository.transact(async () => ({ changed: true, result: null })), /synchronously/);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal((await repository.read()).revision, 1);
  });

  await test('storage root junctions cannot redirect writes outside the injected root', async () => {
    const destination = path.join(scratch, 'junction-target');
    const link = path.join(scratch, 'junction-root');
    await fs.mkdir(destination);
    await fs.symlink(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
    const service = makeService(path.join(link, 'nested'));
    await rejectsCode(() => service.create(human()), 'EXPERIENCE_STORAGE_PATH_INVALID');
    assert.deepEqual(await fs.readdir(destination), []);
  });

  await test('context limits do not return partial claims or mutate persisted records', async () => {
    const { service } = await setup('limits');
    await Promise.all(Array.from({ length: 10 }, (_, index) => service.create(human({ title: `Bound ${index}`, content: 'x'.repeat(EXPERIENCE_LIMITS.content) }))));
    const context = await service.retrieve(query({ limit: EXPERIENCE_LIMITS.contextItems }));
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= EXPERIENCE_LIMITS.contextBytes);
    assert.ok(context.items.length > 0 && context.items.length < 10);
    assert.ok(context.items.every((item) => item.content.length === EXPERIENCE_LIMITS.content));
    assert.equal((await service.read(null, { projectId: 'project-a' })).experiences.length, 10);
  });

  console.log(`Experience service: ${passed} contract checks passed.`);
} finally {
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('operator-experience-test-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
