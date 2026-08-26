import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCandidateAgent, buildCandidateContext } from '../tools/local-c500-tester/candidate-agent.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-agent-'));
const workspace = path.join(tempDir, 'workspace');

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'run.py'), 'def run(): return 1\n', 'utf8');
  const context = buildCandidateContext({
    mission: { mission_id: 'm1', goal: 'optimize vector_add', budget: { tokens_used: 10, token_limit: 100 } },
    workspaceRoot: workspace,
    baseline: { source: 'local', latency_p50_us: 100 },
    sourceEvidence: [{ title: 'local source', confidence: 'high' }],
    failureRecords: [{ reason: 'previous candidate too slow' }],
    profiler: { hotspots: ['run'] },
    tracer: { summary: 'single call' },
    humanNotes: ['avoid changing API'],
    currentBest: { candidate_id: 'candidate-001', speedup: 1.1 },
  });
  assert.equal(context.workspaceRoot, workspace);
  assert.equal(context.budget.remainingTokens, 90);
  assert.equal(context.previousFailures.length, 1);
  assert.equal(context.humanNotes[0], 'avoid changing API');

  const agent = createCandidateAgent({
    run: async ({ workspaceRoot }) => {
      await writeFile(path.join(workspaceRoot, 'run.py'), 'def run(): return 2\n', 'utf8');
      return { status: 'candidate_ready', hypothesis: 'replace scalar path', changedFiles: ['run.py'] };
    },
  });
  const generated = await agent.generateCandidate(context);
  assert.equal(generated.status, 'candidate_ready');
  assert.equal(generated.changedFiles[0], 'run.py');
  assert.equal(await readFile(path.join(workspace, 'run.py'), 'utf8'), 'def run(): return 2\n');

  const unavailable = createCandidateAgent({ command: 'definitely-not-a-real-codex-command' });
  const noCandidate = await unavailable.generateCandidate(context);
  assert.equal(noCandidate.status, 'no_candidate');
  assert.equal(noCandidate.reason, 'agent_unavailable');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-candidate-agent] context and diff boundary passed\n');
