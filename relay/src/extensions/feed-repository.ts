import type pg from 'pg'
import type { ExtensionSourceRow } from './envelope.js'

/**
 * Shared-feed repository primitives. Everything here runs on a caller-owned
 * transaction client: the projector owns BEGIN/COMMIT so a crash between the
 * feed insert and the source delete rolls the whole batch back.
 */

export interface ClaimedSourceBatch {
  rows: ExtensionSourceRow[]
}

export async function claimSourceBatch(
  client: Pick<pg.PoolClient, 'query'>,
  limit: number,
): Promise<ClaimedSourceBatch> {
  const result = await client.query<ExtensionSourceRow>(`
    SELECT source_seq, source_kind, source_id, owner_user_id, session_id,
           event_type, occurred_at, payload, created_at
    FROM extension_source_outbox
    ORDER BY source_seq
    FOR UPDATE SKIP LOCKED
    LIMIT $1
  `, [limit])
  return { rows: result.rows }
}

export interface FeedInsertRow {
  owner_user_id: number
  topic: string
  source_kind: string
  source_id: string
  session_id: string | null
  turn_id: string | null
  envelope: Record<string, unknown>
}

export async function insertFeedRows(
  client: Pick<pg.PoolClient, 'query'>,
  rows: FeedInsertRow[],
): Promise<void> {
  if (rows.length === 0) return
  await client.query(`
    INSERT INTO extension_feed
      (owner_user_id, topic, source_kind, source_id, session_id, turn_id, payload)
    SELECT (item->>'owner_user_id')::int, item->>'topic', item->>'source_kind', item->>'source_id',
           NULLIF(item->>'session_id', ''), NULLIF(item->>'turn_id', ''), (item->>'envelope')::jsonb
    FROM jsonb_array_elements($1::jsonb) AS t(item)
    ON CONFLICT (source_kind, source_id, topic, envelope_version) DO NOTHING
  `, [JSON.stringify(rows.map(row => ({
    owner_user_id: String(row.owner_user_id),
    topic: row.topic,
    source_kind: row.source_kind,
    source_id: row.source_id,
    session_id: row.session_id ?? '',
    turn_id: row.turn_id ?? '',
    envelope: JSON.stringify(row.envelope),
  })))])
}

export async function deleteSourceRows(
  client: Pick<pg.PoolClient, 'query'>,
  sourceSeqs: Array<number | string>,
): Promise<void> {
  if (sourceSeqs.length === 0) return
  await client.query(
    `DELETE FROM extension_source_outbox WHERE source_seq = ANY($1::bigint[])`,
    [sourceSeqs.map(seq => Number(seq))],
  )
}

export async function countSourceBacklog(
  pool: Pick<pg.Pool, 'query'>,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM extension_source_outbox`,
  )
  return Number(result.rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// Pull / lease / ACK consumption path. Every mutation runs inside one
// transaction that locks the installation row together with its checkpoint,
// so concurrent provider instances resolve through the database, not memory.
// ---------------------------------------------------------------------------

export interface InstallationWithCheckpointRow {
  installation_id: string
  provider_id: string
  owner_user_id: number | null
  status: string
  granted_scopes: string[]
  subscriptions: string[]
  event_filter: Record<string, unknown>
  start_feed_id: string | number
  config_version: string | number
  ack_feed_id: string | number
  lease_epoch: string | number
  lease_token_hash: Buffer | null
  lease_expires_at: Date | null
  snapshot_required_at?: Date | null
}

export async function getInstallationWithCheckpointForUpdate(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  providerId: string,
): Promise<InstallationWithCheckpointRow | null> {
  // Lock the installation first; a cross-provider id resolves to null before
  // any checkpoint state is touched (no existence leak).
  const installation = await client.query<{
    installation_id: string
    provider_id: string
    owner_user_id: number
    status: string
    granted_scopes: string[]
    subscriptions: string[]
    event_filter: Record<string, unknown>
    start_feed_id: string | number
    config_version: string | number
  }>(`
    SELECT installation_id, provider_id, owner_user_id, status, granted_scopes,
           subscriptions, event_filter, start_feed_id, config_version
    FROM extension_installations
    WHERE installation_id = $1 AND provider_id = $2
    FOR UPDATE
  `, [installationId, providerId])
  const row = installation.rows[0]
  if (!row) return null

  await client.query(
    `INSERT INTO extension_checkpoints (installation_id) VALUES ($1)
     ON CONFLICT (installation_id) DO NOTHING`,
    [installationId],
  )
  const checkpoint = await client.query<{
    ack_feed_id: string | number
    lease_epoch: string | number
    lease_token_hash: Buffer | null
    lease_expires_at: Date | null
    snapshot_required_at: Date | null
  }>(`
    SELECT ack_feed_id, lease_epoch, lease_token_hash, lease_expires_at, snapshot_required_at
    FROM extension_checkpoints
    WHERE installation_id = $1
    FOR UPDATE
  `, [installationId])
  return { ...row, ...checkpoint.rows[0] }
}

export interface FeedQueryOptions {
  ownerUserId: number
  topics: string[]
  afterFeedId: number
  limit: number
  daemonIds?: string[]
  agentTypes?: string[]
}

export interface FeedQueryRow {
  feed_id: string | number
  topic: string
  session_id: string | null
  turn_id: string | null
  occurred_at: Date | null
  payload: Record<string, unknown>
}

export async function queryFeedRows(
  client: Pick<pg.PoolClient, 'query'>,
  options: FeedQueryOptions,
): Promise<FeedQueryRow[]> {
  const hasFilter = (options.daemonIds?.length ?? 0) > 0 || (options.agentTypes?.length ?? 0) > 0
  // Tombstone rows (deletion/revoke) must reach filtered installations even
  // though their sessions row is already gone — filters narrow CONTENT only.
  const result = await client.query<FeedQueryRow>(`
    SELECT f.feed_id, f.topic, f.session_id, f.turn_id, f.occurred_at, f.payload
    FROM extension_feed f
    ${hasFilter ? `
      LEFT JOIN sessions s ON s.session_id = f.session_id
    ` : ''}
    WHERE f.owner_user_id = $1
      AND f.topic = ANY($2)
      AND f.feed_id > $3
      ${options.daemonIds?.length ? "AND (f.source_kind <> 'canonical_event' OR s.daemon_id = ANY($4))" : ''}
      ${options.agentTypes?.length
    ? `AND (f.source_kind <> 'canonical_event' OR s.agent_type = ANY($${options.daemonIds?.length ? 5 : 4}))`
    : ''}
    ORDER BY f.feed_id ASC
    LIMIT ${Math.max(1, Math.trunc(options.limit))}
  `, withFilterParams(options))
  return result.rows
}

function withFilterParams(options: FeedQueryOptions): unknown[] {
  const params: unknown[] = [
    options.ownerUserId,
    options.topics,
    options.afterFeedId,
  ]
  if (options.daemonIds?.length) params.push(options.daemonIds)
  if (options.agentTypes?.length) params.push(options.agentTypes)
  return params
}

export async function updateLease(
  client: Pick<pg.PoolClient, 'query'>,
  input: {
    installationId: string
    leaseEpoch: number
    leaseTokenHash: Buffer
    leaseExpiresAt: Date
  },
): Promise<void> {
  await client.query(
    `UPDATE extension_checkpoints
     SET lease_epoch = $2, lease_token_hash = $3, lease_expires_at = $4, updated_at = NOW()
     WHERE installation_id = $1`,
    [input.installationId, input.leaseEpoch, input.leaseTokenHash, input.leaseExpiresAt],
  )
}

/**
 * Monotonic, fenced ACK: only the exact lease binding (epoch + token hash +
 * issued position + unexpired) may advance the checkpoint, and the stored
 * value only ever moves forward via GREATEST.
 */
export async function ackCheckpoint(
  client: Pick<pg.PoolClient, 'query'>,
  input: {
    installationId: string
    leaseEpoch: number
    bindingHash: Buffer
    newAckFeedId: number
  },
): Promise<number | null> {
  const result = await client.query<{ ack_feed_id: string }>(`
    UPDATE extension_checkpoints
    SET ack_feed_id = GREATEST(ack_feed_id, $2), updated_at = NOW()
    WHERE installation_id = $1
      AND lease_epoch = $3
      AND lease_token_hash = $4
      AND lease_expires_at > NOW()
    RETURNING ack_feed_id
  `, [input.installationId, input.newAckFeedId, input.leaseEpoch, input.bindingHash])
  if (result.rows.length === 0) return null
  return Number(result.rows[0].ack_feed_id)
}

export async function resetCheckpointForReplay(
  client: Pick<pg.PoolClient, 'query'>,
  input: {
    installationId: string
    ackFeedId: number
    startFeedId: number
  },
): Promise<{ lease_epoch: number }> {
  await client.query(
    `UPDATE extension_installations
     SET start_feed_id = LEAST(start_feed_id, $2), updated_at = NOW()
     WHERE installation_id = $1`,
    [input.installationId, input.startFeedId],
  );
  const result = await client.query<{ lease_epoch: string }>(`
    UPDATE extension_checkpoints
    SET ack_feed_id = $2, lease_epoch = lease_epoch + 1,
        lease_token_hash = NULL, lease_expires_at = NULL,
        snapshot_required_at = NULL, updated_at = NOW()
    WHERE installation_id = $1
    RETURNING lease_epoch
  `, [input.installationId, input.ackFeedId]);
  return { lease_epoch: Number(result.rows[0]?.lease_epoch ?? 0) };
}

// --- extension-feed.v2 shared-scope consumption path ---------------------------

/**
 * Shared installations only: like getInstallationWithCheckpointForUpdate but
 * requires a team/organization owner scope and also returns the scope fence
 * columns. A personal (or missing/cross-provider) installation resolves to
 * null with no existence leak.
 */
export interface SharedInstallationWithCheckpointRow extends InstallationWithCheckpointRow {
  owner_user_id: number | null
  owner_scope_kind: 'team' | 'organization'
  owner_scope_id: string
  scope_authorization_epoch: string | number
}

export async function getSharedInstallationWithCheckpointForUpdate(
  client: Pick<pg.PoolClient, 'query'>,
  installationId: string,
  providerId: string,
): Promise<SharedInstallationWithCheckpointRow | null> {
  const installation = await client.query<{
    installation_id: string
    provider_id: string
    owner_user_id: number | null
    status: string
    granted_scopes: string[]
    subscriptions: string[]
    event_filter: Record<string, unknown>
    start_feed_id: string | number
    config_version: string | number
    owner_scope_kind: 'team' | 'organization' | 'personal'
    owner_scope_id: string
    authorization_epoch: string | number
  }>(`
    SELECT installation_id, provider_id, owner_user_id, status, granted_scopes,
           subscriptions, event_filter, start_feed_id, config_version,
           owner_scope_kind, owner_scope_id, authorization_epoch
    FROM extension_installations
    WHERE installation_id = $1 AND provider_id = $2
      AND owner_scope_kind IN ('team', 'organization')
    FOR UPDATE
  `, [installationId, providerId]);
  const row = installation.rows[0];
  if (!row) return null;

  await client.query(
    `INSERT INTO extension_checkpoints (installation_id) VALUES ($1)
     ON CONFLICT (installation_id) DO NOTHING`,
    [installationId],
  );
  const checkpoint = await client.query<{
    ack_feed_id: string | number
    lease_epoch: string | number
    lease_token_hash: Buffer | null
    lease_expires_at: Date | null
    snapshot_required_at: Date | null
  }>(`
    SELECT ack_feed_id, lease_epoch, lease_token_hash, lease_expires_at, snapshot_required_at
    FROM extension_checkpoints
    WHERE installation_id = $1
    FOR UPDATE
  `, [installationId]);
  return {
    ...row,
    ...checkpoint.rows[0],
    // The WHERE clause already restricted this to shared kinds.
    owner_scope_kind: row.owner_scope_kind as 'team' | 'organization',
    scope_authorization_epoch: row.authorization_epoch,
  };
}

export interface ScopeOutboxQueryRow {
  outbox_id: string | number
  scope_kind: 'team' | 'organization'
  scope_id: string
  topic: string
  payload: Record<string, unknown>
  recorded_at: Date
}

export async function queryScopeOutboxRows(
  client: Pick<pg.PoolClient, 'query'>,
  options: {
    scopeKind: 'team' | 'organization'
    scopeId: string
    topics: string[]
    afterOutboxId: number
    limit: number
  },
): Promise<ScopeOutboxQueryRow[]> {
  const result = await client.query<ScopeOutboxQueryRow>(`
    SELECT outbox_id, scope_kind, scope_id, topic, payload, recorded_at
    FROM extension_scope_outbox
    WHERE scope_kind = $1
      AND scope_id = $2
      AND topic = ANY($3)
      AND outbox_id > $4
    ORDER BY outbox_id ASC
    LIMIT ${Math.max(1, Math.trunc(options.limit))}
  `, [options.scopeKind, options.scopeId, options.topics, options.afterOutboxId]);
  return result.rows;
}

/** Mark delivered rows as projected; idempotent and informational only. */
export async function markOutboxProjected(
  client: Pick<pg.PoolClient, 'query'>,
  outboxIds: Array<number | string>,
): Promise<void> {
  if (outboxIds.length === 0) return;
  await client.query(
    `UPDATE extension_scope_outbox
     SET projected_at = COALESCE(projected_at, NOW())
     WHERE outbox_id = ANY($1::bigint[])`,
    [outboxIds.map(id => Number(id))],
  );
}
