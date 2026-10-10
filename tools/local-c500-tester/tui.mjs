import React, { useEffect, useRef, useState } from 'react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import { Dashboard } from './components/Dashboard.mjs';
import { OperationDetails, detailCapacity, physicalDetailLines } from './components/OperationDetails.mjs';
import { feedbackText, operationErrorMessage, operationErrorLines, doctorFeedbackLines } from './operation-feedback.mjs';
import { MissionHistory } from './components/MissionHistory.mjs';
import { assertMissionHistory, historyCapacity, historySections, missionHistoryLines } from './mission-history.mjs';
import { CreateMissionForm } from './components/CreateMissionForm.mjs';
import { MissionSourcePicker, sourcePickerRows, sourcePickerActions, sourcePickerCapacity, inheritedSourceSelection } from './components/MissionSourcePicker.mjs';
import { MissionEntry, focusedMission, missionEntryRows } from './components/MissionEntry.mjs';
import { deriveTuiViewModel, operationalDetailLines, loadTuiState, projectExperienceLines, renderDashboardSnapshot, renderPublishSnapshot, resolveDashboardCommand, roundExperienceLines } from './tui-state.mjs';
import { createTerminalScreenSession } from './terminal-screen.mjs';
import { createLatestRefreshGate, formatOperationResultMessage, reconcileOperationSnapshot, reconcileTuiSnapshot } from './tui-refresh.mjs';
import { createMissionDraft, missionFieldOptions, missionSubmitLabel } from './mission-form.mjs';
import { editMissionConfiguration, missionConfigurationFields, missionConfigurationIssue } from './mission-configuration.mjs';
import { displayStatus } from './ui-labels.mjs';
import { promptExistingRuntime } from './existing-runtime-prompt.mjs';
import * as productionApi from './production-api.mjs';

const initialSnapshot = { state: {}, mission: null, health: {}, tasks: [] };
const defaultServices = { ...productionApi, loadTuiState };
// Text truncation limits width, not embedded newlines. Page physical lines so
// learned multi-line observations cannot consume the fixed header/footer rows.
const experiencePanelLines = (result) => [...(result?.selectionLines || []), '项目库存 (Project inventory)', ...projectExperienceLines(result)]
  .flatMap(line => String(line).split(/\r\n|\r|\n/u));

export const App = ({ services = defaultServices } = {}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState(() => ({ columns: stdout?.columns, rows: stdout?.rows }));
  const [mode, setMode] = useState('home');
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [entryChoice, setEntryChoice] = useState(0);
  const [selectedMissionId, setSelectedMissionId] = useState(null);
  const [openedMissionId, setOpenedMissionId] = useState(null);
  const [formReturnMode, setFormReturnMode] = useState('home');
  const [draft, setDraft] = useState(createMissionDraft);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [formEditor, setFormEditor] = useState(null);
  const [formIssue, setFormIssue] = useState('');
  const [sourceBrowser, setSourceBrowser] = useState({ directory: null, index: 0, selections: [], preview: {}, review: false, actionIndex: -1, recent: [] });
  const [message, setMessage] = useState('正在连接生产运行时 (Connecting to production runtime...)');
  const [noteDraft, setNoteDraft] = useState('');
  const [doctorResult, setDoctorResult] = useState(null);
  const [operationError, setOperationError] = useState(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [detailReturnMode, setDetailReturnMode] = useState('dashboard');
  const [experienceResult, setExperienceResult] = useState(null);
  const [experienceOffset, setExperienceOffset] = useState(0);
  const [historyDocument, setHistoryDocument] = useState(null);
  const [historySection, setHistorySection] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const operationBusy = useRef(false);
  const refreshGate = useRef(createLatestRefreshGate());

  useEffect(() => {
    const updateViewport = () => setViewport({ columns: stdout?.columns, rows: stdout?.rows });
    stdout?.on?.('resize', updateViewport);
    return () => stdout?.off?.('resize', updateViewport);
  }, [stdout]);

  const refreshNow = async ({ background = false } = {}) => {
    const requestId = refreshGate.current.begin();
    try {
      const next = await services.loadTuiState();
      if (!refreshGate.current.isLatest(requestId)) return null;
      setSnapshot((current) => reconcileTuiSnapshot(current, next));
      setLoaded(true);
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

  const missionRows = missionEntryRows(snapshot);
  const selectedMission = focusedMission(missionRows, selectedMissionId, snapshot.state?.activeMissionId);
  useEffect(() => {
    if (loaded && !missionRows.length) setEntryChoice(1);
  }, [loaded, missionRows.length]);
  const workspaceChanged = openedMissionId && snapshot.state?.activeMissionId !== openedMissionId;
  useEffect(() => {
    if (workspaceChanged && ['dashboard', 'experiences', 'history', 'note', 'doctor', 'details'].includes(mode)) {
      setMode('missions');
      setMessage('当前活动任务已变化，请重新选择要打开的 Mission。');
    }
  }, [workspaceChanged, mode]);

  const perform = async (label, operation) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setMessage(`${label}...`);
    setOperationError(null);
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
      setOperationError({ error, missionId: error.savedMission?.missionId || snapshot.mission?.id || null });
      if (error.savedMission?.missionId && error.savedMission.state?.activeMissionId === error.savedMission.missionId) {
        setSnapshot(current => reconcileOperationSnapshot(current, error.savedMission));
        setMessage(`已保存 ${error.savedMission.missionId} · 启动未确认 · [H] 错误详情 · ${operationErrorMessage(error)}`);
        return { ...error.savedMission, startError: error };
      }
      setMessage(`${feedbackText(error.code || '操作失败')} [Ctrl+E]详情 · ${label}: ${feedbackText(error.message)}`);
      return null;
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  };

  const submitPublish = async () => {
    const issue = missionConfigurationIssue(draft);
    if (issue) {
      // Local validation never reaches the API; move focus to the first field to fix.
      if (Number.isInteger(issue.fieldIndex)) setFieldIndex(issue.fieldIndex);
      setFormEditor(issue.editor || null);
      return setFormIssue(issue.message);
    }
    setFormIssue('');
    const result = await perform(missionSubmitLabel(draft), () => services.publishMissionDraft(draft));
    if (result) {
      if (formEditor) setFieldIndex(Math.max(0, missionConfigurationFields(draft).indexOf('configurationReview')));
      setFormEditor(null);
      setOpenedMissionId(result.missionId || result.state?.activeMissionId);
      setDraft(({ draftId, draftRevision, ...current }) => current);
      setMode('dashboard');
    }
  };

  const saveConfiguration = async () => {
    setFormIssue('');
    const result = await perform('保存待配置任务', () => services.saveMissionConfigurationDraft(draft));
    if (!result?.draft) return;
    setDraft(createMissionDraft());
    setFieldIndex(0);
    setFormEditor(null);
    setSelectedMissionId(result.draft.id);
    setMode('missions');
    setMessage('草稿已保存。选中后按 Enter 继续配置。');
  };

  const sourceOperation = async (operation) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('');
    try { await operation(); }
    catch (error) { setMessage(error.message); }
    finally { operationBusy.current = false; setBusy(false); }
  };
  const browseSourceDirectory = (location) => sourceOperation(async () => {
    const directory = location === ':locations:' ? { path: ':locations:', label: '常用位置', entries: [
      { name: '项目目录', path: process.cwd(), directory: true },
      { name: '用户目录', path: ':home:', directory: true },
      { name: '磁盘 / 根目录', path: ':roots:', directory: true },
      ...(sourceBrowser.recent || []).filter(value => value !== process.cwd()).map(value => ({ name: `最近：${value}`, path: value, directory: true })),
    ] } : await services.listMissionSourceDirectory(location);
    setSourceBrowser(current => ({ ...current, directory, index: 0, actionIndex: -1, review: false,
      recent: directory.path?.startsWith(':') ? current.recent || [] : [directory.path, ...(current.recent || []).filter(value => value !== directory.path)].slice(0, 5) }));
  });
  const showSourcePicker = (purpose = 'sources') => {
    setSourceBrowser(current => ({ ...current, purpose, pendingBaseline: null, index: 0, actionIndex: -1, review: false,
      selections: draft.sourceSelections || [], preview: { files: draft.importedFiles || [],
        totalBytes: (draft.importedFiles || []).reduce((sum, file) => sum + file.size, 0),
        sourcePolicy: draft.sourcePolicy, reviewDigest: draft.sourceReviewDigest,
        excludedFiles: draft.sourceExcludedFiles || [], generatedFiles: draft.sourceGeneratedFiles || [] } }));
    setMode('sources');
    void browseSourceDirectory(sourceBrowser.directory?.path || process.cwd());
  };
  const changeSourceSelection = (selection, review = sourceBrowser.review, includeIgnoredPaths = sourceBrowser.preview?.sourcePolicy?.includeIgnoredPaths || []) => sourceOperation(async () => {
    const preview = await services.previewMissionSources(selection, { includeIgnoredPaths: selection.length ? includeIgnoredPaths : [] });
    setSourceBrowser(current => ({ ...current, selections: preview.selections, preview, review, index: review ? 0 : current.index, actionIndex: -1 }));
  });
  const applySourceSelection = (selection, baseline) => sourceOperation(async () => {
    baseline ??= sourceBrowser.pendingBaseline;
    const includeIgnoredPaths = sourceBrowser.preview?.sourcePolicy?.includeIgnoredPaths || [];
    const checked = await services.previewMissionSources(selection, { includeIgnoredPaths });
    const sameSelection = JSON.stringify(selection) === JSON.stringify(sourceBrowser.selections);
    if (!sameSelection || !sourceBrowser.preview?.reviewDigest || (sourceBrowser.purpose !== 'baseline' && !sourceBrowser.review)) {
      setSourceBrowser(current => ({ ...current, purpose: baseline ? 'sources' : current.purpose,
        pendingBaseline: baseline || current.pendingBaseline, selections: checked.selections, preview: checked, review: true, index: 0, actionIndex: -1 }));
      setMessage('请查看最终纳入、排除和系统生成文件，再确认添加。'); return;
    }
    if (checked.reviewDigest !== sourceBrowser.preview.reviewDigest) throw new Error('素材内容或导入规则已变化，请重新打开清单预览后确认。');
    const next = { ...draft, sourceSelections: checked.selections, importedFiles: checked.files,
      sourcePolicy: checked.sourcePolicy, sourceReviewDigest: checked.reviewDigest,
      sourceExcludedFiles: checked.excludedFiles, sourceGeneratedFiles: checked.generatedFiles };
    const options = missionFieldOptions(next, 'baselineFile').filter(option => option.value);
    if (baseline && !options.some(option => option.value === baseline)) throw new Error('请选择独立 .py 基线，不能使用候选实现入口。');
    next.baselineFile = baseline ?? (options.some(option => option.value === draft.baselineFile) ? draft.baselineFile : '');
    setDraft(next); setFormIssue(''); setMessage(''); setMode('publish');
  });

  const showMissionList = () => {
    setSelectedMissionId(selectedMission?.id || null);
    setMode('missions');
    setMessage('');
  };

  const showMissionForm = () => {
    if (draft.draftId) { setDraft(createMissionDraft()); setFieldIndex(0); setFormEditor(null); }
    setFormReturnMode(mode);
    setMode('publish');
    setMessage('');
    setFormIssue('');
  };

  const openMission = async () => {
    if (!loaded) return setMessage('正在读取任务，请稍候。');
    if (!selectedMission) return setMessage('还没有 Mission，按 N 创建新任务。');
    const id = selectedMission.id;
    if (selectedMission.kind === 'draft') {
      const result = await perform('打开待配置任务', () => services.loadMissionConfigurationDraft(id));
      if (result?.draft) {
        setDraft({ ...createMissionDraft(), ...result.draft.form,
          ...(!Object.hasOwn(result.draft.form, 'acceptancePolicyMode') ? { acceptancePolicyMode: 'legacy' } : {}),
          draftId: id, draftRevision: result.draft.revision });
        setFieldIndex(0); setFormEditor(null); setFormIssue(''); setMessage('');
        setFormReturnMode('missions'); setMode('publish');
      }
      return;
    }
    const result = await perform('打开 Mission', () => services.selectMission(id));
    if (result) {
      setOpenedMissionId(id);
      setMessage('');
      setMode('dashboard');
    }
  };

  const submitNote = async () => {
    if (!snapshot.mission) return setMessage('当前没有活动任务 (No active mission).');
    if (noteDraft.trim().length < 2) return setMessage('反馈至少需要 2 个字符 (Feedback must contain at least 2 characters).');
    const result = await perform('添加人工反馈 (Add human feedback)', () => services.addHumanFeedback(noteDraft));
    if (result) {
      setNoteDraft('');
      setMode('dashboard');
    }
  };

  const showDoctor = async () => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('正在诊断当前后端 (Checking configured backend...)');
    try {
      setDoctorResult(await services.runDoctor());
      setDetailOffset(0);
      setMode('doctor');
      setMessage('');
    } catch (error) {
      setDoctorResult({ status: 'failed', error, checks: {} });
      setMode('doctor');
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  };

  const showExperiences = async () => {
    const projectId = snapshot.mission?.projectId || snapshot.state?.activeProjectId;
    if (!projectId || operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('正在读取项目经验 (Loading project experiences...)');
    try {
      const result = await services.loadProjectExperiences(projectId);
      setExperienceResult({ ...result, projectId, selectionLines: roundExperienceLines(snapshot) });
      setExperienceOffset(0);
      setMode('experiences');
      setMessage('');
    } catch (error) {
      setMessage(`读取经验 (Experiences): ${error.message}`);
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  };

  const showHistory = async () => {
    const missionId = snapshot.mission?.id;
    if (!missionId || operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setMessage('正在读取完整轨迹…');
    try {
      const document = assertMissionHistory(await services.loadMissionHistory(missionId), missionId);
      setHistoryDocument(document); setHistoryOffset(0); setMode('history'); setMessage('');
    } catch (error) { setMessage(`读取轨迹失败：${error.message}`); }
    finally { operationBusy.current = false; setBusy(false); }
  };

  const detailLines = mode === 'doctor' ? doctorFeedbackLines(doctorResult) : [
    ...(operationError && (!operationError.missionId || operationError.missionId === snapshot.mission?.id) ? operationErrorLines(operationError.error) : []),
    ...operationalDetailLines(deriveTuiViewModel(snapshot)),
  ];
  const showDetails = () => { setDetailReturnMode(mode); setDetailOffset(0); setMode('details'); };
  useInput((input, key) => {
    if (key.escape) {
      if (operationBusy.current) return;
      if (mode === 'details') { setMode(detailReturnMode); return; }
      if (mode === 'sources') {
        setMode('publish'); setMessage('');
      }
      else if (mode === 'home') exit();
      else if (mode === 'missions') { setMode('home'); setMessage(''); }
      else if (mode === 'publish' && formEditor) {
        const edited = editMissionConfiguration({ draft, fieldIndex, editor: formEditor, key });
        setFormEditor(edited.editor); setFieldIndex(edited.fieldIndex); setFormIssue(''); setMessage('');
      }
      else if (mode === 'publish') { setMode(formReturnMode); setMessage(''); }
      else if (mode === 'dashboard') showMissionList();
      else setMode('dashboard');
      return;
    }
    if (mode === 'publish' && key.ctrl && input === 'e' && operationError) {
      if (!operationBusy.current) showDetails();
      return;
    }
    if (mode === 'details' || mode === 'doctor') {
      const capacity = detailCapacity(viewport);
      const last = Math.max(0, physicalDetailLines(detailLines, viewport).length - capacity);
      const step = key.downArrow ? 1 : key.upArrow ? -1 : key.pageDown ? capacity : key.pageUp ? -capacity : 0;
      if (step) setDetailOffset(current => Math.max(0, Math.min(last, current + step)));
      return;
    }
    if (mode === 'home' || mode === 'missions') {
      if (operationBusy.current) return;
      if (input === 'q') return exit();
      if (input === 'n' || input === 'p' || (mode === 'home' && input === '2')) return showMissionForm();
      if (mode === 'home') {
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) setEntryChoice((current) => 1 - current);
        if (input === '1' || (key.return && entryChoice === 0)) showMissionList();
        if (key.return && entryChoice === 1) showMissionForm();
      } else {
        const index = Math.max(0, missionRows.findIndex((row) => row.id === selectedMission?.id));
        const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -5 : key.pageDown ? 5 : 0;
        const next = Math.max(0, Math.min(missionRows.length - 1, index + step));
        if (step) setSelectedMissionId(missionRows[next]?.id || null);
        if (key.return) void openMission();
      }
      return;
    }
    if (workspaceChanged && !['publish', 'sources'].includes(mode)) return;
    if (mode === 'sources') {
      if (operationBusy.current) return;
      const { directory, index, selections, preview, review, purpose, actionIndex = -1 } = sourceBrowser;
      const baselineOptions = missionFieldOptions(draft, 'baselineFile');
      const actions = sourcePickerActions(purpose);
      if (key.tab) return setSourceBrowser(current => ({ ...current, actionIndex: ((actionIndex + 1 + (key.shift ? -1 : 1) + actions.length + 1) % (actions.length + 1)) - 1 }));
      if (actionIndex >= 0 && (key.leftArrow || key.rightArrow)) return setSourceBrowser(current => ({ ...current, actionIndex: (actionIndex + (key.leftArrow ? -1 : 1) + actions.length) % actions.length }));
      if (actionIndex >= 0 && key.return) {
        const action = actions[actionIndex][0];
        if (action === 'cancel') return setMode('publish');
        if (action === 'clear') { setDraft(current => ({ ...current, baselineFile: '' })); return setMode('publish'); }
        if (action === 'locations') return void browseSourceDirectory(':locations:');
        if (action === 'review' && purpose !== 'baseline') return void changeSourceSelection(selections, true);
        if (action === 'files' || action === 'review') return setSourceBrowser(current => ({ ...current, review: action === 'review', index: 0, actionIndex: -1 }));
        if (action === 'apply') return void applySourceSelection(selections);
        if (action === 'folder') {
          if (!directory?.path || directory.path.startsWith(':')) return setMessage('请先进入要添加的文件夹。');
          return void changeSourceSelection([...new Set([...selections, directory.path])], true);
        }
      }
      // Keep existing shortcuts as optional accelerators, never as the only confirmation.
      if (key.ctrl && input === 's' && purpose !== 'baseline') return void applySourceSelection(selections);
      if (key.ctrl && input === 'r') return void browseSourceDirectory(':roots:');
      if (key.ctrl && input === 'u' && purpose !== 'baseline') return void changeSourceSelection([]);
      if (key.backspace && directory?.parent) return void browseSourceDirectory(directory.parent);
      const entries = sourcePickerRows({ ...sourceBrowser, baselineOptions });
      const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -sourcePickerCapacity(viewport) : key.pageDown ? sourcePickerCapacity(viewport) : 0;
      if (step) return setSourceBrowser(current => ({ ...current, actionIndex: -1, index: Math.max(0, Math.min(entries.length - 1, index + step)) }));
      const entry = entries[index];
      if (!entry || actionIndex >= 0) return;
      if (key.return && entry.directory) return void browseSourceDirectory(entry.path);
      if (purpose === 'baseline' && key.return) {
        if (entry.disabled) return setMessage('run.py 是候选实现入口，不能作为独立基线。');
        if (entry.baseline) return void applySourceSelection(selections, entry.path);
        const parent = inheritedSourceSelection(selections, entry.path);
        const baseline = parent ? path.relative(parent, entry.path).split(path.sep).join('/') : path.basename(entry.path);
        return void applySourceSelection(parent || selections.includes(entry.path) ? selections : [...selections, entry.path], baseline);
      }
      if (purpose === 'baseline') return;
      if (review) {
        if ((key.return || input === ' ') && (entry.excluded || entry.includedIgnored)) {
          if (entry.excluded && !entry.canInclude) return setMessage(entry.reason || '此文件不允许进入模型任务或导出。');
          const included = preview.sourcePolicy?.includeIgnoredPaths || [];
          return void changeSourceSelection(selections, true, entry.includedIgnored
            ? included.filter(value => value !== entry.path) : [...new Set([...included, entry.path])]);
        }
        if (key.return && entry.remove) return void changeSourceSelection(selections.filter(value => value !== entry.path), true);
        return;
      }
      if ((input === ' ' || key.return) && !entry.parent) {
        if (entry.directory) return setMessage('请进入文件夹，再选择“使用当前文件夹”查看导入清单。');
        if (inheritedSourceSelection(selections, entry.path)) return setMessage('此文件由文件夹导入；在“已选清单”移除对应来源后可单独选择。');
        return void changeSourceSelection(selections.includes(entry.path) ? selections.filter(item => item !== entry.path) : [...selections, entry.path]);
      }
      return;
    }
    if (mode === 'publish') {
      if (operationBusy.current) return;
      if (key.ctrl && input === 's' && draft.mode === 'generic' && draft.inputMode === 'form' && draft.sourceMode === 'managed') return void saveConfiguration();
      const edited = editMissionConfiguration({ draft, fieldIndex, editor: formEditor, input, key, viewport });
      if (edited.browseSources) return showSourcePicker(edited.browseBaseline ? 'baseline' : 'sources');
      if (edited.submit) return void submitPublish();
      if (edited.issue) setFormIssue(edited.issue);
      else if (edited.draft !== draft) setFormIssue(''); // live field status takes over after an edit
      setDraft(edited.draft);
      setFieldIndex(edited.fieldIndex);
      setFormEditor(edited.editor);
      return;
    }
    if (mode === 'history') {
      if (operationBusy.current || workspaceChanged) return;
      if (key.tab || /^[1-5]$/.test(input)) {
        setHistorySection(key.tab ? (historySection + (key.shift ? historySections.length - 1 : 1)) % historySections.length : Number(input) - 1);
        setHistoryOffset(0); return;
      }
      if (input === 'r') return void showHistory();
      if (input === 'e') return void perform('导出当前轨迹快照', async () => ({ path: await services.exportMissionHistory(snapshot.mission.id, historyDocument) }));
      const capacity = historyCapacity(viewport);
      const last = Math.max(0, missionHistoryLines(historyDocument, historySection).length - capacity);
      const step = key.downArrow ? 1 : key.upArrow ? -1 : key.pageDown ? capacity : key.pageUp ? -capacity : 0;
      if (step) setHistoryOffset(current => Math.max(0, Math.min(last, current + step)));
      return;
    }
    if (mode === 'experiences') {
      const lastOffset = Math.max(0, experiencePanelLines(experienceResult).length - Math.max(1, (viewport.rows || 30) - 9));
      if (key.downArrow || key.pageDown) setExperienceOffset((current) => Math.min(lastOffset, current + (key.pageDown ? 5 : 1)));
      if (key.upArrow || key.pageUp) setExperienceOffset((current) => Math.max(0, current - (key.pageUp ? 5 : 1)));
      return;
    }
    if (mode === 'note') {
      if (busy) return;
      if (key.return) return void submitNote();
      if (key.backspace || key.delete) return setNoteDraft((current) => current.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setNoteDraft((current) => `${current}${input}`);
      return;
    }
    if (mode !== 'dashboard' || workspaceChanged) return;
    const viewModel = deriveTuiViewModel(snapshot);
    const command = resolveDashboardCommand({ input, key, viewModel, busy });
    if (command === 'quit') exit();
    if (command === 'publish') showMissionForm();
    if (command === 'missions') showMissionList();
    if (command === 'doctor') void showDoctor();
    if (command === 'details') showDetails();
    if (command === 'experiences') void showExperiences();
    if (command === 'history') void showHistory();
    if (command === 'feedback') setMode('note');
    if (command === 'stop') void perform('停止任务 (Stop mission)', services.stopMission);
    if (command === 'export') void perform('导出任务与待测候选', async () => ({ path: await services.exportMission() }));
    if (command === 'exportBest') void perform('导出已验收最佳源码与证据', async () => ({ path: await services.exportBestCandidate() }));
    if (command === 'resume') void perform('恢复任务 (Resume mission)', services.resumeMission);
    if (command === 'submitTest') void perform('提交冻结候选测试 (Submit frozen test)', services.submitPendingCandidate);
    if (command === 'settleTest') void perform('核对并接收测试结果', services.settlePendingCandidate);
    if (command === 'continueGeneration') void perform('根据测试反馈生成下一候选', services.continuePendingCandidate);
    if (command === 'newAttempt') void (async () => {
      const result = await perform('基于冻结候选另建任务（保存后可按空格启动）', services.newPendingAttempt);
      if (result?.missionId && result.state?.activeMissionId === result.missionId) {
        setSelectedMissionId(result.missionId);
        setOpenedMissionId(result.missionId);
        setMode('dashboard');
      }
    })();
    if (command === 'pause') void perform('暂停任务 (Pause mission)', services.pauseMission);
  });

  if (mode === 'home' || mode === 'missions' || workspaceChanged && mode === 'dashboard') return React.createElement(MissionEntry, {
    screen: mode === 'home' ? 'home' : 'missions', snapshot, choice: entryChoice, selectedId: selectedMissionId, loaded, message, busy, viewport,
  });
  if (mode === 'publish') return React.createElement(CreateMissionForm, { draft, fieldIndex, editor: formEditor, message, busy, issue: formIssue, viewport });
  if (mode === 'sources') return React.createElement(MissionSourcePicker, { ...sourceBrowser, baselineOptions: missionFieldOptions(draft, 'baselineFile'), busy, message, viewport });
  if (mode === 'history') return React.createElement(MissionHistory, { document: historyDocument, section: historySection, offset: historyOffset, viewport, message, busy });
  if (mode === 'experiences') {
    const lines = experiencePanelLines(experienceResult);
    const capacity = Math.max(1, (viewport.rows || 30) - 9);
    const offset = Math.min(experienceOffset, Math.max(0, lines.length - capacity));
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1, height: Math.max(1, (viewport.rows || 30) - 2), overflow: 'hidden' },
      React.createElement(Text, { color: 'cyan', bold: true, wrap: 'truncate-end' }, '项目经验 (Project Experiences) · 只读'),
      React.createElement(Text, { wrap: 'truncate-end' }, `${experienceResult.projectId} · revision ${experienceResult.repositoryRevision ?? '--'}`),
      React.createElement(Text, { dimColor: true, wrap: 'truncate-end' }, '项目库存；本轮采用情况以仪表盘的选择记录为准。'),
      ...lines.slice(offset, offset + capacity).map((line, index) => React.createElement(Text, { key: offset + index, wrap: 'truncate-end' }, line)),
      React.createElement(Text, { inverse: true, wrap: 'truncate-end' }, `[↑↓] 滚动 ${offset + 1}–${Math.min(lines.length, offset + capacity)}/${lines.length}  [Esc] 返回`),
    );
  }
  if (mode === 'note') {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { color: 'cyan', bold: true }, '人工反馈 (Human Feedback)'),
      React.createElement(Text, null, `任务 (Mission): ${snapshot.mission?.id || '--'}`),
      React.createElement(Text, null, `内容 (Note): ${noteDraft}`),
      React.createElement(Text, null, ''),
      React.createElement(Text, { inverse: true }, busy ? '正在提交 (Submitting...)' : '[Enter] 提交  [Esc] 取消'),
    );
  }
  if (mode === 'doctor' || mode === 'details') return React.createElement(OperationDetails, {
    title: mode === 'doctor' ? '环境诊断 (Environment Doctor)' : '状态与错误说明', lines: detailLines, offset: detailOffset, viewport,
  });
  return React.createElement(Dashboard, { snapshot, message, viewport });
};

export const main = async ({ args = process.argv.slice(2), services = defaultServices, renderApp = render, stdout = process.stdout, signal } = {}) => {
  if (args[0] === '--snapshot') {
    const modeIndex = args.indexOf('--mode');
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'dashboard';
    try {
      stdout.write(`${mode === 'publish' ? renderPublishSnapshot() : renderDashboardSnapshot(await services.loadTuiState())}\n`);
    } finally {
      await services.stopProductionRuntime().catch(() => {});
    }
    return;
  }
  if (args[0] === 'panel' && args.includes('--once')) {
    try {
      stdout.write(`${renderDashboardSnapshot(await services.loadTuiState())}\n`);
    } finally {
      await services.stopProductionRuntime().catch(() => {});
    }
    return;
  }
  if (args[0] === 'doctor') {
    try {
      const result = await services.runDoctor();
      stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
    } finally {
      await services.stopProductionRuntime().catch(() => {});
    }
    return;
  }
  const existingRuntimePolicy = args.includes('--reuse-existing')
    ? 'reuse'
    : args.includes('--replace-existing')
      ? 'replace'
      : null;
  const unknownArgs = args.filter((argument) => !['--reuse-existing', '--replace-existing'].includes(argument));
  if (unknownArgs.length) throw new Error('The production tester exposes only TUI, panel --once, doctor, --snapshot, --reuse-existing, and --replace-existing commands.');
  await services.ensureProductionRuntime({ existingRuntimePolicy, onExistingRuntime: promptExistingRuntime });
  const screen = createTerminalScreenSession(stdout);
  const restoreScreen = () => screen.leave();
  screen.enter();
  process.once('exit', restoreScreen);
  let stopScreen;
  try {
    const instance = renderApp(React.createElement(App, { services }), { patchConsole: false });
    stopScreen=()=>instance.unmount();
    signal?.addEventListener('abort',stopScreen,{once:true});
    if(signal?.aborted)stopScreen();
    await instance.waitUntilExit();
  } finally {
    if(stopScreen)signal?.removeEventListener('abort',stopScreen);
    process.removeListener('exit', restoreScreen);
    restoreScreen();
    await services.stopProductionRuntime().catch(() => {});
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
