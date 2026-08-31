const firstPositiveNumber = (...values) => values
  .map((value) => Number(value))
  .find((value) => Number.isFinite(value) && value > 0) || null;

export const WORKFLOW_ERROR_CATEGORY = Object.freeze({
  BUDGET: 'budget',
  USER_CANCEL: 'user_cancel',
  TIMEOUT: 'timeout',
  DEPENDENCY: 'dependency',
  VALIDATION: 'validation',
  INVARIANT: 'invariant',
  CONFIGURATION: 'configuration',
  INTERNAL: 'internal',
});

export const WORKFLOW_STOP_POLICY = Object.freeze({
  BUDGET: 'budget_exhausted',
  USER_CANCEL: 'stopped',
  RETRY: 'retry',
  CONTINUE: 'continue',
  NEEDS_HUMAN: 'needs_human',
});

const categoryFor = (code, message, input = {}) => {
  if (input.category && Object.values(WORKFLOW_ERROR_CATEGORY).includes(input.category)) return input.category;
  const text = `${code} ${message}`.toUpperCase();
  if (/(?:TOKEN|TIME|ROUND)[_ -]?BUDGET|BUDGET_EXHAUSTED|QUOTA/.test(text)) return WORKFLOW_ERROR_CATEGORY.BUDGET;
  if (/(?:CANCEL|STOPPED_BY_USER|ABORT)/.test(text)) return WORKFLOW_ERROR_CATEGORY.USER_CANCEL;
  if (/(?:TIMEOUT|TIMED_OUT|QUEUE_TIMEOUT|POLL_TIMEOUT|STALL)/.test(text) || /(?:TIMEOUT|TIMED OUT|停滞|超时)/i.test(`${code} ${message}`)) return WORKFLOW_ERROR_CATEGORY.TIMEOUT;
  if (/(?:EAI_AGAIN|ECONN|UNAVAILABLE|SERVICE|REMOTE_|DEPENDENCY|BACKEND|POLL_FAILED|SUBMIT_FAILED)/.test(text)) return WORKFLOW_ERROR_CATEGORY.DEPENDENCY;
  if (/(?:VALIDATION|CORRECTNESS|SCHEMA|ACCEPT_GATE|NO_CANDIDATE|CANDIDATE_)/.test(text)) return WORKFLOW_ERROR_CATEGORY.VALIDATION;
  if (/(?:INVARIANT|ORPHANED|MISMATCH|WORKFLOW_)/.test(text)) return WORKFLOW_ERROR_CATEGORY.INVARIANT;
  if (/(?:REQUIRED|INVALID|UNSAFE|CONFIG|PATH|NOT_FOUND)/.test(text)) return WORKFLOW_ERROR_CATEGORY.CONFIGURATION;
  return WORKFLOW_ERROR_CATEGORY.INTERNAL;
};

const defaultRetryable = (category, status, code) => {
  if (category === WORKFLOW_ERROR_CATEGORY.TIMEOUT || category === WORKFLOW_ERROR_CATEGORY.DEPENDENCY) return true;
  if ([408, 425, 429].includes(status) || Number(status) >= 500) return true;
  return /(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EBUSY|ELOCKED|UNAVAILABLE|RATE_LIMITED|SERVICE_ERROR|SUBMIT_FAILED|POLL_FAILED)/i.test(code);
};

export const deriveStopPolicy = ({ category, retryable = false, phase = '' } = {}) => {
  if (category === WORKFLOW_ERROR_CATEGORY.BUDGET) return WORKFLOW_STOP_POLICY.BUDGET;
  if (category === WORKFLOW_ERROR_CATEGORY.USER_CANCEL) return WORKFLOW_STOP_POLICY.USER_CANCEL;
  if (category === WORKFLOW_ERROR_CATEGORY.VALIDATION && /candidate|correctness|gate/i.test(phase)) return WORKFLOW_STOP_POLICY.CONTINUE;
  if (retryable) return WORKFLOW_STOP_POLICY.RETRY;
  return WORKFLOW_STOP_POLICY.NEEDS_HUMAN;
};

export const deriveRecoveryAction = ({ category, retryable = false, phase = '', code = '' } = {}) => {
  if (category === WORKFLOW_ERROR_CATEGORY.BUDGET) return '增加对应预算或结束当前 Mission。';
  if (category === WORKFLOW_ERROR_CATEGORY.USER_CANCEL) return '用户已停止；如需继续，请显式恢复 Mission。';
  if (category === WORKFLOW_ERROR_CATEGORY.TIMEOUT) return '检查测试队列/后端服务，确认任务状态后重试当前阶段。';
  if (category === WORKFLOW_ERROR_CATEGORY.DEPENDENCY) return retryable ? '检查依赖服务后自动重试；超过重试次数后人工恢复。' : '修复依赖配置后从当前阶段恢复。';
  if (category === WORKFLOW_ERROR_CATEGORY.VALIDATION) return /candidate|correctness|gate/i.test(phase) ? '记录失败候选并继续下一轮或提交人工反馈。' : '修正输入或契约后重试。';
  if (category === WORKFLOW_ERROR_CATEGORY.INVARIANT) return '检查 workflow_state 与事件日志，修复状态矛盾后恢复。';
  if (category === WORKFLOW_ERROR_CATEGORY.CONFIGURATION) return `修复配置或路径问题（${code || 'CONFIGURATION_ERROR'}）后恢复。`;
  return '查看错误上下文和事件日志，确认副作用后从当前阶段恢复。';
};

export const normalizeWorkflowError = (input = {}, context = {}) => {
  const source = input?.error && typeof input.error === 'object' ? input.error : input;
  const code = String(source?.code || input?.code || context.code || 'WORKFLOW_UNEXPECTED_ERROR');
  const message = String(source?.message || input?.message || context.message || 'Workflow failed unexpectedly.');
  const status = firstPositiveNumber(source?.statusCode, source?.httpStatus, source?.status, input?.statusCode, input?.httpStatus);
  const category = categoryFor(code, message, { ...source, ...input, ...context });
  const hasSourceRetryable = source && Object.prototype.hasOwnProperty.call(source, 'retryable');
  const hasInputRetryable = input && Object.prototype.hasOwnProperty.call(input, 'retryable');
  const retryable = hasSourceRetryable
    ? source.retryable === true
    : hasInputRetryable
      ? input.retryable === true
      : defaultRetryable(category, status, code);
  const phase = String(context.phase || input?.phase || source?.phase || 'unknown');
  const stopPolicy = deriveStopPolicy({ category, retryable, phase });
  return {
    code,
    category,
    message,
    status,
    phase,
    retryable,
    terminal: stopPolicy !== WORKFLOW_STOP_POLICY.RETRY,
    stopPolicy,
    action: deriveRecoveryAction({ category, retryable, phase, code }),
    source: String(context.source || input?.source || source?.source || 'workflow'),
    occurredAt: context.occurredAt || input?.occurredAt || source?.occurredAt || new Date().toISOString(),
    details: context.details || input?.details || source?.details || null,
  };
};

export const serializeWorkflowError = (input = {}, context = {}) => {
  const normalized = input?.category && input?.stopPolicy ? input : normalizeWorkflowError(input, context);
  return {
    code: normalized.code,
    category: normalized.category,
    message: normalized.message,
    status: normalized.status,
    phase: normalized.phase,
    retryable: normalized.retryable,
    terminal: normalized.terminal,
    stopPolicy: normalized.stopPolicy,
    action: normalized.action,
    source: normalized.source,
    occurredAt: normalized.occurredAt,
    details: normalized.details,
  };
};

export const assertWorkflowError = (input) => {
  const normalized = normalizeWorkflowError(input);
  if (!normalized.code || !normalized.message || !normalized.category || !normalized.stopPolicy) {
    const error = new Error('Invalid workflow error contract.');
    error.code = 'WORKFLOW_ERROR_CONTRACT_INVALID';
    throw error;
  }
  return normalized;
};
