import React, { useEffect, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import { Dashboard } from './components/Dashboard.mjs';
import { CreateMissionForm } from './components/CreateMissionForm.mjs';
import { deriveTuiViewModel, loadTuiState, renderDashboardSnapshot, renderPublishSnapshot, resolveDashboardCommand } from './tui-state.mjs';
import { createTerminalScreenSession } from './terminal-screen.mjs';
import { createLatestRefreshGate, formatOperationResultMessage, reconcileOperationSnapshot, reconcileTuiSnapshot } from './tui-refresh.mjs';
import { tuiOperatorProfiles } from '../../client-runtime/fixed-operator-profiles.mjs';
import { bilingual, displayStatus } from './ui-labels.mjs';
import {
  addHumanFeedback,
  assertProductionPreflight,
  ensureProductionRuntime,
  exportMission,
  pauseMission,
  publishMission,
  resumeMission,
  runDoctor,
  stopMission,
  stopProductionRuntime,
} from './production-api.mjs';

const initialSnapshot = { state: {}, mission: null, health: {}, tasks: [] };

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState(() => ({ columns: stdout?.columns, rows: stdout?.rows }));
  const [mode, setMode] = useState('dashboard');
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [draft, setDraft] = useState({
    profileId: tuiOperatorProfiles[0].id,
    researchEnabled: true,
    requireAuthority: false,
    timeBudget: '',
  });
  const [fieldIndex, setFieldIndex] = useState(0);
  const [message, setMessage] = useState('正在连接生产运行时 (Connecting to production runtime...)');
  const [noteDraft, setNoteDraft] = useState('');
  const [doctorResult, setDoctorResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const refreshGate = useRef(createLatestRefreshGate());
  const fields = ['profileId', 'researchEnabled', 'requireAuthority', 'timeBudget'];

  const cycleProfile = (direction = 1) => setDraft((current) => {
    const index = tuiOperatorProfiles.findIndex((item) => item.id === current.profileId);
    const next = (Math.max(0, index) + direction + tuiOperatorProfiles.length) % tuiOperatorProfiles.length;
    return { ...current, profileId: tuiOperatorProfiles[next].id };
  });

  useEffect(() => {
    const updateViewport = () => setViewport({ columns: stdout?.columns, rows: stdout?.rows });
    stdout?.on?.('resize', updateViewport);
    return () => stdout?.off?.('resize', updateViewport);
  }, [stdout]);

  const refreshNow = async ({ background = false } = {}) => {
    const requestId = refreshGate.current.begin();
    try {
      const next = await loadTuiState();
      if (!refreshGate.current.isLatest(requestId)) return null;
      setSnapshot((current) => reconcileTuiSnapshot(current, next));
      if (background) {
        setMessage((current) => current === '正在连接生产运行时 (Connecting to production runtime...)' || current.startsWith('运行时刷新 (Runtime refresh):') ? '' : current);
      }
      return next;
    } catch (error) {
      if (background && refreshGate.current.isLatest(requestId)) setMessage(`运行时刷新 (Runtime refresh): ${error.message}`);
      if (!background) throw error;
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const configuredRefreshIntervalMs = Number(process.env.OPERATOR_TUI_REFRESH_MS || 1500);
    const refreshIntervalMs = Number.isFinite(configuredRefreshIntervalMs)
      ? Math.max(1000, configuredRefreshIntervalMs)
      : 1500;
    const refresh = async () => {
      await refreshNow({ background: true });
      if (!cancelled) timer = setTimeout(refresh, refreshIntervalMs);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const perform = async (label, operation) => {
    if (busy) return;
    setBusy(true);
    setMessage(`${label}...`);
    try {
      const result = await operation();
      let displayedResult = result;
      if (result?.state) {
        setSnapshot((current) => reconcileOperationSnapshot(current, result));
        displayedResult = await refreshNow({ background: true }) || result;
      } else {
        await refreshNow();
      }
      setMessage(formatOperationResultMessage(label, displayedResult));
      return result;
    } catch (error) {
      setMessage(`${label}: ${error.message}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitPublish = async () => {
    if (draft.timeBudget && (!/^\d+$/.test(draft.timeBudget) || Number(draft.timeBudget) <= 0)) return setMessage('时间预算必须是正整数毫秒，或留空 (Time budget must be positive milliseconds or empty).');
    const result = await perform('发布生产任务 (Publish production mission)', () => publishMission(draft));
    if (result) setMode('dashboard');
  };

  const submitNote = async () => {
    if (!snapshot.mission) return setMessage('当前没有活动任务 (No active mission).');
    if (noteDraft.trim().length < 2) return setMessage('反馈至少需要 2 个字符 (Feedback must contain at least 2 characters).');
    const result = await perform('添加人工反馈 (Add human feedback)', () => addHumanFeedback(noteDraft));
    if (result) {
      setNoteDraft('');
      setMode('dashboard');
    }
  };

  const showDoctor = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('正在检查 C500 环境 (Checking C500 environment...)');
    try {
      setDoctorResult(await runDoctor());
      setMode('doctor');
      setMessage('');
    } catch (error) {
      setDoctorResult({ status: 'failed', error: error.message, checks: {} });
      setMode('doctor');
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      if (mode !== 'dashboard') setMode('dashboard');
      else exit();
      return;
    }
    if (mode === 'publish') {
      const keyName = fields[fieldIndex];
      if (busy) return;
      if (key.tab || key.downArrow) return setFieldIndex((current) => (current + 1) % fields.length);
      if (key.upArrow) return setFieldIndex((current) => (current + fields.length - 1) % fields.length);
      if (keyName === 'profileId' && (key.leftArrow || input === '[')) return cycleProfile(-1);
      if (keyName === 'profileId' && (key.rightArrow || input === ' ' || input === ']')) return cycleProfile(1);
      if (['researchEnabled', 'requireAuthority'].includes(keyName) && (key.leftArrow || key.rightArrow || input === ' ' || input === '[' || input === ']')) {
        return setDraft((current) => ({ ...current, [keyName]: !current[keyName] }));
      }
      if (key.return) return void submitPublish();
      if (['profileId', 'researchEnabled', 'requireAuthority'].includes(keyName)) return;
      if (key.backspace || key.delete) return setDraft((current) => ({ ...current, [keyName]: String(current[keyName] || '').slice(0, -1) }));
      if (input && !key.ctrl && !key.meta) setDraft((current) => ({ ...current, [keyName]: `${current[keyName] || ''}${input}` }));
      return;
    }
    if (mode === 'note') {
      if (busy) return;
      if (key.return) return void submitNote();
      if (key.backspace || key.delete) return setNoteDraft((current) => current.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setNoteDraft((current) => `${current}${input}`);
      return;
    }
    if (mode !== 'dashboard') return;
    const viewModel = deriveTuiViewModel(snapshot);
    const command = resolveDashboardCommand({ input, key, viewModel, busy });
    if (command === 'quit') exit();
    if (command === 'publish') setMode('publish');
    if (command === 'doctor') void showDoctor();
    if (command === 'feedback') setMode('note');
    if (command === 'stop') void perform('停止任务 (Stop mission)', stopMission);
    if (command === 'export') void perform('导出任务 (Export mission)', async () => ({ path: await exportMission() }));
    if (command === 'resume') void perform('恢复任务 (Resume mission)', resumeMission);
    if (command === 'pause') void perform('暂停任务 (Pause mission)', pauseMission);
  });

  if (mode === 'publish') return React.createElement(CreateMissionForm, { draft, fieldIndex, message, busy });
  if (mode === 'note') {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { color: 'cyan', bold: true }, '人工反馈 (Human Feedback)'),
      React.createElement(Text, null, `任务 (Mission): ${snapshot.mission?.id || '--'}`),
      React.createElement(Text, null, `内容 (Note): ${noteDraft}`),
      React.createElement(Text, null, ''),
      React.createElement(Text, { inverse: true }, busy ? '正在提交 (Submitting...)' : '[Enter] 提交  [Esc] 取消'),
    );
  }
  if (mode === 'doctor') {
    const checks = doctorResult?.checks || {};
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { color: 'cyan', bold: true }, 'C500 环境诊断 (C500 Environment Doctor)'),
      React.createElement(Text, null, `运行时 (runtime)  ${doctorResult?.runtime?.runtime?.mode || displayStatus(doctorResult?.status || 'unknown')}`),
      React.createElement(Text, null, `后端 (backend)    ${doctorResult?.runtime?.testBackend?.kind || '--'}${doctorResult?.mock ? ' / 模拟 (simulation)' : ''}`),
      ...[['device', 'device'], ['python', 'python'], ['mxSmi', 'mx-smi'], ['mctracer', 'mctracer'], ['mcProfiler', 'mcProfiler'], ['sourceMirror', 'sourceMirror']]
        .map(([key, label]) => React.createElement(Text, { key }, `${label.padEnd(12)} ${displayStatus(checks[key]?.status)}${checks[key]?.detail ? ` / ${checks[key].detail}` : ''}`)),
      doctorResult?.error ? React.createElement(Text, { color: 'red' }, doctorResult.error) : null,
      React.createElement(Text, null, ''),
      React.createElement(Text, { inverse: true }, '[Esc] 返回 (Back)'),
    );
  }
  return React.createElement(Dashboard, { snapshot, message, viewport });
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--snapshot') {
    const modeIndex = args.indexOf('--mode');
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'dashboard';
    try {
      process.stdout.write(`${mode === 'publish' ? renderPublishSnapshot() : renderDashboardSnapshot(await loadTuiState())}\n`);
    } finally {
      await stopProductionRuntime().catch(() => {});
    }
    return;
  }
  if (args[0] === 'panel' && args.includes('--once')) {
    try {
      process.stdout.write(`${renderDashboardSnapshot(await loadTuiState())}\n`);
    } finally {
      await stopProductionRuntime().catch(() => {});
    }
    return;
  }
  if (args[0] === 'doctor') {
    try {
      const result = await runDoctor();
      process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
    } finally {
      await stopProductionRuntime().catch(() => {});
    }
    return;
  }
  if (args.length) throw new Error('The production tester exposes only TUI, panel --once, doctor, and --snapshot commands.');
  await ensureProductionRuntime();
  assertProductionPreflight(await runDoctor());
  const screen = createTerminalScreenSession(process.stdout);
  const restoreScreen = () => screen.leave();
  screen.enter();
  process.once('exit', restoreScreen);
  try {
    const instance = render(React.createElement(App), { patchConsole: false });
    await instance.waitUntilExit();
  } finally {
    process.removeListener('exit', restoreScreen);
    restoreScreen();
    await stopProductionRuntime().catch(() => {});
  }
};

await main();
