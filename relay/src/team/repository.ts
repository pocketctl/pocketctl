import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import {
  candidateForProvider,
  offeredProviders,
  type DaemonAgentEvidence,
  type TeamAgentCandidate,
} from './agent-offers.js'
import type { TeamErrorCode, TeamProvider } from './types.js'

type Queryable = Pick<pg.PoolClient, 'query'>

export class TeamRepositoryError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message)
    this.name = 'TeamRepositoryError'
  }
}

export interface CollaborationTeamView {
  id: string
  name: string
  creator_user_id: number
  state: 'active' | 'dissolved'
  revision: number
  member_count: number
  created_at: string
  updated_at: string
}

export interface CollaborationMembershipView {
  id: string
  team_id: string
  user_id: number
  state: 'active' | 'left' | 'removed'
  revision: number
  display_label: string
  joined_at: string
  ended_at: string | null
}

export interface CollaborationInvitationView {
  id: string
  team_id: string
  invited_by_user_id: number
  recipient_user_id: number | null
  recipient_email: string | null
  team_name?: string
  invited_by_label?: string
  state: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
  revision: number
  expires_at: string
  created_at: string
}

export interface CollaborationAgentOfferView {
  id: string
  team_id: string
  owner_user_id: number
  daemon_id: string
  provider: TeamProvider
  runtime_profile_id: string | null
  capability_revision: number
  state: 'active' | 'revoked'
  revision: number
  availability: TeamAgentCandidate['availability']
  installed: boolean
  online: boolean
  managed_callable: boolean
  dispatch_supported: boolean
  created_at: string
  updated_at: string
}

function id(prefix: string): string {
  return `${prefix}${randomUUID()}`
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value)
}

function requestHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function maskedLabel(displayName: string | null, email: string): string {
  if (displayName?.trim()) return displayName.trim()
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`
}

export class TeamRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the domain failure.
      }
      throw error
    } finally {
      client.release()
    }
  }

  private async idempotent<T>(
    actorUserId: number,
    operation: string,
    requestId: string,
    payload: unknown,
    mutate: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const hash = requestHash(payload)
    return this.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `team:${actorUserId}:${operation}:${requestId}`,
      ])
      const prior = await client.query<{ request_hash: string; response: T }>(
        `SELECT request_hash, response FROM collaboration_team_idempotency
         WHERE user_id = $1 AND operation = $2 AND request_id = $3`,
        [actorUserId, operation, requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) {
          throw new TeamRepositoryError('idempotency_conflict', 'request_id was reused with different content')
        }
        return prior.rows[0].response
      }
      const response = await mutate(client)
      await client.query(
        `INSERT INTO collaboration_team_idempotency
           (user_id, operation, request_id, request_hash, response)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actorUserId, operation, requestId, hash, JSON.stringify(response)],
      )
      return response
    })
  }

  private async requireTeam(
    client: Queryable,
    teamId: string,
    actorUserId: number,
    options: { creator?: boolean; lock?: boolean } = {},
  ): Promise<{ team_id: string; creator_user_id: number; state: string; revision: number }> {
    const result = await client.query<{
      team_id: string
      creator_user_id: number
      state: string
      revision: string
    }>(
      `SELECT t.team_id, t.creator_user_id, t.state, t.revision
       FROM collaboration_teams t
       JOIN collaboration_team_memberships m
         ON m.team_id = t.team_id AND m.user_id = $2 AND m.state = 'active'
       WHERE t.team_id = $1${options.lock ? ' FOR UPDATE OF t' : ''}`,
      [teamId, actorUserId],
    )
    const row = result.rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found', 'team not found')
    if (row.state !== 'active') throw new TeamRepositoryError('invalid_state', 'team is not active')
    if (options.creator && row.creator_user_id !== actorUserId) {
      throw new TeamRepositoryError('creator_required', 'team creator authority required')
    }
    return { ...row, revision: Number(row.revision) }
  }

  private expectRevision(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new TeamRepositoryError('revision_conflict', 'revision mismatch', actual)
    }
  }

  async listTeams(actorUserId: number): Promise<CollaborationTeamView[]> {
    const result = await this.pool.query(
      `SELECT t.*, COUNT(active_members.membership_id)::int AS member_count
       FROM collaboration_teams t
       JOIN collaboration_team_memberships mine
         ON mine.team_id = t.team_id AND mine.user_id = $1 AND mine.state = 'active'
       LEFT JOIN collaboration_team_memberships active_members
         ON active_members.team_id = t.team_id AND active_members.state = 'active'
       WHERE t.state = 'active'
       GROUP BY t.team_id
       ORDER BY t.updated_at DESC`,
      [actorUserId],
    )
    return result.rows.map(row => this.teamView(row))
  }

  async getTeam(teamId: string, actorUserId: number): Promise<CollaborationTeamView> {
    await this.requireTeam(this.pool, teamId, actorUserId)
    const result = await this.pool.query(
      `SELECT t.*, COUNT(m.membership_id)::int AS member_count
       FROM collaboration_teams t
       LEFT JOIN collaboration_team_memberships m
         ON m.team_id = t.team_id AND m.state = 'active'
       WHERE t.team_id = $1 GROUP BY t.team_id`,
      [teamId],
    )
    return this.teamView(result.rows[0])
  }

  async createTeam(input: {
    actorUserId: number
    name: string
    requestId: string
  }): Promise<{ team: CollaborationTeamView; creator_membership: CollaborationMembershipView }> {
    return this.idempotent(input.actorUserId, 'team.create', input.requestId, { name: input.name }, async client => {
      const teamId = id('ctm_')
      const membershipId = id('cmb_')
      const team = await client.query(
        `INSERT INTO collaboration_teams (team_id, name, creator_user_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [teamId, input.name, input.actorUserId],
      )
      const membership = await client.query(
        `INSERT INTO collaboration_team_memberships (membership_id, team_id, user_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [membershipId, teamId, input.actorUserId],
      )
      return {
        team: this.teamView({ ...team.rows[0], member_count: 1 }),
        creator_membership: await this.membershipView(client, membership.rows[0]),
      }
    })
  }

  async renameTeam(input: {
    teamId: string
    actorUserId: number
    name: string
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationTeamView> {
    return this.idempotent(input.actorUserId, `team.rename:${input.teamId}`, input.requestId, {
      name: input.name,
      expected_revision: input.expectedRevision,
    }, async client => {
      const team = await this.requireTeam(client, input.teamId, input.actorUserId, { creator: true, lock: true })
      this.expectRevision(team.revision, input.expectedRevision)
      const updated = await client.query(
        `UPDATE collaboration_teams
         SET name = $2, revision = revision + 1, updated_at = NOW()
         WHERE team_id = $1 RETURNING *`,
        [input.teamId, input.name],
      )
      const count = await client.query<{ member_count: number }>(
        `SELECT COUNT(*)::int AS member_count FROM collaboration_team_memberships
         WHERE team_id = $1 AND state = 'active'`,
        [input.teamId],
      )
      return this.teamView({ ...updated.rows[0], member_count: count.rows[0].member_count })
    })
  }

  async listMembers(teamId: string, actorUserId: number): Promise<CollaborationMembershipView[]> {
    await this.requireTeam(this.pool, teamId, actorUserId)
    const result = await this.pool.query(
      `SELECT m.*, u.display_name, u.email
       FROM collaboration_team_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 AND m.state = 'active'
       ORDER BY m.joined_at ASC`,
      [teamId],
    )
    return result.rows.map(row => this.membershipViewFromJoined(row))
  }

  async invite(input: {
    teamId: string
    actorUserId: number
    email: string
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationInvitationView> {
    const email = input.email.trim().toLowerCase()
    return this.idempotent(input.actorUserId, `team.invite:${input.teamId}`, input.requestId, {
      email,
      expected_revision: input.expectedRevision,
    }, async client => {
      const team = await this.requireTeam(client, input.teamId, input.actorUserId, { creator: true, lock: true })
      this.expectRevision(team.revision, input.expectedRevision)
      const recipient = await client.query<{ id: number }>(
        `SELECT id FROM users WHERE lower(email) = $1`,
        [email],
      )
      const recipientUserId = recipient.rows[0]?.id ?? null
      if (recipientUserId === input.actorUserId) {
        throw new TeamRepositoryError('invalid_state', 'team creator is already a member')
      }
      if (recipientUserId !== null) {
        const membership = await client.query<{ state: string }>(
          `SELECT state FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2`,
          [input.teamId, recipientUserId],
        )
        if (membership.rows[0]) {
          throw new TeamRepositoryError('invalid_state', 'user already has a team membership record')
        }
      }
      const existing = await client.query(
        `SELECT * FROM collaboration_team_invitations
         WHERE team_id = $1 AND state = 'pending'
           AND (($2::int IS NOT NULL AND recipient_user_id = $2)
             OR ($2::int IS NULL AND recipient_user_id IS NULL AND lower(recipient_email) = $3))
         FOR UPDATE`,
        [input.teamId, recipientUserId, email],
      )
      if (existing.rows[0]) return this.invitationView(existing.rows[0])
      const invitation = await client.query(
        `INSERT INTO collaboration_team_invitations
           (invitation_id, team_id, invited_by_user_id, recipient_user_id, recipient_email, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days') RETURNING *`,
        [id('cin_'), input.teamId, input.actorUserId, recipientUserId, email],
      )
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [input.teamId],
      )
      return this.invitationView(invitation.rows[0])
    })
  }

  async listInvitations(teamId: string, actorUserId: number): Promise<CollaborationInvitationView[]> {
    await this.requireTeam(this.pool, teamId, actorUserId, { creator: true })
    const result = await this.pool.query(
      `SELECT i.*, t.name AS team_name, inviter.display_name AS inviter_display_name,
              inviter.email AS inviter_email
       FROM collaboration_team_invitations i
       JOIN collaboration_teams t ON t.team_id = i.team_id
       JOIN users inviter ON inviter.id = i.invited_by_user_id
       WHERE i.team_id = $1 ORDER BY i.created_at DESC`,
      [teamId],
    )
    return result.rows.map(row => this.invitationView(row))
  }

  async listMyInvitations(actorUserId: number): Promise<CollaborationInvitationView[]> {
    const result = await this.pool.query(
      `SELECT i.*, t.name AS team_name, inviter.display_name AS inviter_display_name,
              inviter.email AS inviter_email
       FROM collaboration_team_invitations i
       JOIN collaboration_teams t ON t.team_id = i.team_id
       JOIN users inviter ON inviter.id = i.invited_by_user_id
       JOIN users u ON u.id = $1
       WHERE i.state = 'pending'
         AND (i.recipient_user_id = $1 OR (i.recipient_user_id IS NULL AND lower(i.recipient_email) = lower(u.email)))
       ORDER BY i.created_at DESC`,
      [actorUserId],
    )
    return result.rows.map(row => this.invitationView(row))
  }

  async respondToInvitation(input: {
    invitationId: string
    actorUserId: number
    action: 'accepted' | 'declined'
    expectedRevision: number
    requestId: string
  }): Promise<{ invitation: CollaborationInvitationView; membership?: CollaborationMembershipView }> {
    return this.idempotent(input.actorUserId, `team.invitation.${input.action}:${input.invitationId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const result = await client.query(
        `SELECT i.*, u.email AS actor_email
         FROM collaboration_team_invitations i
         JOIN users u ON u.id = $2
         WHERE i.invitation_id = $1 FOR UPDATE OF i`,
        [input.invitationId, input.actorUserId],
      )
      const invitation = result.rows[0]
      const recipientMatches = invitation && (
        Number(invitation.recipient_user_id) === input.actorUserId
        || (invitation.recipient_user_id === null
          && invitation.recipient_email.toLowerCase() === invitation.actor_email.toLowerCase())
      )
      if (!recipientMatches) throw new TeamRepositoryError('team_not_found', 'invitation not found')
      if (invitation.state === input.action) {
        if (input.action === 'accepted') {
          const current = await client.query(
            `SELECT * FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2`,
            [invitation.team_id, input.actorUserId],
          )
          return {
            invitation: this.invitationView(invitation),
            ...(current.rows[0] ? { membership: await this.membershipView(client, current.rows[0]) } : {}),
          }
        }
        return { invitation: this.invitationView(invitation) }
      }
      if (invitation.state !== 'pending') {
        throw new TeamRepositoryError('invalid_state', `invitation is already ${invitation.state}`)
      }
      this.expectRevision(Number(invitation.revision), input.expectedRevision)
      if (new Date(invitation.expires_at).getTime() <= Date.now()) {
        await client.query(
          `UPDATE collaboration_team_invitations
           SET state = 'expired', revision = revision + 1, updated_at = NOW(), responded_at = NOW()
           WHERE invitation_id = $1`,
          [input.invitationId],
        )
        throw new TeamRepositoryError('invalid_state', 'invitation has expired')
      }
      await this.requireTeam(client, invitation.team_id, invitation.invited_by_user_id, { lock: true })
      const updated = await client.query(
        `UPDATE collaboration_team_invitations
         SET state = $2, recipient_user_id = COALESCE(recipient_user_id, $3),
             revision = revision + 1, updated_at = NOW(), responded_at = NOW()
         WHERE invitation_id = $1 RETURNING *`,
        [input.invitationId, input.action, input.actorUserId],
      )
      let membership: CollaborationMembershipView | undefined
      if (input.action === 'accepted') {
        const inserted = await client.query(
          `INSERT INTO collaboration_team_memberships (membership_id, team_id, user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (team_id, user_id) DO NOTHING RETURNING *`,
          [id('cmb_'), invitation.team_id, input.actorUserId],
        )
        if (!inserted.rows[0]) {
          const current = await client.query(
            `SELECT * FROM collaboration_team_memberships WHERE team_id = $1 AND user_id = $2`,
            [invitation.team_id, input.actorUserId],
          )
          if (current.rows[0]?.state !== 'active') {
            throw new TeamRepositoryError('invalid_state', 'former memberships cannot be reactivated')
          }
          membership = await this.membershipView(client, current.rows[0])
        } else {
          membership = await this.membershipView(client, inserted.rows[0])
        }
      }
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [invitation.team_id],
      )
      return { invitation: this.invitationView(updated.rows[0]), ...(membership ? { membership } : {}) }
    })
  }

  async revokeInvitation(input: {
    invitationId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationInvitationView> {
    return this.idempotent(input.actorUserId, `team.invitation.revoke:${input.invitationId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const result = await client.query(
        `SELECT * FROM collaboration_team_invitations WHERE invitation_id = $1 FOR UPDATE`,
        [input.invitationId],
      )
      const invitation = result.rows[0]
      if (!invitation) throw new TeamRepositoryError('team_not_found', 'invitation not found')
      await this.requireTeam(client, invitation.team_id, input.actorUserId, { creator: true, lock: true })
      if (invitation.state === 'revoked') return this.invitationView(invitation)
      if (invitation.state !== 'pending') {
        throw new TeamRepositoryError('invalid_state', `invitation is already ${invitation.state}`)
      }
      this.expectRevision(Number(invitation.revision), input.expectedRevision)
      const updated = await client.query(
        `UPDATE collaboration_team_invitations
         SET state = 'revoked', revision = revision + 1, updated_at = NOW(), responded_at = NOW()
         WHERE invitation_id = $1 RETURNING *`,
        [input.invitationId],
      )
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [invitation.team_id],
      )
      return this.invitationView(updated.rows[0])
    })
  }

  async leaveTeam(input: {
    teamId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationMembershipView> {
    return this.idempotent(input.actorUserId, `team.leave:${input.teamId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const team = await this.requireTeam(client, input.teamId, input.actorUserId, { lock: true })
      if (team.creator_user_id === input.actorUserId) {
        throw new TeamRepositoryError('invalid_state', 'team creator must dissolve the team')
      }
      const membership = await client.query(
        `SELECT * FROM collaboration_team_memberships
         WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.teamId, input.actorUserId],
      )
      this.expectRevision(Number(membership.rows[0].revision), input.expectedRevision)
      const updated = await client.query(
        `UPDATE collaboration_team_memberships
         SET state = 'left', revision = revision + 1, updated_at = NOW(), ended_at = NOW()
         WHERE membership_id = $1 RETURNING *`,
        [membership.rows[0].membership_id],
      )
      await this.revokeOwnerOffers(client, input.teamId, input.actorUserId)
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [input.teamId],
      )
      return this.membershipView(client, updated.rows[0])
    })
  }

  async removeMember(input: {
    teamId: string
    membershipId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationMembershipView> {
    return this.idempotent(input.actorUserId, `team.member.remove:${input.teamId}:${input.membershipId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const team = await this.requireTeam(client, input.teamId, input.actorUserId, { creator: true, lock: true })
      const membership = await client.query(
        `SELECT * FROM collaboration_team_memberships
         WHERE team_id = $1 AND membership_id = $2 FOR UPDATE`,
        [input.teamId, input.membershipId],
      )
      const current = membership.rows[0]
      if (!current) throw new TeamRepositoryError('team_not_found', 'membership not found')
      if (Number(current.user_id) === team.creator_user_id) {
        throw new TeamRepositoryError('invalid_state', 'team creator cannot be removed')
      }
      if (current.state === 'removed') return this.membershipView(client, current)
      if (current.state !== 'active') {
        throw new TeamRepositoryError('invalid_state', `membership is already ${current.state}`)
      }
      this.expectRevision(Number(current.revision), input.expectedRevision)
      const updated = await client.query(
        `UPDATE collaboration_team_memberships
         SET state = 'removed', revision = revision + 1, updated_at = NOW(), ended_at = NOW()
         WHERE membership_id = $1 RETURNING *`,
        [input.membershipId],
      )
      await this.revokeOwnerOffers(client, input.teamId, Number(current.user_id))
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [input.teamId],
      )
      return this.membershipView(client, updated.rows[0])
    })
  }

  async dissolveTeam(input: {
    teamId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationTeamView> {
    return this.idempotent(input.actorUserId, `team.dissolve:${input.teamId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const team = await this.requireTeam(client, input.teamId, input.actorUserId, { creator: true, lock: true })
      this.expectRevision(team.revision, input.expectedRevision)
      await client.query(
        `UPDATE collaboration_team_invitations
         SET state = 'revoked', revision = revision + 1, updated_at = NOW(), responded_at = NOW()
         WHERE team_id = $1 AND state = 'pending'`,
        [input.teamId],
      )
      await client.query(
        `UPDATE team_agent_offers
         SET state = 'revoked', revision = revision + 1, updated_at = NOW(), revoked_at = NOW()
         WHERE team_id = $1 AND state = 'active'`,
        [input.teamId],
      )
      await client.query(
        `UPDATE collaboration_session_agent_bindings binding
         SET state = 'unavailable', revision = binding.revision + 1, updated_at = NOW(), removed_at = NOW()
         FROM team_agent_offers offer
         WHERE binding.offer_id = offer.offer_id AND offer.team_id = $1 AND binding.state = 'active'`,
        [input.teamId],
      )
      await client.query(`DELETE FROM collaboration_team_daemon_bindings WHERE team_id = $1`, [input.teamId])
      await client.query(
        `UPDATE collaboration_team_memberships
         SET state = 'removed', revision = revision + 1, updated_at = NOW(), ended_at = NOW()
         WHERE team_id = $1 AND state = 'active'`,
        [input.teamId],
      )
      const updated = await client.query(
        `UPDATE collaboration_teams
         SET state = 'dissolved', revision = revision + 1, updated_at = NOW(), dissolved_at = NOW()
         WHERE team_id = $1 RETURNING *`,
        [input.teamId],
      )
      return this.teamView({ ...updated.rows[0], member_count: 0 })
    })
  }

  async listAgentCandidates(teamId: string, actorUserId: number): Promise<TeamAgentCandidate[]> {
    await this.requireTeam(this.pool, teamId, actorUserId)
    const result = await this.pool.query<DaemonAgentEvidence>(
      `SELECT d.daemon_id, d.hostname, d.status, d.agents, d.collaboration_capabilities, b.team_id
       FROM daemons d
       LEFT JOIN collaboration_team_daemon_bindings b ON b.daemon_id = d.daemon_id
       WHERE d.user_id = $1 ORDER BY d.hostname, d.daemon_id`,
      [actorUserId],
    )
    return result.rows.flatMap(daemon => offeredProviders(daemon.agents)
      .map(provider => candidateForProvider(daemon, provider, teamId)))
  }

  async listMyAgentCandidates(actorUserId: number): Promise<TeamAgentCandidate[]> {
    const result = await this.pool.query<DaemonAgentEvidence>(
      `SELECT d.daemon_id, d.hostname, d.status, d.agents, d.collaboration_capabilities, b.team_id
       FROM daemons d
       LEFT JOIN collaboration_team_daemon_bindings b ON b.daemon_id = d.daemon_id
       WHERE d.user_id = $1 ORDER BY d.hostname, d.daemon_id`,
      [actorUserId],
    )
    return result.rows.flatMap(daemon => offeredProviders(daemon.agents)
      .map(provider => candidateForProvider(daemon, provider, '')))
  }

  async listAgentOffers(teamId: string, actorUserId: number): Promise<CollaborationAgentOfferView[]> {
    await this.requireTeam(this.pool, teamId, actorUserId)
    const result = await this.pool.query(
      `SELECT o.*, d.hostname, d.status, d.agents, d.collaboration_capabilities, b.team_id AS occupied_team_id
       FROM team_agent_offers o
       JOIN daemons d ON d.daemon_id = o.daemon_id
       LEFT JOIN collaboration_team_daemon_bindings b ON b.daemon_id = o.daemon_id
       WHERE o.team_id = $1 ORDER BY o.created_at ASC`,
      [teamId],
    )
    return result.rows.map(row => this.offerView(row))
  }

  async addAgentOffer(input: {
    teamId: string
    actorUserId: number
    daemonId: string
    provider: TeamProvider
    runtimeProfileId: string | null
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationAgentOfferView> {
    return this.idempotent(input.actorUserId, `team.offer.add:${input.teamId}`, input.requestId, {
      daemon_id: input.daemonId,
      provider: input.provider,
      runtime_profile_id: input.runtimeProfileId,
      expected_revision: input.expectedRevision,
    }, async client => {
      const team = await this.requireTeam(client, input.teamId, input.actorUserId, { lock: true })
      this.expectRevision(team.revision, input.expectedRevision)
      const daemonResult = await client.query<DaemonAgentEvidence & { user_id: number }>(
        `SELECT daemon_id, hostname, status, agents, collaboration_capabilities, user_id FROM daemons
         WHERE daemon_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.daemonId, input.actorUserId],
      )
      const daemon = daemonResult.rows[0]
      if (!daemon) throw new TeamRepositoryError('team_not_found', 'daemon not found')
      const evidence = candidateForProvider(daemon, input.provider, input.teamId)
      if (!evidence.installed) {
        throw new TeamRepositoryError('capability_not_supported', 'provider is not installed on this daemon')
      }
      await client.query(
        `INSERT INTO collaboration_team_daemon_bindings (daemon_id, team_id, owner_user_id)
         VALUES ($1, $2, $3) ON CONFLICT (daemon_id) DO NOTHING`,
        [input.daemonId, input.teamId, input.actorUserId],
      )
      const binding = await client.query<{ team_id: string; owner_user_id: number }>(
        `SELECT team_id, owner_user_id FROM collaboration_team_daemon_bindings
         WHERE daemon_id = $1 FOR UPDATE`,
        [input.daemonId],
      )
      if (binding.rows[0]?.team_id !== input.teamId || binding.rows[0]?.owner_user_id !== input.actorUserId) {
        throw new TeamRepositoryError('daemon_team_conflict', 'daemon is already associated with another team')
      }
      const existing = await client.query(
        `SELECT o.*, d.hostname, d.status, d.agents, d.collaboration_capabilities, b.team_id AS occupied_team_id
         FROM team_agent_offers o
         JOIN daemons d ON d.daemon_id = o.daemon_id
         LEFT JOIN collaboration_team_daemon_bindings b ON b.daemon_id = o.daemon_id
         WHERE o.team_id = $1 AND o.owner_user_id = $2 AND o.daemon_id = $3
           AND o.provider = $4 AND COALESCE(o.runtime_profile_id, '') = COALESCE($5, '')
           AND o.state = 'active' FOR UPDATE OF o`,
        [input.teamId, input.actorUserId, input.daemonId, input.provider, input.runtimeProfileId],
      )
      if (existing.rows[0]) return this.offerView(existing.rows[0])
      const inserted = await client.query(
        `INSERT INTO team_agent_offers
           (offer_id, team_id, owner_user_id, daemon_id, provider, runtime_profile_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id('cao_'), input.teamId, input.actorUserId, input.daemonId, input.provider, input.runtimeProfileId],
      )
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [input.teamId],
      )
      return this.offerView({ ...inserted.rows[0], ...daemon, occupied_team_id: input.teamId })
    })
  }

  async revokeAgentOffer(input: {
    offerId: string
    actorUserId: number
    expectedRevision: number
    requestId: string
  }): Promise<CollaborationAgentOfferView> {
    return this.idempotent(input.actorUserId, `team.offer.revoke:${input.offerId}`, input.requestId, {
      expected_revision: input.expectedRevision,
    }, async client => {
      const result = await client.query(
        `SELECT o.*, d.hostname, d.status, d.agents, d.collaboration_capabilities, b.team_id AS occupied_team_id
         FROM team_agent_offers o
         JOIN daemons d ON d.daemon_id = o.daemon_id
         LEFT JOIN collaboration_team_daemon_bindings b ON b.daemon_id = o.daemon_id
         WHERE o.offer_id = $1 FOR UPDATE OF o`,
        [input.offerId],
      )
      await client.query(
        `UPDATE collaboration_session_agent_bindings
         SET state = 'unavailable', revision = revision + 1, updated_at = NOW(), removed_at = NOW()
         WHERE offer_id = $1 AND state = 'active'`,
        [input.offerId],
      )
      const offer = result.rows[0]
      if (!offer) throw new TeamRepositoryError('team_not_found', 'offer not found')
      await this.requireTeam(client, offer.team_id, input.actorUserId, { lock: true })
      if (Number(offer.owner_user_id) !== input.actorUserId) {
        throw new TeamRepositoryError('team_not_found', 'offer not found')
      }
      if (offer.state === 'revoked') return this.offerView(offer)
      this.expectRevision(Number(offer.revision), input.expectedRevision)
      const updated = await client.query(
        `UPDATE team_agent_offers
         SET state = 'revoked', revision = revision + 1, updated_at = NOW(), revoked_at = NOW()
         WHERE offer_id = $1 RETURNING *`,
        [input.offerId],
      )
      await this.releaseDaemonBindingIfUnused(client, offer.daemon_id, offer.team_id)
      await client.query(
        `UPDATE collaboration_teams SET revision = revision + 1, updated_at = NOW() WHERE team_id = $1`,
        [offer.team_id],
      )
      return this.offerView({ ...offer, ...updated.rows[0] })
    })
  }

  private async revokeOwnerOffers(client: Queryable, teamId: string, ownerUserId: number): Promise<void> {
    const revoked = await client.query<{ daemon_id: string; offer_id: string }>(
      `UPDATE team_agent_offers
       SET state = 'revoked', revision = revision + 1, updated_at = NOW(), revoked_at = NOW()
       WHERE team_id = $1 AND owner_user_id = $2 AND state = 'active'
       RETURNING daemon_id, offer_id`,
      [teamId, ownerUserId],
    )
    const offerIds = revoked.rows.map(row => row.offer_id)
    if (offerIds.length > 0) {
      await client.query(
        `UPDATE collaboration_session_agent_bindings
         SET state = 'unavailable', revision = revision + 1, updated_at = NOW(), removed_at = NOW()
         WHERE offer_id = ANY($1::text[]) AND state = 'active'`,
        [offerIds],
      )
    }
    for (const daemonId of new Set(revoked.rows.map(row => row.daemon_id))) {
      await this.releaseDaemonBindingIfUnused(client, daemonId, teamId)
    }
  }

  private async releaseDaemonBindingIfUnused(client: Queryable, daemonId: string, teamId: string): Promise<void> {
    await client.query(
      `DELETE FROM collaboration_team_daemon_bindings b
       WHERE b.daemon_id = $1 AND b.team_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM team_agent_offers o
           WHERE o.daemon_id = b.daemon_id AND o.team_id = b.team_id AND o.state = 'active'
         )`,
      [daemonId, teamId],
    )
  }

  private teamView(row: any): CollaborationTeamView {
    return {
      id: row.team_id,
      name: row.name,
      creator_user_id: Number(row.creator_user_id),
      state: row.state,
      revision: Number(row.revision),
      member_count: Number(row.member_count ?? 0),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
  }

  private async membershipView(client: Queryable, row: any): Promise<CollaborationMembershipView> {
    const user = await client.query<{ display_name: string | null; email: string }>(
      `SELECT display_name, email FROM users WHERE id = $1`,
      [row.user_id],
    )
    return this.membershipViewFromJoined({ ...row, ...user.rows[0] })
  }

  private membershipViewFromJoined(row: any): CollaborationMembershipView {
    return {
      id: row.membership_id,
      team_id: row.team_id,
      user_id: Number(row.user_id),
      state: row.state,
      revision: Number(row.revision),
      display_label: maskedLabel(row.display_name ?? null, row.email),
      joined_at: iso(row.joined_at),
      ended_at: nullableIso(row.ended_at ?? null),
    }
  }

  private invitationView(row: any): CollaborationInvitationView {
    return {
      id: row.invitation_id,
      team_id: row.team_id,
      invited_by_user_id: Number(row.invited_by_user_id),
      recipient_user_id: row.recipient_user_id === null ? null : Number(row.recipient_user_id),
      recipient_email: row.recipient_email,
      ...(row.team_name ? { team_name: row.team_name } : {}),
      ...(row.inviter_email ? {
        invited_by_label: maskedLabel(row.inviter_display_name ?? null, row.inviter_email),
      } : {}),
      state: row.state,
      revision: Number(row.revision),
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at),
    }
  }

  private offerView(row: any): CollaborationAgentOfferView {
    const candidate = candidateForProvider({
      daemon_id: row.daemon_id,
      hostname: row.hostname ?? null,
      status: row.status,
      agents: row.agents,
      collaboration_capabilities: row.collaboration_capabilities,
      team_id: row.occupied_team_id ?? null,
    }, row.provider, row.team_id)
    return {
      id: row.offer_id,
      team_id: row.team_id,
      owner_user_id: Number(row.owner_user_id),
      daemon_id: row.daemon_id,
      provider: row.provider,
      runtime_profile_id: row.runtime_profile_id,
      capability_revision: Number(row.capability_revision),
      state: row.state,
      revision: Number(row.revision),
      availability: candidate.availability,
      installed: candidate.installed,
      online: candidate.online,
      managed_callable: candidate.managed_callable,
      dispatch_supported: candidate.dispatch_supported,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
  }
}
