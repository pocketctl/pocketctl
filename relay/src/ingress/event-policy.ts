import type { PriorityClass } from './types.js';

const control = new Set([
  'session_created', 'session_discovered', 'session_id_changed', 'session_status',
  'session_create_failed',
  'session_meta', 'session_model_changed', 'session_agent_changed',
  'approval_request', 'approval_resolved', 'question_request', 'question_resolved',
  'interactive_prompt', 'interaction_result', 'permission_config_changed',
  'command_receipt',
]);
const aggregate = new Set([
  'subagent_usage',
]);
const ephemeralControl = new Set([
  'ping', 'daemon_shutdown', 'cancel_takeover',
  'model_list', 'upgrade_result',
]);
const ephemeralAggregate = new Set([
  'generate_title_request', 'generate_subagent_title_request', 'session_title_update',
]);

export function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 64) return null;
  if (value !== value.trim()) return null;
  // pending-* identities are client-side placeholders for the create flow,
  // never daemon-owned canonical sessions: a daemon must not be able to
  // address, rename onto, or inject into one.
  if (value.startsWith('pending-')) return null;
  return value;
}

export function classifyDaemonEvent(payload: Record<string, unknown>): {
  durable: boolean;
  priority: PriorityClass;
} {
  const type = String(payload.type ?? '');
  if (type === 'error' && normalizeSessionId(payload.session_id) === null) {
    return { durable: false, priority: 'control' };
  }
  if (ephemeralControl.has(type)) return { durable: false, priority: 'control' };
  if (ephemeralAggregate.has(type)) return { durable: false, priority: 'aggregate' };
  if (control.has(type)) return { durable: true, priority: 'control' };
  if (aggregate.has(type)) return { durable: true, priority: 'aggregate' };
  if (payload.resync === true) return { durable: true, priority: 'replay' };
  return { durable: true, priority: 'live' };
}

export function buildDedupKey(
  daemonId: string,
  generation: number,
  seq: number,
  payload: Record<string, unknown>,
): string {
  const session = String(payload.session_id ?? '');
  const type = String(payload.type ?? '');
  if (typeof payload.event_id === 'string' && payload.event_id !== '') {
    return `${session}:${type}:event:${payload.event_id}`;
  }
  if (typeof payload.request_id === 'string' && payload.request_id !== '') {
    return `${session}:${type}:request:${payload.request_id}`;
  }
  return `${daemonId}:${generation}:${seq}`;
}
