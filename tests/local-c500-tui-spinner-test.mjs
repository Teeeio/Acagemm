import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { Dashboard } from '../tools/local-c500-tester/components/Dashboard.mjs';
import { WORKFLOW_SPINNER_FRAMES } from '../tools/local-c500-tester/components/WorkflowActivityIndicator.mjs';

const output = new PassThrough();
output.columns = 120;
output.rows = 40;
output.isTTY = true;
const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => {};
let rendered = '';
output.on('data', (chunk) => { rendered += chunk.toString(); });
const writes = [];
output.on('data', (chunk) => { writes.push(chunk.toString()); });

const snapshot = {
  mission: { id: 'MIS_SPINNER', title: 'Spinner test', goal: 'optimize', status: 'running' },
  state: {
    stage: 'candidate',
    missionPaused: false,
    agent: { status: 'running', phase: 'generating run.py', progress: 45 },
    researchAgent: { status: 'completed', progress: 100 },
    baseline: {
      status: 'complete',
      source: { repository: 'repo', commit: 'commit', path: 'run.py' },
      materializer: { status: 'completed', progress: 100 },
      evidence: { value: 100 },
    },
    iterationStats: { loopStatus: 'running', round: 0 },
    runtimeEvents: [],
  },
  tasks: [{ taskId: 'baseline', status: 'completed', payload: { purpose: 'baseline' }, result: { benchmark: [{ value: 100, unit: 'us' }] } }],
};

const instance = render(React.createElement(Dashboard, { snapshot }), {
  stdout: output,
  stderr: output,
  stdin: input,
  debug: true,
  exitOnCtrlC: false,
  patchConsole: false,
});
await new Promise((resolve) => setTimeout(resolve, 700));
instance.unmount();
await instance.waitUntilExit();

const observedFrames = WORKFLOW_SPINNER_FRAMES.filter((frame) => rendered.includes(frame));
assert.ok(observedFrames.length >= 2, `expected rotating frames, observed: ${observedFrames.join(', ')}`);
assert.match(rendered, /FLOW ACTIVE/);
const animationWrites = writes.slice(1).filter((write) => WORKFLOW_SPINNER_FRAMES.some((frame) => write.includes(frame)));
assert.ok(animationWrites.length >= 2);
assert.equal(animationWrites.some((write) => /Workflow Topology|Recent Candidates/.test(write)), false, 'spinner repaint must not redraw the topology body');

const pausedOutput = new PassThrough();
pausedOutput.columns = 120;
pausedOutput.rows = 40;
pausedOutput.isTTY = true;
let pausedRendered = '';
pausedOutput.on('data', (chunk) => { pausedRendered += chunk.toString(); });
const pausedInstance = render(React.createElement(Dashboard, {
  snapshot: { ...snapshot, state: { ...snapshot.state, missionPaused: true } },
}), {
  stdout: pausedOutput,
  stderr: pausedOutput,
  stdin: input,
  debug: true,
  exitOnCtrlC: false,
  patchConsole: false,
});
await new Promise((resolve) => setTimeout(resolve, 220));
pausedInstance.unmount();
await pausedInstance.waitUntilExit();
assert.equal(WORKFLOW_SPINNER_FRAMES.some((frame) => pausedRendered.includes(frame)), false);
assert.match(pausedRendered, /PAUSED/);

console.log(`[local-c500-tui-spinner] observed ${observedFrames.length} rotating frames and static pause state`);
