import { randomUUID } from 'crypto'
import type pg from 'pg'
import type { ExtensionScope, ExtensionTopic, InstallationStatus } from './types.js'

export interface ExtensionInstallation {
  installation_id: string
  provider_id: string
  owner_user_id: number
  status: InstallationStatus
  granted_scopes: string[]
  subscriptions: string[]
  enabled_services: string[]
  event_filter: Record<string, unknown>
  start_policy: 'from_now' | 'retained_history'
  start_feed_id: number
  config_version: number
  created_at: Date
  updated_at: Date
}

export class ExtensionInstallationConflictError extends Error {
  constructor() {
    super('provider already installed for this user')
    this.name = 'ExtensionInstallationConflictError'
  }
}

export class ExtensionInstallationNotFoundError extends Error {
  constructor() {
    super('installation not found')
    this.name = 'ExtensionInstallationNotFoundError'
  }
}

export class ExtensionInstallationVersionConflictError extends Error {
  constructor() {
    super('installation config version mismatch')
    this.name = 'ExtensionInstallationVersionConflictError'
  }
}

export class ExtensionInstallationTransitionError extends Error {
  constructor(from: InstallationStatus, to: InstallationStatus) {
    super(`illegal installation transition ${from} -> ${to}`)
    this.name = 'ExtensionInstallationTransitionError'
  }
}

/**
 * Pure installation state machine:
 *
 *   pending -> active <-> paused
 *   active/paused/pending -> revoking -> revoked
 *
 * `degraded` is derived from status-report staleness by the query layer and
 * is never persisted here.
 */
const ALLOWED_TRANSITIONS: Record<InstallationStatus, readonly InstallationStatus[]> = {
  pending: ['active', 'paused', 'revoking'],
  active: ['paused', 'revoking'],
  paused: ['active', 'revoking'],
  revoking: ['revoked'],
  revoked: [],
}

export function canTransitionInstallation(
  from: InstallationStatus,
  to: InstallationStatus,
): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to)
}

interface InstallationRow {
  installation_id: string
  provider_id: string
  owner_user_id: number
  status: InstallationStatus
  granted_scopes: string[]
  subscriptions: string[]
  enabled_services: string[]
  event_filter: Record<string, unknown>
  start_policy: 'from_now' | 'retained_history'
  start_feed_id: string | number
  config_version: string | number
  created_at: Date
  updated_at: Date
}

function toInstallation(row: InstallationRow): ExtensionInstallation {
  return {
    installation_id: row.installation_id,
    provider_id: row.provider_id,
    owner_user_id: Number(row.owner_user_id),
    status: row.status,
    granted_scopes: row.granted_scopes ?? [],
    subscriptions: row.subscriptions ?? [],
    enabled_services: row.enabled_services ?? [],
    event_filter: row.event_filter ?? {},
    start_policy: row.start_policy,
    start_feed_id: Number(row.start_feed_id),
    config_version: Number(row.config_version),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const INSTALLATION_COLUMNS = `
  installation_id, provider_id, owner_user_id, status, granted_scopes,
  subscriptions, enabled_services, event_filter, start_policy,
  start_feed_id, config_version, created_at, updated_at
`

export interface CreateInstallationInput {
  ownerUserId: number
  providerId: string
  grantedScopes: ExtensionScope[]
  subscriptions: ExtensionTopic[]
  enabledServices: string[]
  eventFilter: Record<string, unknown>
  startPolicy: 'from_now' | 'retained_history'
}

export interface UpdateInstallationPatch {
  status?: InstallationStatus
  granted_scopes?: string[]
  subscriptions?: string[]
  enabled_services?: string[]
  event_filter?: Record<string, unknown>
}

export class ExtensionInstallationRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query' | 'connect'>) {}

  async listInstallations(ownerUserId: number): Promise<ExtensionInstallation[]> {
    const result = await this.pool.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS}
       FROM extension_installations
       WHERE owner_user_id = $1
       ORDER BY created_at ASC`,
      [ownerUserId],
    )
    return result.rows.map(toInstallation)
  }

  async createInstallation(input: CreateInstallationInput): Promise<ExtensionInstallation> {
    // from_now anchors the checkpoint at the current feed head so the
    // provider never receives pre-installation history implicitly.
    const startFeedId = input.startPolicy === 'from_now'
      ? Number((await this.pool.query<{ max: string | null }>(
        `SELECT COALESCE(MAX(feed_id), 0)::text AS max FROM extension_feed`,
      )).rows[0]?.max ?? 0)
      : 0
    const result = await this.pool.query<InstallationRow>(
      `INSERT INTO extension_installations
         (installation_id, provider_id, owner_user_id, status, granted_scopes,
          subscriptions, enabled_services, event_filter, start_policy, start_feed_id, config_version)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7::jsonb, $8, $9, 1)
       ON CONFLICT (owner_user_id, provider_id)
         WHERE status IN ('pending', 'active', 'paused', 'revoking')
       DO NOTHING
       RETURNING ${INSTALLATION_COLUMNS}`,
      [
        randomUUID(), input.providerId, input.ownerUserId,
        input.grantedScopes, input.subscriptions, input.enabledServices,
        JSON.stringify(input.eventFilter ?? {}), input.startPolicy, startFeedId,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new ExtensionInstallationConflictError()
    return toInstallation(row)
  }

  async updateInstallation(
    ownerUserId: number,
    installationId: string,
    expectedConfigVersion: number,
    patch: UpdateInstallationPatch,
  ): Promise<ExtensionInstallation> {
    if (patch.status) {
      await this.canTransitionTo(ownerUserId, installationId, patch.status)
    }
    const result = await this.pool.query<InstallationRow>(
      `UPDATE extension_installations
       SET status = COALESCE($3, status),
           granted_scopes = COALESCE($4, granted_scopes),
           subscriptions = COALESCE($5, subscriptions),
           enabled_services = COALESCE($6, enabled_services),
           event_filter = COALESCE($7::jsonb, event_filter),
           config_version = config_version + 1,
           updated_at = NOW()
       WHERE installation_id = $1
         AND owner_user_id = $2
         AND config_version = $8
       RETURNING ${INSTALLATION_COLUMNS}`,
      [
        installationId, ownerUserId,
        patch.status ?? null,
        patch.granted_scopes ?? null,
        patch.subscriptions ?? null,
        patch.enabled_services ?? null,
        patch.event_filter === undefined ? null : JSON.stringify(patch.event_filter),
        expectedConfigVersion,
      ],
    )
    const row = result.rows[0]
    if (!row) {
      // Distinguish a missing row (404) from a lost optimistic-lock race (409).
      const exists = await this.pool.query(
        `SELECT 1 FROM extension_installations WHERE installation_id = $1 AND owner_user_id = $2`,
        [installationId, ownerUserId],
      )
      if ((exists.rowCount ?? 0) === 0) throw new ExtensionInstallationNotFoundError()
      throw new ExtensionInstallationVersionConflictError()
    }
    return toInstallation(row)
  }

  private async canTransitionTo(
    ownerUserId: number,
    installationId: string,
    to: InstallationStatus,
  ): Promise<boolean> {
    const current = await this.pool.query<{ status: InstallationStatus }>(
      `SELECT status FROM extension_installations
       WHERE installation_id = $1 AND owner_user_id = $2`,
      [installationId, ownerUserId],
    )
    const from = current.rows[0]?.status
    if (!from) throw new ExtensionInstallationNotFoundError()
    if (!canTransitionInstallation(from, to)) {
      throw new ExtensionInstallationTransitionError(from, to)
    }
    return true
  }

  /**
   * Uninstall closes capabilities immediately but keeps the row (and its
   * checkpoint) in revoking so the provider can still drain its purge queue.
   */
  async revokeInstallation(
    ownerUserId: number,
    installationId: string,
  ): Promise<{ installation: { installation_id: string; status: InstallationStatus }; purge_request_id: string }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<{ provider_id: string; status: InstallationStatus }>(
        `UPDATE extension_installations
         SET status = 'revoking', config_version = config_version + 1, updated_at = NOW()
         WHERE installation_id = $1 AND owner_user_id = $2 AND status <> 'revoked'
         RETURNING provider_id, status`,
        [installationId, ownerUserId],
      )
      const row = result.rows[0]
      if (!row) throw new ExtensionInstallationNotFoundError()
      const purgeRequestId = randomUUID()
      const purge = await client.query<{ request_id: string }>(
        `INSERT INTO extension_purge_requests
           (request_id, provider_id, installation_id, reason, expires_at)
         VALUES ($1, $2, $3, 'uninstall', NOW() + INTERVAL '30 days')
         ON CONFLICT (provider_id, installation_id, reason) DO UPDATE SET
           status = 'pending', requested_at = NOW(), acked_at = NULL,
           provider_receipt = NULL, expires_at = NOW() + INTERVAL '30 days'
         RETURNING request_id`,
        [purgeRequestId, row.provider_id, installationId],
      )
      await client.query('COMMIT')
      return {
        installation: { installation_id: installationId, status: row.status },
        purge_request_id: purge.rows[0]?.request_id ?? purgeRequestId,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async getInstallationForUser(
    ownerUserId: number,
    installationId: string,
  ): Promise<ExtensionInstallation | null> {
    const result = await this.pool.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS}
       FROM extension_installations
       WHERE installation_id = $1 AND owner_user_id = $2`,
      [installationId, ownerUserId],
    )
    const row = result.rows[0]
    return row ? toInstallation(row) : null
  }
}
