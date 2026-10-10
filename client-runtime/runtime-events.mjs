import { randomUUID } from 'node:crypto';
import { enqueueTraceRecord } from './iteration-trace.mjs';

export function appendRuntimeEvent(state, type, payload = {}, source = { kind: 'adapter' }) {
  if (!state) return null;
  const events = Array.isArray(state.runtimeEvents) ? state.runtimeEvents : [];
  const sequence = events.reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0) + 1;
  const event = {
    eventId: `evt_${randomUUID()}`,
    missionId: state.activeMissionId,
    sequence,
    type,
    timestamp: new Date().toISOString(),
    source,
    payload,
  };
  enqueueTraceRecord(state, 'runtime-event', event.eventId, event);
  state.runtimeEvents = [...events, event].slice(-500);
  return event;
}

export function addAuditEvent(state, title, detail, tone = 'blue', icon = 'Activity') {
  if (!state) return null; // 防御：编排器边界可能出现瞬态 undefined，不崩循环
  const event = { eventId: `audit_${randomUUID()}`, timestamp: new Date().toISOString(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), title, detail, tone, icon };
  enqueueTraceRecord(state, 'audit-event', event.eventId, event);
  state.auditEvents = [event, ...(state.auditEvents || [])].slice(0, 30);
  return event;
}
