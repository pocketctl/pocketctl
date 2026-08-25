/**
 * Deterministic artifact classification over a fixed allowlist. Unknown or
 * incomplete events produce NO artifact — the source event itself is still
 * preserved; guessing artifacts from arbitrary payloads is forbidden.
 */
export type ArtifactType =
  | 'file_change'
  | 'tool_call'
  | 'tool_result'
  | 'test_result'
  | 'approval'
  | 'command'
  | 'other'

export interface ClassifiedArtifact {
  artifact_type: ArtifactType
  identity_key: string
  path: string | null
  call_id: string | null
  status: string | null
  details: Record<string, unknown>
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function classifyArtifact(
  eventType: string,
  data: Record<string, unknown>,
): ClassifiedArtifact | null {
  // File changes: an explicit path is the identity.
  const path = nonEmptyString(data.file_path) ?? nonEmptyString(data.path)
  if (eventType === 'file_change' && path) {
    return {
      artifact_type: 'file_change',
      identity_key: path,
      path,
      call_id: null,
      status: nonEmptyString(data.change_type),
      details: boundedDetails(data, ['change_type', 'lines_added', 'lines_removed']),
    }
  }

  // Tool calls/results: the call id is the identity; without it there is
  // nothing stable to deduplicate on.
  const callId = nonEmptyString(data.call_id)
  if (eventType === 'tool_call' && callId) {
    return {
      artifact_type: 'tool_call',
      identity_key: callId,
      path: null,
      call_id: callId,
      status: null,
      details: boundedDetails(data, ['tool']),
    }
  }
  if (eventType === 'tool_result' && callId) {
    return {
      artifact_type: 'tool_result',
      identity_key: callId,
      path: null,
      call_id: callId,
      status: nonEmptyString(data.status),
      details: boundedDetails(data, ['tool']),
    }
  }

  // Test runs, approvals and explicit shell commands round out the allowlist.
  if (eventType.includes('test')) {
    const testRunId = nonEmptyString(data.test_run_id) ?? callId
    if (testRunId) {
      return {
        artifact_type: 'test_result',
        identity_key: testRunId,
        path: null,
        call_id: callId,
        status: nonEmptyString(data.status),
        details: {},
      }
    }
  }
  if (eventType.includes('approval')) {
    const approvalId = nonEmptyString(data.approval_id) ?? callId
    if (approvalId) {
      return {
        artifact_type: 'approval',
        identity_key: approvalId,
        path: null,
        call_id: callId,
        status: nonEmptyString(data.status),
        details: {},
      }
    }
  }
  const command = nonEmptyString(data.command)
  if (command) {
    const commandId = nonEmptyString(data.command_id) ?? command
    return {
      artifact_type: 'command',
      identity_key: commandId,
      path: null,
      call_id: callId,
      status: nonEmptyString(data.status),
      details: {},
    }
  }

  return null
}

function boundedDetails(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number' || typeof value === 'boolean' || nonEmptyString(value)) {
      details[key] = value
    }
  }
  return details
}
