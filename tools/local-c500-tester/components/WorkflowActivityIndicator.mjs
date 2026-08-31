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
  if (active) return { active: true, color: 'cyan', label: `流程运行中 (FLOW ACTIVE) · 第 ${topology.currentRound || '--'} 轮` };
  if (view.terminal) return { active: false, color: 'green', label: `✓ 已完成 (COMPLETE) · 第 ${topology.currentRound || '--'} 轮` };
  if (view.needsHuman) return { active: false, color: 'red', label: `! 需要操作 (ACTION REQUIRED) · 第 ${topology.currentRound || '--'} 轮` };
  if (view.paused) return { active: false, color: 'yellow', label: `Ⅱ 已暂停 (PAUSED) · 第 ${topology.currentRound || '--'} 轮` };
  return { active: false, color: 'gray', label: `空闲 (IDLE) · 第 ${topology.currentRound || '--'} 轮` };
};

export const WorkflowActivityIndicator = ({ snapshot = {} }) => {
  const activity = deriveWorkflowActivity(snapshot);
  const [frame, setFrame] = useState(0);
  const animationEnabled = process.env.OPERATOR_TUI_ANIMATE !== '0';
  useEffect(() => {
    if (!activity.active || !animationEnabled) {
      setFrame(0);
      return undefined;
    }
    const timer = setInterval(() => setFrame((current) => (current + 1) % WORKFLOW_SPINNER_FRAMES.length), WORKFLOW_SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activity.active, animationEnabled]);
  return React.createElement(Text, { color: activity.color, bold: activity.active }, activity.active
    ? `${WORKFLOW_SPINNER_FRAMES[frame]} ${activity.label}`
    : activity.label);
};
