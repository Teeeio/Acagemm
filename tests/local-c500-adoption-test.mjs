import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adoptCandidatePatch, rollbackCandidatePatch, recordCandidateExperience } from '../tools/local-c500-tester/adoption.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-adoption-'));
const candidate = path.join(tempDir, 'candidate');
const checkpoint = path.join(tempDir, 'checkpoint');
const repository = path.join(tempDir, 'repository');
const missionDir = path.join(tempDir, 'mission');

try {
  await mkdir(candidate, { recursive: true });
  await mkdir(checkpoint, { recursive: true });
  await writeFile(path.join(candidate, 'run.py'), 'def run(): return 2\n', 'utf8');
  await writeFile(path.join(checkpoint, 'run.py'), 'def run(): return 1\n', 'utf8');
  const adopted = await adoptCandidatePatch({ candidateRoot: candidate, iterationRepository: repository, gate: { result: 'adopt', publishable: true }, candidate: { id: 'candidate-001', digest: 'sha256:one' } });
  assert.equal(adopted.adopted, true);
  assert.equal(await readFile(path.join(repository, 'run.py'), 'utf8'), 'def run(): return 2\n');

  const experience = await recordCandidateExperience({ missionDir, candidate: { id: 'candidate-001', digest: 'sha256:one' }, gate: { result: 'reference', publishable: false }, result: { environment: { liveHardware: false } } });
  assert.equal(experience.status, 'simulation');
  assert.equal((await readFile(path.join(missionDir, 'experiences.jsonl'), 'utf8')).includes('candidate-001'), true);

  await writeFile(path.join(candidate, 'run.py'), 'def run(): return 3\n', 'utf8');
  const rolledBack = await rollbackCandidatePatch({ candidateRoot: candidate, checkpointRoot: checkpoint });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(await readFile(path.join(candidate, 'run.py'), 'utf8'), 'def run(): return 1\n');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-adoption] adoption, rollback and experience passed\n');
