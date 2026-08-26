import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalC500Adapter } from '../tools/local-c500-tester/local-c500-adapter.mjs';
import { evaluateLocalAcceptGate } from '../tools/local-c500-tester/accept-gate.mjs';
import { adoptCandidatePatch, recordCandidateExperience } from '../tools/local-c500-tester/adoption.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-mock-boundary-'));
try {
  const workspace = path.join(tempDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'run.py'), 'def get_inputs(): return {}\ndef run(inputs): return []\ndef reference(inputs): return []\n', 'utf8');
  const adapter = createLocalC500Adapter({ missionDir: tempDir, mock: true });
  const submitted = await adapter.submitTest({ purpose: 'candidate', candidateArtifact: { digest: 'sha256:real-digest', path: workspace }, matrix: { shapeKey: 'real-shape' }, stages: ['correctness', 'benchmark', 'tracer', 'profiler'] });
  const task = await adapter.pollTest(submitted.taskId);
  assert.equal(task.result.candidate.digest, 'sha256:real-digest');
  assert.equal(task.result.matrix.shapeKey, 'real-shape');
  assert.equal(task.result.environment.liveHardware, false);
  const gate = evaluateLocalAcceptGate({ baseline: { status: 'complete', source: 'authoritative', latency_p50_us: 100, shapeKey: 'real-shape' }, candidate: { id: 'candidate-1', digest: 'sha256:real-digest' }, result: task.result });
  assert.equal(gate.result, 'reference');
  assert.equal(gate.publishable, false);
  assert.equal((await adoptCandidatePatch({ candidateRoot: workspace, iterationRepository: path.join(tempDir, 'repository'), gate, candidate: { id: 'candidate-1', digest: 'sha256:real-digest' } })).adopted, false);
  assert.equal((await recordCandidateExperience({ missionDir: tempDir, candidate: { id: 'candidate-1', digest: 'sha256:real-digest' }, gate, result: task.result })).status, 'simulation');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-mock-boundary] simulation provenance enforced\n');
