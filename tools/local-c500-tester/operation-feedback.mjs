// Client feedback only. These helpers never change workflow or execution state.
import { stripVTControlCharacters } from 'node:util';

export const feedbackText = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
export const operationErrorMessage = error => [feedbackText(error?.code), feedbackText(error?.message || '操作失败')].filter(Boolean).join(' · ');

const detailKeys = new Set(['code', 'message', 'detail', 'reason', 'nextAction', 'action', 'status', 'ready', 'confirmed',
  'quarantined', 'blocked', 'missionId', 'runId', 'kind', 'id', 'resourceId', 'path', 'deadline', 'deadlineAt', 'expiresAt']);
const detailLines = (object, label = '', depth = 0) => {
  if (!object || typeof object !== 'object' || depth > 6) return [];
  return Object.entries(object).flatMap(([key, value]) => {
    // Only diagnostic fields are displayed. Arbitrary request/configuration data
    // and credentials are never copied into this detail screen.
    if (/token|secret|credential|password|api.?key|authorization|environment/i.test(key)) return [];
    const name = label ? `${label}.${key}` : key;
    if (value && typeof value === 'object') return detailLines(value, name, depth + 1);
    return detailKeys.has(key) && value != null ? [`${name}: ${feedbackText(value)}`] : [];
  });
};

export const operationErrorLines = error => error ? [
  operationErrorMessage(error),
  ...(error.status ? [`HTTP ${error.status}`] : []),
  ...detailLines(error.details),
] : [];

export const doctorFeedbackLines = doctor => [
  `运行时 ${doctor?.runtime?.runtime?.mode || '未知'} · 后端 ${doctor?.runtime?.testBackend?.kind || '未知'}`,
  ...(doctor?.agentPreflight ? [
    `生成准入：${doctor.agentPreflight.ready === true ? '就绪' : '未就绪'}`,
    ...detailLines(doctor.agentPreflight),
  ] : ['生成准入：未查询，硬件检查不能代替 Agent 准入']),
  ...Object.entries(doctor?.checks || {}).map(([key, check]) => `${key}: ${check?.status || '未知'}${check?.detail ? ` · ${feedbackText(check.detail)}` : ''}`),
  ...operationErrorLines(doctor?.error),
  '本页为显式诊断结果；就绪不代表任务已启动或测试通过。',
];

// Keep the existing exception contract for non-TUI callers. A failed /runs
// must still throw, but its already committed /missions receipt is recoverable.
export const attachSavedMission = (error, receipt) => {
  if (receipt?.missionId && receipt.state?.activeMissionId === receipt.missionId) error.savedMission = receipt;
  return error;
};
