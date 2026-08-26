import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const nodeExe = 'F:\\Node\\node.exe';
const root = await mkdtemp(path.join(os.tmpdir(), 'mission-panel-'));

try {
  const stateFile = path.join(root, 'mock-db.json');
  await writeFile(stateFile, `${JSON.stringify({
    activeMissionId: 'MIS_PANEL',
    missions: [{
      id: 'MIS_PANEL',
      title: 'FlashInfer Paged Decode / Ascend Runner',
      stage: 'published',
      status: 'completed',
      hardware: ['npu-ascend-910'],
      metric: 'latency p50',
      agent: { status: 'completed', runId: 'codex-panel' },
      benchmark: { status: 'complete', runId: 'run-panel', logs: [], result: { benchmark: [{ environment: 'npu-ascend-910', value: 250, unit: 'us' }] } },
      baseline: {
        required: true,
        kind: 'pytorch_reference',
        status: 'complete',
        evidence: {
          environment: 'npu-ascend-910',
          value: 1000,
          unit: 'us',
          liveHardware: true,
          source: {
            authority: 'upstream',
            repository: 'https://github.com/flashinfer-ai/flashinfer.git',
            commit: 'ee3fda10',
            path: 'flashinfer/decode.py',
            expandedSingleFile: true,
          },
        },
      },
      currentBest: { candidateId: 'candidate-01', value: '250 us' },
      decisionReview: { recommendation: 'adopt' },
      iterationStats: { loopStatus: 'complete', round: 1 },
      runtimeEvents: [],
      auditEvents: [],
    }],
  }, null, 2)}\n`, 'utf8');

  const { stdout } = await execFileAsync(nodeExe, ['scripts/mission-panel.mjs', '--once'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: {
      ...process.env,
      MISSION_PANEL_STATE_FILE: stateFile,
      MISSION_PANEL_TEST_SERVICE_URL: 'http://127.0.0.1:9/health',
    },
    encoding: 'utf8',
  });

  assert.match(stdout, /baseline\s+:\s+npu-ascend-910 1000us/);
  assert.match(stdout, /base src\s+:\s+trusted/);
  assert.match(stdout, /speedup\s+:\s+4\.00x/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('[mission-panel] baseline and speedup formatting passed');
