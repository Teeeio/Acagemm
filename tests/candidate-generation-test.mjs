import assert from 'node:assert/strict';
import {
  buildCandidateGenerationPrompt,
} from '../client-runtime/candidate-generation/prompt.mjs';
import {
  candidateWorkspaceRequirements,
  finalizeCandidateAdmission,
  inspectCandidateDiff,
} from '../client-runtime/candidate-generation/admission.mjs';

const provider = { slug: 'codex', name: 'Codex' };
const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const mission = {
  id: 'MIS_CANDIDATE_GENERATION',
  goal: 'reduce latency',
  hardware: ['local-gpu'],
  metric: 'latency_p50',
  implementation: null,
  operatorProfile: null,
};

const prompt = buildCandidateGenerationPrompt({
  mission,
  goal: mission.goal,
  workspace: 'C:/workspace/MIS_CANDIDATE_GENERATION',
  baseline: { status: 'ready', oracleRunPy: 'def reference(inputs): return inputs' },
  testMatrix: { environments: ['local-gpu'] },
  workspaceInventory: ['run.py', 'kernel.py'],
  boundaryInstruction: 'BOUNDARY',
});
assert.match(prompt, /Mission ID: MIS_CANDIDATE_GENERATION/);
assert.match(prompt, /run\.py/);
assert.match(prompt, /BOUNDARY/);
assert.match(prompt, /Return one JSON object/);
assert.doesNotMatch(prompt, /Frozen Semantic Snapshot/);

const semanticPrompt = buildCandidateGenerationPrompt({
  mission: {
    ...mission,
    semanticSnapshot: {
      snapshotId: 'SEM_INPUTS_01', status: 'frozen', digest: 'sha256:semantic-digest',
      semanticContract: {
        operator: 'vector_add',
        inputs: [{ name: 'lhs', shape: ['N', 16], dtype: 'float16', device: 'cuda' }],
        outputs: [{ name: 'out', dtype: 'float16' }],
        math: { equation: 'out = lhs + rhs' },
        immutableRules: ['preserve dtype'],
      },
      correctnessContract: { requiredCategories: ['exact', 'edge'], uncovered: [] },
      benchmarkContract: { primaryProfile: 'small', profiles: [{ name: 'small', shape: [1, 16] }] },
      rawIntent: { operator: 'vector_add', goal: 'elementwise addition' },
      conflicts: [], unknowns: [],
    },
    iterationEvidence: {
      roundId: 'MIS_CANDIDATE_GENERATION:round:2',
      candidateDigest: digest,
      correctness: { passed: false, failures: [{ case: 'empty_input', reason: 'shape mismatch' }] },
      benchmark: { profiles: [{ name: 'small', value: 12.5, unit: 'us' }] },
      attemptedDirection: 'shared memory tiling',
    },
  },
  goal: 'reduce latency',
  workspace: 'C:/workspace/MIS_CANDIDATE_GENERATION',
  baseline: {
    status: 'ready',
    oracleRunPy: 'def reference(inputs): return inputs',
    iterationEvidence: { priorCandidateDigest: 'sha256:prior', decision: 'discard', reason: 'correctness_failed' },
  },
  testMatrix: { environments: ['local-gpu'] },
});
assert.match(semanticPrompt, /Frozen Semantic Snapshot \(authoritative contract/);
assert.match(semanticPrompt, /SEM_INPUTS_01/);
assert.match(semanticPrompt, /sha256:semantic-digest/);
assert.match(semanticPrompt, /vector_add/);
assert.match(semanticPrompt, /Correctness contract \(JSON\)/);
assert.match(semanticPrompt, /Benchmark contract \(JSON\)/);
assert.match(semanticPrompt, /MISSION ITERATION EVIDENCE/);
assert.match(semanticPrompt, /empty_input/);
assert.match(semanticPrompt, /shared memory tiling/);
assert.match(semanticPrompt, /BASELINE ITERATION EVIDENCE/);
assert.match(semanticPrompt, /correctness_failed/);

const context = { mission, runHistory: [] };
const matching = inspectCandidateDiff({
  agentResult: {
    candidates: [{ id: 'agent-candidate', files: 'run.py', sourceReferences: [] }],
    recommendedCandidate: 'agent-candidate',
    summary: 'candidate summary',
    sourceReferences: [],
  },
  manifest: { dirty: true, diff: 'diff --git a/run.py b/run.py', digest, changedFiles: ['run.py'] },
  provider,
  runId: 'codex-run-1',
});
assert.equal(matching.candidateValidation.passed, true);
assert.equal(matching.verifiedCandidates[0].patchDigest, digest);
assert.equal(matching.verifiedCandidates[0].sourceRunId, 'codex-run-1');

const mismatch = inspectCandidateDiff({
  agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py' }], recommendedCandidate: 'agent-candidate' },
  manifest: { dirty: true, diff: 'diff', digest, changedFiles: ['kernel.py'] },
  provider,
  runId: 'codex-run-2',
});
assert.equal(mismatch.candidateValidation.code, 'CODEX_CANDIDATE_FILES_MISMATCH');
assert.equal(mismatch.verifiedCandidates.length, 0);

const empty = inspectCandidateDiff({
  agentResult: { candidates: [{ id: 'agent-candidate', files: 'run.py' }], recommendedCandidate: 'agent-candidate' },
  manifest: { dirty: false, diff: '', digest, changedFiles: [] },
  provider,
  runId: 'codex-run-3',
});
assert.equal(empty.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_EMPTY');

const observed = inspectCandidateDiff({
  agentResult: { candidates: [], summary: 'workspace changed', sourceReferences: [] },
  manifest: { dirty: true, diff: 'diff', digest, changedFiles: ['run.py'] },
  provider,
  runId: 'codex-run-4',
});
assert.equal(observed.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_OBSERVED');
assert.equal(observed.verifiedCandidates[0].patchDigest, digest);

assert.deepEqual(candidateWorkspaceRequirements(mission), { requiredWorkspaceFiles: ['run.py'], contentFiles: ['run.py'] });
const finalized = finalizeCandidateAdmission({
  admission: matching,
  mission,
  workspaceFiles: ['run.py'],
  entryContent: 'def run(inputs): return inputs',
  runHistory: [],
  round: 0,
  provider,
});
assert.equal(finalized.candidateValidation.passed, true);
assert.equal(finalized.verifiedCandidates[0].id, 'candidate-01');
assert.equal(finalized.verifiedCandidates[0].agentOriginalId, 'agent-candidate');

const repeated = finalizeCandidateAdmission({
  admission: matching,
  mission,
  workspaceFiles: ['run.py'],
  entryContent: 'def run(inputs): return inputs',
  runHistory: [{ candidateDigest: digest }],
  round: 1,
  provider,
});
assert.equal(repeated.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_REPEATED');
assert.equal(repeated.verifiedCandidates.length, 0);
assert.equal(context.runHistory.length, 0);
console.log('[candidate-generation] prompt, diff admission, language contract, and repeat guard passed');
