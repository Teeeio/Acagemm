import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalC500Adapter } from '../tools/local-c500-tester/local-c500-adapter.mjs';
import { generateMissionCandidate } from '../tools/local-c500-tester/candidate-generation.mjs';
import { evaluateLocalAcceptGate } from '../tools/local-c500-tester/accept-gate.mjs';
import { adoptCandidatePatch, recordCandidateExperience } from '../tools/local-c500-tester/adoption.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-e2e-'));
const workspace = path.join(tempDir, 'workspace');
const repository = path.join(tempDir, 'repository');

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'run.py'), 'def get_inputs(): return {}\ndef run(inputs): return []\ndef reference(inputs): return []\n', 'utf8');
  const mission = { mission_id: 'e2e-1', goal: 'optimize vector_add', backend: 'triton', agent: { operator_id: 'vector_add' }, budget: { token_limit: 1000, tokens_used: 0 }, baseline: { status: 'complete', source: 'authoritative_library_reference', latency_p50_us: 100, evidence: { shapeKey: 'shape-1' } }, current_best: null };
  const adapter = createLocalC500Adapter({ missionDir: tempDir, mock: true });
  const baselineTask = await adapter.submitTest({ purpose: 'baseline', candidateArtifact: { digest: 'sha256:baseline', path: workspace }, matrix: { shapeKey: 'shape-1' }, stages: ['correctness', 'benchmark', 'tracer', 'profiler'] });
  const baseline = await adapter.pollTest(baselineTask.taskId);
  assert.equal(baseline.result.environment.liveHardware, false);

  const generated = await generateMissionCandidate({
    mission,
    workspaceRoot: workspace,
    baseline: mission.baseline,
    agent: { run: async ({ workspaceRoot }) => { await writeFile(path.join(workspaceRoot, 'run.py'), `${await readFile(path.join(workspaceRoot, 'run.py'), 'utf8')}# candidate\n`, 'utf8'); return { status: 'candidate_ready', hypothesis: 'candidate diff' }; } },
  });
  assert.equal(generated.admission.admitted, true);
  const candidateTask = await adapter.submitTest({ purpose: 'candidate', candidateArtifact: { digest: generated.admission.manifest.digest, path: workspace }, matrix: { shapeKey: 'shape-1' }, stages: ['correctness', 'benchmark', 'tracer', 'profiler'], round: 1 });
  const candidate = await adapter.pollTest(candidateTask.taskId);
  const gate = evaluateLocalAcceptGate({ baseline: mission.baseline, candidate: { id: 'candidate-001', digest: generated.admission.manifest.digest }, result: candidate.result, currentBest: null });
  assert.equal(gate.result, 'reference');
  assert.equal(gate.publishable, false);
  const adoption = await adoptCandidatePatch({ candidateRoot: workspace, iterationRepository: repository, gate, candidate: { id: 'candidate-001', digest: generated.admission.manifest.digest } });
  assert.equal(adoption.adopted, false);
  const experience = await recordCandidateExperience({ missionDir: tempDir, candidate: { id: 'candidate-001', digest: generated.admission.manifest.digest }, gate, result: candidate.result });
  assert.equal(experience.status, 'simulation');
  assert.equal((await readFile(path.join(tempDir, 'experiences.jsonl'), 'utf8')).includes('simulation'), true);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-e2e] mock hardware full workflow passed\n');
