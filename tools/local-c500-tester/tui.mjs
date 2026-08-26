import React, { useEffect, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import { Dashboard } from './components/Dashboard.mjs';
import { CreateMissionForm } from './components/CreateMissionForm.mjs';
import { deriveTuiViewModel, loadTuiState, renderDashboardSnapshot, renderPublishSnapshot, resolveDashboardCommand } from './tui-state.mjs';
import { createTerminalScreenSession } from './terminal-screen.mjs';
import { createLatestRefreshGate, reconcileTuiSnapshot } from './tui-refresh.mjs';
import { operatorLanguageOptions } from '../../client-runtime/operator-language.mjs';
import {
  addHumanFeedback,
  ensureProductionRuntime,
  exportMission,
  pauseMission,
  publishMission,
  resumeMission,
  runDoctor,
  stopMission,
} from './production-api.mjs';

const initialSnapshot = { state: {}, mission: null, health: {}, tasks: [] };

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState(() => ({ columns: stdout?.columns, rows: stdout?.rows }));
  const [mode, setMode] = useState('dashboard');
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [draft, setDraft] = useState({
    goal: '从零研究并优化 FlashInfer MLA paged attention 在沐曦 C500 上的 latency p50，相对 baseline 至少提升 20%；每轮必须生成真实且独立的 run.py 工作区 Diff。',
    title: 'FlashInfer MLA Paged Attention',
    repository: 'flashinfer-mla-c500',
    metric: 'latency p50',
    implementationLanguage: 'triton',
    timeBudget: '',
  });
  const [fieldIndex, setFieldIndex] = useState(0);
  const [message, setMessage] = useState('Connecting to production runtime...');
  const [noteDraft, setNoteDraft] = useState('');
  const [doctorResult, setDoctorResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const refreshGate = useRef(createLatestRefreshGate());
  const fields = ['goal', 'title', 'repository', 'metric', 'implementationLanguage', 'timeBudget'];

  const cycleLanguage = (direction = 1) => setDraft((current) => {
    const index = operatorLanguageOptions.findIndex((item) => item.id === current.implementationLanguage);
    const next = (Math.max(0, index) + direction + operatorLanguageOptions.length) % operatorLanguageOptions.length;
    return { ...current, implementationLanguage: operatorLanguageOptions[next].id };
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
        setMessage((current) => current === 'Connecting to production runtime...' || current.startsWith('Runtime refresh:') ? '' : current);
      }
      return next;
    } catch (error) {
      if (background && refreshGate.current.isLatest(requestId)) setMessage(`Runtime refresh: ${error.message}`);
      if (!background) throw error;
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const refresh = async () => {
      await refreshNow({ background: true });
      if (!cancelled) timer = setTimeout(refresh, 1500);
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
      await refreshNow();
      setMessage(`${label}: completed${result?.runId ? ` (${result.runId})` : ''}`);
      return result;
    } catch (error) {
      setMessage(`${label}: ${error.message}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitPublish = async () => {
    if (!draft.goal.trim()) return setMessage('Goal is required.');
    if (draft.timeBudget && (!/^\d+$/.test(draft.timeBudget) || Number(draft.timeBudget) <= 0)) return setMessage('Time budget must be positive milliseconds or empty.');
    const result = await perform('Publish production mission', () => publishMission(draft));
    if (result) setMode('dashboard');
  };

  const submitNote = async () => {
    if (!snapshot.mission) return setMessage('No active mission.');
    if (noteDraft.trim().length < 2) return setMessage('Feedback must contain at least 2 characters.');
    const result = await perform('Add human feedback', () => addHumanFeedback(noteDraft));
    if (result) {
      setNoteDraft('');
      setMode('dashboard');
    }
  };

  const showDoctor = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('Checking C500 environment...');
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
      if (keyName === 'implementationLanguage' && (key.leftArrow || input === '[')) return cycleLanguage(-1);
      if (keyName === 'implementationLanguage' && (key.rightArrow || input === ' ' || input === ']')) return cycleLanguage(1);
      if (key.return) return void submitPublish();
      if (keyName === 'implementationLanguage') return;
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
    if (command === 'stop') void perform('Stop mission', stopMission);
    if (command === 'export') void perform('Export mission', async () => ({ path: await exportMission() }));
    if (command === 'resume') void perform('Resume mission', resumeMission);
    if (command === 'pause') void perform('Pause mission', pauseMission);
  });

  if (mode === 'publish') return React.createElement(CreateMissionForm, { draft, fieldIndex, message, busy });
  if (mode === 'note') {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { color: 'cyan', bold: true }, 'Human Feedback'),
      React.createElement(Text, null, `Mission: ${snapshot.mission?.id || '--'}`),
      React.createElement(Text, null, `Note: ${noteDraft}`),
      React.createElement(Text, null, ''),
      React.createElement(Text, { inverse: true }, busy ? 'Submitting...' : '[Enter] Submit  [Esc] Cancel'),
    );
  }
  if (mode === 'doctor') {
    const checks = doctorResult?.checks || {};
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { color: 'cyan', bold: true }, 'C500 Environment Doctor'),
      React.createElement(Text, null, `runtime      ${doctorResult?.runtime?.runtime?.mode || doctorResult?.status || 'unknown'}`),
      React.createElement(Text, null, `backend      ${doctorResult?.runtime?.testBackend?.kind || '--'}${doctorResult?.mock ? ' / simulation' : ''}`),
      ...[['python', 'python'], ['mxSmi', 'mx-smi'], ['mctracer', 'mctracer'], ['mcProfiler', 'mcProfiler'], ['sourceMirror', 'sourceMirror']]
        .map(([key, label]) => React.createElement(Text, { key }, `${label.padEnd(12)} ${checks[key]?.status || '--'}${checks[key]?.detail ? ` / ${checks[key].detail}` : ''}`)),
      doctorResult?.error ? React.createElement(Text, { color: 'red' }, doctorResult.error) : null,
      React.createElement(Text, null, ''),
      React.createElement(Text, { inverse: true }, '[Esc] Back'),
    );
  }
  return React.createElement(Dashboard, { snapshot, message, viewport });
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--snapshot') {
    const modeIndex = args.indexOf('--mode');
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'dashboard';
    process.stdout.write(`${mode === 'publish' ? renderPublishSnapshot() : renderDashboardSnapshot(await loadTuiState())}\n`);
    return;
  }
  if (args[0] === 'panel' && args.includes('--once')) {
    process.stdout.write(`${renderDashboardSnapshot(await loadTuiState())}\n`);
    return;
  }
  if (args[0] === 'doctor') {
    const result = await runDoctor();
    process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
    return;
  }
  if (args.length) throw new Error('The production tester exposes only TUI, panel --once, doctor, and --snapshot commands.');
  await ensureProductionRuntime();
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
  }
};

await main();
