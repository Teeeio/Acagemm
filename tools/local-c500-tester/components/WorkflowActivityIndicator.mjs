import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { deriveTuiViewModel, deriveWorkflowTopology } from '../tui-state.mjs';

export const WORKFLOW_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const WORKFLOW_SPINNER_INTERVAL_MS = 160;

export const deriveWorkflowActivity = (snapshot = {}) => {
  const view = deriveTuiViewModel(snapshot);
  const topology = deriveWorkflowTopology(snapshot);
  const loopStatus = snapshot.state?.iterationStats?.loopStatus;
  const active = view.hasMission
    && !view.terminal
    && !view.paused
    && !view.needsHuman
    && (loopStatus === 'running' || topology.currentNode.status === 'running');
  if (active) return { active: true, color: 'cyan', label: `FLOW ACTIVE · Round ${topology.currentRound || '--'}` };
  if (view.terminal) return { active: false, color: 'green', label: `✓ COMPLETE · Round ${topology.currentRound || '--'}` };
  if (view.needsHuman) return { active: false, color: 'red', label: `! ACTION REQUIRED · Round ${topology.currentRound || '--'}` };
  if (view.paused) return { active: false, color: 'yellow', label: `Ⅱ PAUSED · Round ${topology.currentRound || '--'}` };
  return { active: false, color: 'gray', label: `IDLE · Round ${topology.currentRound || '--'}` };
};

export const WorkflowActivityIndicator = ({ snapshot = {} }) => {
  const activity = deriveWorkflowActivity(snapshot);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!activity.active) {
      setFrame(0);
      return undefined;
    }
    const timer = setInterval(() => setFrame((current) => (current + 1) % WORKFLOW_SPINNER_FRAMES.length), WORKFLOW_SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activity.active]);
  return React.createElement(Text, { color: activity.color, bold: activity.active }, activity.active
    ? `${WORKFLOW_SPINNER_FRAMES[frame]} ${activity.label}`
    : activity.label);
};
