import type pg from 'pg'
import { normalizeSessionId } from './ingress/event-policy.js'

export const adoptionCommands = new Set(['session_adopt', 'session_adopt_status', 'session_adopt_cancel'])
const common = ['type', 'request_id', 'session_id']
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s)

export function validAdoptionCommand(msg: Record<string, unknown>): boolean {
  if (!normalizeSessionId(msg.session_id) || !identifier(msg.session_id) || !identifier(msg.request_id)) return false
  let allowed = common
  switch (msg.type) {
    case 'session_adopt':
      allowed = [...common, 'wait_ms', 'unarchive']
      if (msg.wait_ms !== undefined && (typeof msg.wait_ms !== 'number' || !Number.isInteger(msg.wait_ms) || msg.wait_ms < 0 || msg.wait_ms > 120000)) return false
      if (msg.unarchive !== undefined && typeof msg.unarchive !== 'boolean') return false
      break
    case 'session_adopt_status':
    case 'session_adopt_cancel':
      allowed = [...common, 'operation_id']
      if ((msg.operation_id !== undefined || msg.type === 'session_adopt_cancel') && !identifier(msg.operation_id)) return false
      break
    default: return false
  }
  return Object.keys(msg).every(key => allowed.includes(key))
}

// Each lookup covers both owners and the exact native identity. The caller
// holds the session fence during admission and rechecks before delivering.
export async function adoptionTarget(db: pg.PoolClient, userId: number, sessionId: string) {
  const { rows } = await db.query(`SELECT s.daemon_id, s.agent_type, s.source, s.is_subagent, s.parent_session_id,
      EXISTS (SELECT 1 FROM collaboration_session_agent_bindings b
        WHERE b.native_session_id=s.session_id AND b.owner_user_id=s.user_id) AS has_team_binding
    FROM sessions s JOIN daemons d ON d.daemon_id=s.daemon_id AND d.user_id=s.user_id
    WHERE s.session_id=$1 AND s.user_id=$2 FOR SHARE OF s,d`, [sessionId, userId])
  const row = rows[0]
  if (!row) return { error: 'forbidden' }
  if (row.agent_type !== 'codex' || (row.source != null && row.source !== '' && row.source !== 'terminal') || row.is_subagent || row.parent_session_id
    || row.has_team_binding) return { error: 'unsupported_source' }
  return { daemonId: String(row.daemon_id) }
}

const phases = new Set(['available','checking','binding','waiting','managed','blocked','failed','cancelled','expired'])
const reasons = new Set(['eligible','cwd_not_authorized','permission_denied','active_writer','archived','source_missing','unsupported_source','subsession','environment_mismatch','provider_mismatch','managed_disabled','cli_missing','cli_unsupported','runtime_busy','probe_timeout','unverified','managed','cancelled','deadline_exceeded'])
const actions = new Set(['adopt','wait','unarchive','cancel'])

export function publicAdoption(raw: any, sessionId: string) {
  if (!raw || raw.version !== 1 || raw.session_id !== sessionId || !phases.has(raw.phase) || !Number.isSafeInteger(raw.revision) || raw.revision < 0
    || (raw.operation_id && !identifier(raw.operation_id))) return null
  const managed = raw.phase === 'managed' && raw.reason === 'managed' && raw.local_managed === true
  const knownReason = reasons.has(raw.reason) || (raw.reason === '' && ['checking','binding'].includes(raw.phase))
  const known = knownReason && (managed || (raw.phase !== 'managed' && raw.reason !== 'managed'))
  return {
    version: 1, session_id: sessionId, operation_id: raw.operation_id || '', revision: raw.revision,
    phase: known ? raw.phase : 'blocked', reason: known ? raw.reason : 'unverified',
    allowed_actions: known && Array.isArray(raw.allowed_actions) ? [...new Set(raw.allowed_actions.filter((a: unknown) => typeof a === 'string' && actions.has(a)))] : [],
    local_managed: managed, remote_ready: managed && raw.remote_ready === true,
    archive_changed: raw.archive_changed === true, retryable: known && raw.retryable === true,
    ...(typeof raw.deadline === 'string' && raw.deadline.length <= 40 && Number.isFinite(Date.parse(raw.deadline)) ? {deadline:raw.deadline} : {}),
    ...(Number.isSafeInteger(raw.retry_after_ms) && raw.retry_after_ms > 0 && raw.retry_after_ms <= 120000 ? {retry_after_ms:raw.retry_after_ms} : {}),
  }
}
