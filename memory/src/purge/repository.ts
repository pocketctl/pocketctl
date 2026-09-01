import { createHash, createHmac } from 'crypto'
import type pg from 'pg'
import type { TombstoneHmacKey } from '../config.js'
import { insertKnowledgeTombstones } from '../claims/tombstones.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'

type QueryClient = Pick<pg.PoolClient, 'query'>

interface SessionPurgeInput {
  installationId: string
  sessionId: string
  reason: string
  sourceFeedId: string | number | null
}

/**
 * Session tombstones and installation purges. Deletion order is frozen by the
 * plan (section 9): clear bodies and derived content first, record the
 * minimal fence last; installation purges commit a content-free receipt
 * locally BEFORE the Relay ack, and ack retries never restore data.
 */
export function createPurgeRepository(
  pool: pg.Pool,
  options: {
    hmacKey: string
    tombstoneHmacKeys?: readonly TombstoneHmacKey[]
    codeSnapshotRetentionDays?: number
    onInvalidated?: (scope: 'session' | 'installation', count: number) => void
  },
) {
  const tombstoneHmacKeys = options.tombstoneHmacKeys?.length
    ? options.tombstoneHmacKeys
    : [{ version: 'legacy', key: options.hmacKey }]
  const codeSnapshotRetentionDays = options.codeSnapshotRetentionDays ?? 30
  return {
    async purgeRepository(input: {
      installationId: string
      repositoryId: string
      reasonCode: string
    }): Promise<{ purged: boolean }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2, 0))
        `, [input.installationId, input.repositoryId])
        const already = await client.query(`
          SELECT 1 FROM memory_repository_tombstones
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        if (already.rows[0]) {
          await client.query('COMMIT')
          return { purged: false }
        }
        const repository = await client.query(`
          SELECT 1 FROM repositories
          WHERE installation_id = $1 AND repository_id = $2 FOR UPDATE
        `, [input.installationId, input.repositoryId])
        if (!repository.rows[0]) {
          await client.query('COMMIT')
          return { purged: false }
        }
        await client.query(`
          INSERT INTO memory_repository_tombstones
            (installation_id, repository_id, reason_code)
          VALUES ($1, $2, $3)
        `, [input.installationId, input.repositoryId, input.reasonCode])
        await client.query(`
          UPDATE memory_generation_runs gr
          SET state = 'cancelled', error_code = 'repository_purged', completed_at = NOW()
          WHERE gr.installation_id = $1 AND gr.state IN ('queued','running')
            AND EXISTS (
              SELECT 1 FROM memory_wiki_build_runs br
              JOIN memory_wikis w
                ON w.installation_id = br.installation_id AND w.wiki_id = br.wiki_id
              WHERE br.generation_run_id = gr.run_id AND w.repository_id = $2
            )
        `, [input.installationId, input.repositoryId])
        await client.query(`
          UPDATE memory_wiki_build_runs br
          SET state = 'cancelled', error_code = 'repository_purged', completed_at = NOW()
          FROM memory_wikis w
          WHERE br.installation_id = $1 AND w.repository_id = $2
            AND w.installation_id = br.installation_id AND w.wiki_id = br.wiki_id
            AND br.state IN ('queued','running','validating','candidate')
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_jobs j
          WHERE j.installation_id = $1 AND (
            (j.job_type = 'parse_code_snapshot' AND EXISTS (
              SELECT 1 FROM memory_source_snapshots s
              WHERE s.installation_id = $1 AND s.repository_id = $2
                AND s.snapshot_id::text = j.payload->>'snapshot_id'
            )) OR
            (j.job_type = 'build_wiki' AND EXISTS (
              SELECT 1 FROM memory_wiki_build_runs br
              JOIN memory_wikis w
                ON w.installation_id = br.installation_id AND w.wiki_id = br.wiki_id
              WHERE w.repository_id = $2 AND br.run_id::text = j.payload->>'run_id'
            )))
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_wikis WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_source_snapshots
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_source_blobs b
          WHERE b.installation_id = $1 AND NOT EXISTS (
            SELECT 1 FROM memory_source_snapshot_entries e
            WHERE e.installation_id = b.installation_id AND e.blob_hash = b.blob_hash
          )
        `, [input.installationId])
        await client.query(`
          UPDATE repositories SET canonical_remote = NULL, last_observed_at = NOW()
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        await client.query('COMMIT')
        return { purged: true }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async purgeSourceSnapshot(input: {
      installationId: string
      snapshotId: string
      reasonCode: string
    }): Promise<{ purged: boolean }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended('purge:snapshot:' || $1 || ':' || $2, 0))
        `, [input.installationId, input.snapshotId])
        const tombstone = await client.query(`
          SELECT 1 FROM memory_source_snapshot_tombstones
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [input.installationId, input.snapshotId])
        if (tombstone.rows[0]) {
          await client.query('COMMIT')
          return { purged: false }
        }
        const snapshot = await client.query<{
          repository_id: string
          commit_sha: string
        }>(`
          SELECT repository_id::text, commit_sha FROM memory_source_snapshots
          WHERE installation_id = $1 AND snapshot_id = $2 FOR UPDATE
        `, [input.installationId, input.snapshotId])
        const row = snapshot.rows[0]
        if (!row) {
          await client.query('COMMIT')
          return { purged: false }
        }
        await client.query(`
          INSERT INTO memory_source_snapshot_tombstones
            (installation_id, snapshot_id, repository_id, commit_sha, reason_code)
          VALUES ($1, $2, $3, $4, $5)
        `, [input.installationId, input.snapshotId, row.repository_id,
          row.commit_sha, input.reasonCode])
        await client.query(`
          UPDATE memory_generation_runs gr
          SET state = 'cancelled', error_code = 'snapshot_purged', completed_at = NOW()
          WHERE gr.installation_id = $1 AND gr.state IN ('queued','running')
            AND EXISTS (
              SELECT 1 FROM memory_wiki_build_runs br
              WHERE br.generation_run_id = gr.run_id AND br.source_snapshot_id = $2
            )
        `, [input.installationId, input.snapshotId])
        await client.query(`
          DELETE FROM memory_jobs
          WHERE installation_id = $1 AND (
            payload->>'snapshot_id' = $2::text OR payload->>'run_id' IN (
              SELECT run_id::text FROM memory_wiki_build_runs
              WHERE installation_id = $1 AND source_snapshot_id = $2::uuid
            ))
        `, [input.installationId, input.snapshotId])
        await client.query(`
          DELETE FROM memory_source_snapshots
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [input.installationId, input.snapshotId])
        await client.query(`
          DELETE FROM memory_source_blobs b
          WHERE b.installation_id = $1 AND NOT EXISTS (
            SELECT 1 FROM memory_source_snapshot_entries e
            WHERE e.installation_id = b.installation_id AND e.blob_hash = b.blob_hash
          )
        `, [input.installationId])
        await client.query('COMMIT')
        return { purged: true }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async cleanupSupersededSnapshots(input: {
      limit: number
      now?: Date
    }): Promise<{ snapshots: number; blobs: number }> {
      const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)))
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const deleted = await client.query<{ snapshot_id: string }>(`
          WITH eligible AS (
            SELECT s.snapshot_id
            FROM memory_source_snapshots s
            WHERE s.state = 'superseded'
              AND s.created_at < COALESCE($1::timestamptz, NOW()) - ($3 * INTERVAL '1 day')
              AND NOT EXISTS (
                SELECT 1 FROM memory_code_graph_versions g
                WHERE g.installation_id = s.installation_id AND g.snapshot_id = s.snapshot_id
                  AND g.state IN ('candidate','active')
              )
              AND NOT EXISTS (
                SELECT 1 FROM memory_wiki_versions v
                WHERE v.installation_id = s.installation_id
                  AND v.source_snapshot_id = s.snapshot_id AND v.state <> 'purged'
              )
              AND NOT EXISTS (
                SELECT 1 FROM memory_wiki_build_runs r
                WHERE r.installation_id = s.installation_id
                  AND r.source_snapshot_id = s.snapshot_id
                  AND r.state IN ('queued','running','validating','candidate','published')
              )
            ORDER BY s.created_at, s.snapshot_id
            FOR UPDATE OF s SKIP LOCKED
            LIMIT $2
          )
          DELETE FROM memory_source_snapshots s USING eligible e
          WHERE s.snapshot_id = e.snapshot_id
          RETURNING s.snapshot_id::text
        `, [input.now ?? null, limit, codeSnapshotRetentionDays])
        const orphaned = await client.query(`
          DELETE FROM memory_source_blobs b
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_source_snapshot_entries e
            WHERE e.installation_id = b.installation_id AND e.blob_hash = b.blob_hash
          )
        `)
        await client.query('COMMIT')
        return { snapshots: deleted.rowCount ?? 0, blobs: orphaned.rowCount ?? 0 }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async purgeSession(input: SessionPurgeInput, transactionClient?: QueryClient): Promise<number> {
      if (transactionClient) {
        // The caller owns the transaction and must publish metrics only after
        // its outer COMMIT succeeds.
        return purgeSessionRows(transactionClient, input, tombstoneHmacKeys)
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const count = await purgeSessionRows(client, input, tombstoneHmacKeys)
          await client.query('COMMIT')
          options.onInvalidated?.('session', count)
          return count
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    /**
     * Purge one installation inside a single transaction: delete every
     * scoped row, keep the installation row as a `purged` fence (discovery
     * can never resurrect it), and write the receipt. Returns the receipt.
     */
    async purgeInstallation(input: {
      installationId: string
      requestId: string
      reason: string
    }, transactionClient?: QueryClient): Promise<string> {
      if (transactionClient) {
        const result = await purgeInstallationRows(transactionClient, input, options.hmacKey)
        // No callback here: the owner has not committed its outer transaction.
        return result.receipt
      }
      const existing = await pool.query<{ receipt: string }>(
        `SELECT receipt FROM memory_purge_receipts WHERE request_id = $1`,
        [input.requestId],
      )
      if (existing.rows[0]) return existing.rows[0].receipt

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const result = await purgeInstallationRows(client, input, options.hmacKey)
          await client.query('COMMIT')
          options.onInvalidated?.('installation', result.invalidatedClaims)
          return result.receipt
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async markPurgeAcked(requestId: string): Promise<void> {
      await pool.query(
        `UPDATE memory_purge_receipts SET relay_acked_at = NOW() WHERE request_id = $1`,
        [requestId],
      )
    },

    async receiptFor(requestId: string): Promise<string | null> {
      const result = await pool.query<{ receipt: string }>(
        `SELECT receipt FROM memory_purge_receipts WHERE request_id = $1`,
        [requestId],
      )
      return result.rows[0]?.receipt ?? null
    },
  }
}

async function purgeSessionRows(
  client: QueryClient,
  input: SessionPurgeInput,
  tombstoneHmacKeys: readonly TombstoneHmacKey[],
): Promise<number> {
  // Serialize against episode compilation on this session: a compile that
  // wins the lock lands before the deletes (and is removed by them); one
  // that loses waits for this commit and observes the tombstone fence.
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0))
  `, [input.installationId, input.sessionId])
  await client.query(`
    INSERT INTO memory_session_tombstones
      (installation_id, session_id, reason, source_feed_id, purged_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (installation_id, session_id) DO NOTHING
  `, [input.installationId, input.sessionId, input.reason, input.sourceFeedId])

  // Phase 2 purge order: stop session-scoped context generation and remove
  // every pack whose turn or Evidence source belongs to the purged Session
  // before deleting the Evidence/Version joins that make that dependency
  // discoverable. This applies to delivered history too: privacy deletion
  // wins over audit-content retention.
  await client.query(`
    UPDATE memory_generation_runs
    SET state = 'cancelled', error_code = 'source_purged', completed_at = NOW()
    WHERE installation_id = $1 AND operation = 'compile_context'
      AND subject_kind = 'session'
      AND subject_key_hash = decode(md5($2), 'hex')
      AND state IN ('queued','running')
  `, [input.installationId, input.sessionId])
  await client.query(`
    DELETE FROM memory_context_packs p
    WHERE p.installation_id = $1
      AND (p.session_id = $2 OR EXISTS (
        SELECT 1
        FROM memory_context_pack_evidence pe
        JOIN knowledge_evidence e
          ON e.installation_id = pe.installation_id AND e.evidence_id = pe.evidence_id
        JOIN work_episodes w
          ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
        WHERE pe.pack_id = p.pack_id AND w.session_id = $2))
  `, [input.installationId, input.sessionId])

  // Remove only immutable Versions whose complete evidence set belongs to
  // this session. A Version with evidence from another session survives; the
  // episode delete below removes only the purged evidence rows. If the
  // current Version is deleted, retain the newest independently evidenced
  // Version; delete the Claim only when no such Version remains.
  const impacted = await client.query<{
    claim_id: string
    claim_type: string
    scope_key: string
  }>(`
      SELECT DISTINCT c.claim_id::text, c.claim_type, c.scope_key
      FROM knowledge_claims c
      JOIN knowledge_versions v
        ON v.installation_id = c.installation_id AND v.claim_id = c.claim_id
      JOIN knowledge_evidence e
        ON e.installation_id = v.installation_id AND e.version_id = v.version_id
      JOIN work_episodes w
        ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
      WHERE c.installation_id = $1 AND w.session_id = $2
  `, [input.installationId, input.sessionId])
  for (const claim of impacted.rows) {
    const locked = await client.query<{ current_version_id: string | null }>(`
      SELECT current_version_id::text FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = $2 FOR UPDATE
    `, [input.installationId, claim.claim_id])
    const currentVersionId = locked.rows[0]?.current_version_id ?? null
    const dependent = await client.query<{
      version_id: string; statement: string; valid_from: Date | null; valid_until: Date | null
    }>(`
      SELECT v.version_id::text, v.statement, v.valid_from, v.valid_until
      FROM knowledge_versions v
      WHERE v.installation_id = $1 AND v.claim_id = $2
        AND EXISTS (
          SELECT 1 FROM knowledge_evidence e
          JOIN work_episodes w
            ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
          WHERE e.installation_id = v.installation_id AND e.version_id = v.version_id
            AND w.session_id = $3
        )
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_evidence e
          JOIN work_episodes w
            ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
          WHERE e.installation_id = v.installation_id AND e.version_id = v.version_id
            AND w.session_id <> $3
        )
    `, [input.installationId, claim.claim_id, input.sessionId])
    const versionIds = dependent.rows.map(row => row.version_id)
    if (versionIds.length === 0) {
      await client.query(`
        UPDATE knowledge_claims SET revision = revision + 1, updated_at = NOW()
        WHERE installation_id = $1 AND claim_id = $2
      `, [input.installationId, claim.claim_id])
      continue
    }
    await insertKnowledgeTombstones(client, {
      installationId: input.installationId,
      normalizedKeys: dependent.rows.map(row => normalizedClaimKey({
        claimType: claim.claim_type,
        scopeKey: claim.scope_key,
        statement: row.statement,
      })),
      reason: 'source_purge',
      keys: tombstoneHmacKeys,
    })
    const replacement = await client.query<{
      version_id: string; statement: string; valid_until: Date | null
    }>(`
      SELECT v.version_id::text, v.statement, v.valid_until
      FROM knowledge_versions v
      WHERE v.installation_id = $1 AND v.claim_id = $2
        AND NOT (v.version_id = ANY($3::uuid[]))
        AND EXISTS (
          SELECT 1 FROM knowledge_evidence e
          JOIN work_episodes w
            ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
          WHERE e.installation_id = v.installation_id AND e.version_id = v.version_id
            AND w.session_id <> $4
        )
      ORDER BY v.version_number DESC
      LIMIT 1
    `, [input.installationId, claim.claim_id, versionIds, input.sessionId])
    if (currentVersionId && versionIds.includes(currentVersionId)) {
      if (replacement.rows[0]) {
        const removedCurrent = dependent.rows.find(row => row.version_id === currentVersionId)
        const correctionBoundaryClosedReplacement = Boolean(
          replacement.rows[0].valid_until
          && removedCurrent?.valid_from
          && replacement.rows[0].valid_until.getTime() === removedCurrent.valid_from.getTime(),
        )
        await repointClaimAfterPurge(client, {
          installationId: input.installationId,
          claimId: claim.claim_id,
          claimType: claim.claim_type,
          scopeKey: claim.scope_key,
          versionId: replacement.rows[0].version_id,
          statement: replacement.rows[0].statement,
          reopenValidity: correctionBoundaryClosedReplacement,
          reindex: true,
        })
      } else {
        await client.query(`
          DELETE FROM knowledge_claims WHERE installation_id = $1 AND claim_id = $2
        `, [input.installationId, claim.claim_id])
        continue
      }
    } else {
      const current = currentVersionId
        ? await client.query<{ statement: string }>(`
            SELECT statement FROM knowledge_versions
            WHERE installation_id = $1 AND version_id = $2
          `, [input.installationId, currentVersionId])
        : { rows: [] as { statement: string }[] }
      if (currentVersionId && current.rows[0]) {
        await repointClaimAfterPurge(client, {
          installationId: input.installationId,
          claimId: claim.claim_id,
          claimType: claim.claim_type,
          scopeKey: claim.scope_key,
          versionId: currentVersionId,
          statement: current.rows[0].statement,
          reopenValidity: false,
          reindex: false,
        })
      } else {
        await client.query(`
          UPDATE knowledge_claims SET revision = revision + 1, updated_at = NOW()
          WHERE installation_id = $1 AND claim_id = $2
        `, [input.installationId, claim.claim_id])
      }
    }
    await client.query(`
      DELETE FROM knowledge_versions
      WHERE installation_id = $1 AND claim_id = $2 AND version_id = ANY($3::uuid[])
    `, [input.installationId, claim.claim_id, versionIds])
  }
  await client.query(`
    DELETE FROM memory_candidates WHERE installation_id = $1 AND episode_id IN (
      SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND session_id = $2
    )
  `, [input.installationId, input.sessionId])
  await client.query(`
    DELETE FROM memory_extraction_runs WHERE installation_id = $1 AND episode_id IN (
      SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND session_id = $2
    )
  `, [input.installationId, input.sessionId])

  for (const table of [
    'work_episodes', 'source_artifacts', 'source_turns', 'source_events',
    'memory_snapshot_events',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE installation_id = $1 AND session_id = $2`,
      [input.installationId, input.sessionId],
    )
  }
  await client.query(
    `DELETE FROM memory_feed_inbox WHERE installation_id = $1 AND session_id = $2`,
    [input.installationId, input.sessionId],
  )
  await client.query(`
    UPDATE source_sessions SET
      agent_type = NULL, daemon_id = NULL, status = NULL, cwd_observation = NULL,
      worktree_path = NULL, worktree_branch = NULL, deleted_at = NOW(),
      delete_reason = $3
    WHERE installation_id = $1 AND session_id = $2
  `, [input.installationId, input.sessionId, input.reason])
  await client.query(`
    UPDATE memory_feed_inbox SET projection_state = 'projected', projected_at = NOW()
    WHERE installation_id = $1 AND feed_id = $2
  `, [input.installationId, input.sourceFeedId ?? 0])
  return impacted.rows.length
}

async function repointClaimAfterPurge(
  client: QueryClient,
  input: {
    installationId: string
    claimId: string
    claimType: string
    scopeKey: string
    versionId: string
    statement: string
    reopenValidity: boolean
    reindex: boolean
  },
): Promise<void> {
  const normalizedKey = normalizedClaimKey({
    claimType: input.claimType,
    scopeKey: input.scopeKey,
    statement: input.statement,
  })
  // A surviving historical Version becomes current again after the purged
  // Version disappears, so reopen its applicability window atomically with
  // the pointer move.
  if (input.reopenValidity) {
    await client.query(`
      UPDATE knowledge_versions SET valid_until = NULL
      WHERE installation_id = $1 AND version_id = $2
    `, [input.installationId, input.versionId])
  }
  const collision = await client.query<{ claim_id: string }>(`
    SELECT claim_id::text FROM knowledge_claims
    WHERE installation_id = $1 AND claim_type = $2 AND scope_key = $3
      AND normalized_key = $4 AND claim_id <> $5
    LIMIT 1
  `, [input.installationId, input.claimType, input.scopeKey, normalizedKey, input.claimId])
  if (collision.rows[0]) {
    const placeholder = `purged-rekey:${createHash('sha256').update(normalizedKey).digest('hex')}`
    await client.query(`
      UPDATE knowledge_claims
      SET current_version_id = $3, normalized_key = $4, state = 'superseded',
          superseded_by_claim_id = $5, revision = revision + 1, updated_at = NOW()
      WHERE installation_id = $1 AND claim_id = $2
    `, [input.installationId, input.claimId, input.versionId, placeholder, collision.rows[0].claim_id])
    return
  }
  await client.query(`
    UPDATE knowledge_claims
    SET current_version_id = $3, normalized_key = $4,
        revision = revision + 1, updated_at = NOW()
    WHERE installation_id = $1 AND claim_id = $2
  `, [input.installationId, input.claimId, input.versionId, normalizedKey])
  if (input.reindex) {
    await client.query(`
      INSERT INTO memory_jobs
        (job_id, installation_id, job_type, idempotency_key, priority, payload)
      VALUES (gen_random_uuid(), $1, 'index_claim_version', $2, 90, $3::jsonb)
      ON CONFLICT DO NOTHING
    `, [input.installationId, `purge-reindex:${input.claimId}:${input.versionId}`,
      JSON.stringify({ version_id: input.versionId })])
  }
}

async function purgeInstallationRows(
  client: QueryClient,
  input: { installationId: string; requestId: string; reason: string },
  hmacKey: string,
): Promise<{ receipt: string; invalidatedClaims: number }> {
  // Serialize against episode compilation anywhere in this installation
  // (see purgeSessionRows). Taken before any delete so a compile either
  // commits first and is deleted, or observes the purge's terminal state.
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
  `, [input.installationId])
  // Phase 4 authoritative/derived content is removed before the generic
  // repository row and before the content-free installation receipt.
  for (const table of [
    'memory_wikis',
    'memory_source_snapshots',
    'memory_repository_tombstones',
    'memory_source_snapshot_tombstones',
    'memory_source_blobs',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE installation_id = $1`,
      [input.installationId],
    )
  }
  const invalidated = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count FROM knowledge_claims WHERE installation_id = $1
  `, [input.installationId])
  for (const table of [
    'memory_session_tombstones', 'memory_dead_letters', 'memory_jobs', 'memory_usage_outbox',
    'memory_snapshot_runs', 'memory_snapshot_events', 'memory_feed_inbox',
    'knowledge_tombstones', 'memory_idempotency_keys', 'memory_feedback',
    'claim_search_documents', 'knowledge_evidence', 'memory_candidates',
    'memory_extraction_runs', 'knowledge_versions', 'knowledge_claims',
    'memory_feature_settings',
    'work_episodes', 'source_artifacts', 'source_turns', 'source_events',
    'repo_snapshots', 'repositories', 'source_sessions',
    'memory_context_feedback', 'memory_context_injections',
    'memory_context_pack_evidence', 'memory_context_pack_items',
    'memory_context_packs', 'memory_retrieval_candidates',
    'memory_retrieval_trajectories',
    'memory_generation_runs',
    'memory_context_loadout_items', 'memory_context_loadouts',
    'memory_context_settings', 'memory_policy_sets',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE installation_id = $1`,
      [input.installationId],
    )
  }
  await client.query(`
    UPDATE memory_installations
    SET local_status = 'purged', poll_owner = NULL, poll_expires_at = NULL,
        last_error_code = NULL, updated_at = NOW()
    WHERE installation_id = $1
  `, [input.installationId])
  const committedAt = new Date()
  const receipt = buildReceipt({
    hmacKey,
    requestId: input.requestId,
    installationId: input.installationId,
    reason: input.reason,
    committedAt,
  })
  const stored = await client.query<{ receipt: string }>(`
    INSERT INTO memory_purge_receipts
      (request_id, installation_id, reason, receipt, local_committed_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (request_id) DO NOTHING
    RETURNING receipt
  `, [input.requestId, input.installationId, input.reason, receipt, committedAt])
  // An existing receipt wins: always return what is actually stored so a
  // Relay ack never references a receipt that was minted but discarded.
  if (stored.rows[0]) return { receipt: stored.rows[0].receipt, invalidatedClaims: Number(invalidated.rows[0]?.count ?? 0) }
  const existing = await client.query<{ receipt: string }>(`
    SELECT receipt FROM memory_purge_receipts WHERE request_id = $1
  `, [input.requestId])
  return { receipt: existing.rows[0]?.receipt ?? receipt, invalidatedClaims: Number(invalidated.rows[0]?.count ?? 0) }
}

function buildReceipt(input: {
  hmacKey: string
  requestId: string
  installationId: string
  reason: string
  committedAt: Date
}): string {
  const digest = createHmac('sha256', input.hmacKey)
    .update(`${input.installationId}|${input.reason}|${input.committedAt.toISOString()}`)
    .digest('hex')
  return `memory-phase0:${input.requestId}:${digest}`
}

export type PurgeRepository = ReturnType<typeof createPurgeRepository>
