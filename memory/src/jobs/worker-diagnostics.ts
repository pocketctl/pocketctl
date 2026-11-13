import { RelayRequestError } from '../relay/errors.js'
import { JOB_TYPES, JobTerminalError, type JobClaim } from './types.js'

const KNOWN_CODES = new Set(['projection_source_changed','inbox_body_unavailable','job_aborted_before_dispatch','git_poll_failed','extraction_unconfigured',
 'canonical_reference_mapping_required','canonical_reference_busy','canonical_reference_changed','canonical_reference_conflict','canonical_reference_cursor_changed',
 'source_execution_generation_changed','source_execution_required','source_shadow_provider_forbidden','source_execution_scope_mismatch','source_executions_not_drained','source_execution_requires_read_committed','source_provider_effect_unrecorded'])
const ERROR_NAMES = new Set(['Error','TypeError','RangeError','SyntaxError','AbortError'])
const SQLSTATES = new Set(['40001','40P01','55P03','57014','23502','23503','23505','23514','08001','08003','08006','53300','53400','57P01','42P01','42703'])

/** Fixed diagnostic vocabulary only; arbitrary messages and database details never escape. */
export function workerErrorCode(error: unknown): string {
  if (error instanceof RelayRequestError) return error.code
  if (error instanceof JobTerminalError) return /^[a-z][a-z0-9_]{0,48}$/.test(error.errorCode)
    ? `handler_failed_${error.errorCode}` : 'handler_failed_terminal_error'
  if (error instanceof Error && KNOWN_CODES.has(error.message)) return error.message
  const sqlstate = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (typeof sqlstate === 'string' && SQLSTATES.has(sqlstate)) return 'postgres_error'
  const name=error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : error instanceof Error ? 'Error' : 'unknown'
  return `handler_failed_${name}`
}

export function workerErrorFields(error: unknown, job?: JobClaim): Record<string, unknown> {
  const fields: Record<string,unknown>={code:workerErrorCode(error)}
  const sqlstate=error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if(typeof sqlstate==='string' && SQLSTATES.has(sqlstate))fields.sqlstate=sqlstate
  if(job){
    if(JOB_TYPES.includes(job.job_type))fields.job_type=job.job_type
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.job_id))fields.job_id=job.job_id
    if(Number.isSafeInteger(job.attempts)&&job.attempts>=0)fields.attempt=job.attempts
    if(Number.isSafeInteger(job.claim_epoch)&&job.claim_epoch>=0)fields.claim_epoch=job.claim_epoch
  }
  return fields
}
