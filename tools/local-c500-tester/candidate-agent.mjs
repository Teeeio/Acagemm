import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const commandAvailable = (command) => {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8' });
  return probe.status === 0;
};

export const buildCandidateContext = ({
  mission = {},
  workspaceRoot,
  baseline = null,
  sourceEvidence = [],
  failureRecords = [],
  profiler = null,
  tracer = null,
  humanNotes = [],
  currentBest = null,
} = {}) => ({
  mission: {
    mission_id: mission.mission_id || mission.id || null,
    goal: mission.goal || null,
    operator: mission.agent?.operator_id || mission.operator || null,
    backend: mission.backend || 'triton',
  },
  workspaceRoot,
  baseline,
  sourceEvidence,
  previousFailures: failureRecords,
  profiler,
  tracer,
  humanNotes,
  currentBest,
  budget: {
    usedTokens: Number(mission.budget?.tokens_used || 0),
    limitTokens: mission.budget?.token_limit ?? null,
    remainingTokens: mission.budget?.token_limit == null ? null : Math.max(0, Number(mission.budget.token_limit) - Number(mission.budget.tokens_used || 0)),
  },
});

const promptFor = (context) => [
  'You are the candidate optimization agent.',
  `Mission: ${context.mission.goal || 'unspecified'}`,
  `Operator: ${context.mission.operator || 'unresolved'}`,
  `Workspace: ${context.workspaceRoot}`,
  `Baseline: ${JSON.stringify(context.baseline || {})}`,
  `Source evidence: ${JSON.stringify(context.sourceEvidence)}`,
  `Previous failures: ${JSON.stringify(context.previousFailures)}`,
  `Profiler: ${JSON.stringify(context.profiler || {})}`,
  `Tracer: ${JSON.stringify(context.tracer || {})}`,
  `Human notes: ${JSON.stringify(context.humanNotes)}`,
  `Current best: ${JSON.stringify(context.currentBest || {})}`,
  `Remaining tokens: ${context.budget.remainingTokens ?? 'unlimited'}`,
  'Modify only files inside the workspace. Produce a real code diff or explicitly report no candidate.',
].join('\n');

export const createCandidateAgent = ({ run = null, command = process.env.LOCAL_C500_TESTER_CODEX_COMMAND || 'codex' } = {}) => ({
  async generateCandidate(context) {
    if (!context?.workspaceRoot || !existsSync(context.workspaceRoot)) return { status: 'needs_human', reason: 'workspace_missing' };
    if (run) return run(context);
    if (!commandAvailable(command)) return { status: 'no_candidate', reason: 'agent_unavailable', command };
    const result = spawnSync(command, ['exec', '--json', promptFor(context)], { cwd: context.workspaceRoot, encoding: 'utf8' });
    if (result.status !== 0) return { status: 'agent_failed', reason: 'agent_process_failed', command, stderr: result.stderr || '' };
    return { status: 'candidate_ready', source: 'codex-cli', raw: result.stdout || '' };
  },
});
