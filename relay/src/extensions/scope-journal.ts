import type pg from 'pg'

import type { MembershipState, ScopeRole, SharedScopeKind } from './scope-types.js'

/**
 * ADR-0005 append-only scope control journal. Membership and lifecycle
 * mutations append one bounded event row to `extension_scope_outbox` inside
 * the mutation's own transaction; the v2 feed projector (Task 3) wraps these
 * rows into `extension-feed.v2` envelopes. Payloads carry only opaque ids,
 * state, roles, revisions, and epochs — never email, display name, or any
 * content (§5.2 allowlist).
 */

export type ScopeControlTopic = 'scope.membership.v2' | 'scope.lifecycle.v2'

export type ScopeMembershipEventType =
  | 'membership_created'
  | 'membership_roles_changed'
  | 'membership_state_changed'

export type ScopeLifecycleEventType =
  | 'scope_created'
  | 'scope_suspended'
  | 'scope_dissolving'
  | 'scope_dissolved'

export interface ScopeMembershipEventData {
  membership_id: string
  event_type: ScopeMembershipEventType
  membership_revision: number
  state: MembershipState
  roles: readonly ScopeRole[]
  authorization_epoch: number
}

export interface ScopeLifecycleEventData {
  event_type: ScopeLifecycleEventType
  authorization_epoch: number
  revision: number
  state: string
}

/** Append one membership control event; caller owns the transaction. */
export async function appendMembershipEvent(
  client: Pick<pg.PoolClient, 'query'>,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    data: ScopeMembershipEventData
  },
): Promise<void> {
  await client.query(
    `INSERT INTO extension_scope_outbox (scope_kind, scope_id, topic, payload)
     VALUES ($1, $2, 'scope.membership.v2', $3::jsonb)`,
    [
      input.scopeKind,
      input.scopeId,
      JSON.stringify({
        membership_id: input.data.membership_id,
        event_type: input.data.event_type,
        membership_revision: input.data.membership_revision,
        state: input.data.state,
        roles: input.data.roles,
        authorization_epoch: input.data.authorization_epoch,
      }),
    ],
  )
}

/** Append one scope lifecycle control event; caller owns the transaction. */
export async function appendLifecycleEvent(
  client: Pick<pg.PoolClient, 'query'>,
  input: {
    scopeKind: SharedScopeKind
    scopeId: string
    data: ScopeLifecycleEventData
  },
): Promise<void> {
  await client.query(
    `INSERT INTO extension_scope_outbox (scope_kind, scope_id, topic, payload)
     VALUES ($1, $2, 'scope.lifecycle.v2', $3::jsonb)`,
    [
      input.scopeKind,
      input.scopeId,
      JSON.stringify({
        event_type: input.data.event_type,
        authorization_epoch: input.data.authorization_epoch,
        revision: input.data.revision,
        state: input.data.state,
      }),
    ],
  )
}
