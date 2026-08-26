import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateMissionCandidate } from '../tools/local-c500-tester/candidate-generation.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-generation-'));
const workspace = path.join(tempDir, 'workspace');

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'run.py'), 'def run(): return 1\n', 'utf8');
  const generated = await generateMissionCandidate({
    mission: { mission_id: 'm1', goal: 'optimize vector_add', budget: { token_limit: 100, tokens_used: 10 } },
    workspaceRoot: workspace,
    baseline: { status: 'complete', latency_p50_us: 100 },
    sourceEvidence: [],
    failureRecords: [],
    currentBest: null,
    agent: {
      run: async ({ workspaceRoot }) => {
        await writeFile(path.join(workspaceRoot, 'run.py'), 'def run(): return 2\n', 'utf8');
        return { status: 'candidate_ready', hypothesis: 'test change' };
      },
    },
  });
  assert.equal(generated.status, 'candidate_ready');
  assert.equal(generated.admission.admitted, true);
  assert.match(generated.admission.manifest.digest, /^sha256:/);
  assert.deepEqual(generated.admission.manifest.changedFiles, ['run.py']);

  const noCandidate = await generateMissionCandidate({
    mission: { mission_id: 'm2', goal: 'optimize vector_add' },
    workspaceRoot: workspace,
    baseline: {},
    agent: { run: async () => ({ status: 'no_candidate', reason: 'no safe change' }) },
    checkpointRoot: path.join(tempDir, 'checkpoint-2'),
  });
  assert.equal(noCandidate.status, 'no_candidate');
  assert.equal(noCandidate.admission.admitted, false);
  assert.equal(noCandidate.admission.reason, 'no_candidate_reported');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-generation] agent output and diff admission passed\n');
