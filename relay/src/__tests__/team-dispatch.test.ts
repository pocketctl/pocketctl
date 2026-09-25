import { describe, expect, test } from 'vitest'

import {
  dispatchAuthorizationMatches,
  dispatchProjectionKind,
  TEAM_COLLABORATION_PROTOCOL_VERSION,
  TEAM_DISPATCH_CAPABILITY,
} from '../team/dispatch-repository.js'

const authorization = {
  protocol_version: TEAM_COLLABORATION_PROTOCOL_VERSION,
  operation: 'message' as const,
  call_id: 'call-1', team_session_id: 'team-session-1', binding_id: 'binding-1', binding_revision: 2,
  offer_id: 'offer-1', offer_revision: 4, owner_user_id: 9, daemon_id: 'daemon-1',
}

describe('Team dispatch contract', () => {
  test('binds authorization to owner, daemon, offer, binding, and revisions', () => {
    const accounting = {
      daemon_id: 'daemon-1', owner_user_id: 9, binding_id: 'binding-1', binding_revision: 2,
      offer_id: 'offer-1', offer_revision: 4,
    }
    expect(dispatchAuthorizationMatches(accounting, authorization, 'daemon-1', 9)).toBe(true)
    expect(dispatchAuthorizationMatches(accounting, { ...authorization, binding_revision: 3 }, 'daemon-1', 9)).toBe(false)
    expect(dispatchAuthorizationMatches(accounting, authorization, 'daemon-2', 9)).toBe(false)
    expect(dispatchAuthorizationMatches(accounting, authorization, 'daemon-1', 10)).toBe(false)
    expect(TEAM_DISPATCH_CAPABILITY).toBe('team_collaboration_dispatch_v1')
  })

  test('projects only shared reply text and terminal lifecycle', () => {
    expect(dispatchProjectionKind({ type: 'agent_text', text: 'answer' })).toBe('agent_message')
    expect(dispatchProjectionKind({ type: 'turn_status', status: 'completed' })).toBe('status')
    expect(dispatchProjectionKind({ type: 'approval_request', text: 'secret' })).toBeNull()
    expect(dispatchProjectionKind({ type: 'tool_call', text: 'rm -rf' })).toBeNull()
    expect(dispatchProjectionKind({ type: 'agent_reasoning', text: 'hidden' })).toBeNull()
    expect(dispatchProjectionKind({ type: 'turn_status', status: 'running' })).toBeNull()
  })
})
