import type pg from 'pg'

/**
 * ADR-0003 feed retention.
 *
 * - extension_source_outbox is NEVER deleted by age; only successful
 *   projection removes source rows.
 * - extension_feed rows older than the configured retention are deleted only
 *   when no relevant active installation still needs them (ack below).
 * - Past the hard max, rows may go regardless; installations that were still
 *   behind get snapshot_required_at and their next pull returns
 *   410 cursor_expired with snapshot_required=true.
 * - Purge requests are content-free evidence and are never touched here.
 *
 * Every pass is bounded and uses FOR UPDATE SKIP LOCKED style subselects so
 * no long transaction ever locks the whole feed.
 */
export interface FeedRetentionOptions {
  retentionDays: number
  /** Hard ceiling; defaults to twice the retention window. */
  hardMaxDays?: number
  batchSize?: number
  now?: () => Date
}

export interface FeedRetentionResult {
  deleted: number
  markedInstallations: number
}

const DEFAULT_BATCH = 500

export async function runFeedRetentionOnce(
  pool: Pick<pg.Pool, 'query'>,
  options: FeedRetentionOptions,
): Promise<FeedRetentionResult> {
  const batch = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH))
  const hardMaxDays = options.hardMaxDays ?? options.retentionDays * 2
  const retentionCutoff = interval(options.retentionDays)
  const hardCutoff = interval(hardMaxDays)

  // 1. Soft pass: rows past retention that every relevant active
  //    installation has already consumed (no checkpoint still below the row).
  //    Checkpoints are created lazily on first pull, so an installation
  //    without one still guards its rows through start_feed_id.
  const soft = await pool.query(
    `DELETE FROM extension_feed
     WHERE ctid IN (
       SELECT f.ctid FROM extension_feed f
       WHERE f.created_at < NOW() - ($1 * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM extension_installations i
           LEFT JOIN extension_checkpoints c ON c.installation_id = i.installation_id
           LEFT JOIN sessions s ON s.session_id = f.session_id AND s.user_id = i.owner_user_id
           WHERE i.owner_user_id = f.owner_user_id
             AND i.status IN ('pending', 'active', 'paused')
             AND f.topic = ANY(i.subscriptions)
             AND CASE
               WHEN f.topic IN ('session.deleted.v1', 'session.access.revoked.v1')
                 THEN 'session:deletion:read' = ANY(i.granted_scopes)
               ELSE 'session:events:read' = ANY(i.granted_scopes)
             END
             AND (
               f.source_kind <> 'canonical_event'
               OR (
                 (COALESCE(i.event_filter->'daemon_ids', '[]'::jsonb) = '[]'::jsonb
                   OR COALESCE(i.event_filter->'daemon_ids', '[]'::jsonb) ? s.daemon_id)
                 AND (COALESCE(i.event_filter->'agent_types', '[]'::jsonb) = '[]'::jsonb
                   OR COALESCE(i.event_filter->'agent_types', '[]'::jsonb) ? s.agent_type)
               )
             )
             AND c.snapshot_required_at IS NULL
             AND COALESCE(c.ack_feed_id, i.start_feed_id) < f.feed_id
         )
       ORDER BY f.feed_id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )`,
    [retentionCutoff, batch],
  )

  // 2. Hard pass: rows past the hard ceiling go regardless, but every
  //    lagging installation is marked first so its next pull demands a
  //    snapshot instead of silently seeing a gap. The upsert matters
  //    because checkpoints are created lazily on first pull: a never-pulled
  //    installation has no row to UPDATE, yet must still be marked. The
  //    ORDER BY is a best-effort tuple-lock ordering hint (PostgreSQL does
  //    not contractually preserve SELECT order into the conflict path);
  //    the bounded onRetentionError + 60s retry stays the backstop.
  const marked = await pool.query(
    `INSERT INTO extension_checkpoints (installation_id, snapshot_required_at)
     SELECT DISTINCT i.installation_id, NOW()
     FROM extension_installations i
     LEFT JOIN extension_checkpoints cc ON cc.installation_id = i.installation_id
     JOIN extension_feed f ON f.owner_user_id = i.owner_user_id
     LEFT JOIN sessions s ON s.session_id = f.session_id AND s.user_id = i.owner_user_id
     WHERE i.status IN ('pending', 'active', 'paused')
       AND f.topic = ANY(i.subscriptions)
       AND CASE
         WHEN f.topic IN ('session.deleted.v1', 'session.access.revoked.v1')
           THEN 'session:deletion:read' = ANY(i.granted_scopes)
         ELSE 'session:events:read' = ANY(i.granted_scopes)
       END
       AND (
         f.source_kind <> 'canonical_event'
         OR (
           (COALESCE(i.event_filter->'daemon_ids', '[]'::jsonb) = '[]'::jsonb
             OR COALESCE(i.event_filter->'daemon_ids', '[]'::jsonb) ? s.daemon_id)
           AND (COALESCE(i.event_filter->'agent_types', '[]'::jsonb) = '[]'::jsonb
             OR COALESCE(i.event_filter->'agent_types', '[]'::jsonb) ? s.agent_type)
         )
       )
       AND f.created_at < NOW() - ($1 * INTERVAL '1 day')
       AND COALESCE(cc.ack_feed_id, i.start_feed_id) < f.feed_id
       AND cc.snapshot_required_at IS NULL
     ORDER BY i.installation_id
     ON CONFLICT (installation_id) DO UPDATE SET
       snapshot_required_at = NOW(), updated_at = NOW()
     WHERE extension_checkpoints.snapshot_required_at IS NULL`,
    [hardCutoff],
  )

  const hard = await pool.query(
    `DELETE FROM extension_feed
     WHERE ctid IN (
       SELECT f.ctid FROM extension_feed f
       WHERE f.created_at < NOW() - ($1 * INTERVAL '1 day')
       ORDER BY f.feed_id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )`,
    [hardCutoff, batch],
  )

  return {
    deleted: (soft.rowCount ?? 0) + (hard.rowCount ?? 0),
    markedInstallations: marked.rowCount ?? 0,
  }
}

function interval(days: number): number {
  return Math.max(1, Math.trunc(days))
}

export async function clearSnapshotRequiredFlag(
  pool: Pick<pg.Pool, 'query'>,
  installationId: string,
): Promise<void> {
  await pool.query(
    `UPDATE extension_checkpoints
     SET snapshot_required_at = NULL, updated_at = NOW()
     WHERE installation_id = $1`,
    [installationId],
  )
}
