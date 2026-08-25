import type pg from 'pg'
import type { JobClaim } from '../jobs/types.js'
import { buildSearchDocument } from './lexical.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import { normalize } from './postgres-vector-index.js'

/**
 * Claim index projection (Task 8). Builds the lexical document for the
 * current Version of active claims, embeds it only when the installation's
 * embedding mode is shadow/enabled and the adapter is configured, deletes
 * documents for inactive claims, and never mutates the ledger. Model changes
 * enqueue a bounded rebuild instead of mixing ranks across models.
 */

export type EmbeddingMode = 'off' | 'shadow' | 'enabled'

export interface IndexerDeps {
  pool: pg.Pool
  /** Adapter plus its identity fields; ranks never mix across models. */
  embed?: EmbeddingProvider & { provider: string; model: string }
  embeddingConsentFingerprint?: string
}

interface VersionRow {
  version_id: string
  claim_id: string
  version_number: number
  statement: string
  structured_content: Record<string, unknown>
  repository_id: string | null
  repository_key: string | null
  branch: string | null
  claim_state: string
  current_version_id: string | null
}

export function createClaimIndexer(deps: IndexerDeps) {
  return {
    async handleIndexClaimVersion(job: JobClaim, signal: AbortSignal): Promise<void> {
      if (!job.installation_id) return
      const versionId = typeof job.payload.version_id === 'string' ? job.payload.version_id : ''
      if (!versionId) return
      await this.indexVersion(job.installation_id, versionId, signal)
    },

    async indexVersion(installationId: string, versionId: string, signal: AbortSignal): Promise<void> {
      const found = await deps.pool.query<VersionRow>(`
        SELECT v.version_id::text, v.claim_id::text, v.version_number, v.statement,
               v.structured_content, v.repository_id::text, r.repository_key,
               v.branch, c.state AS claim_state, c.current_version_id::text
        FROM knowledge_versions v
        JOIN knowledge_claims c
          ON c.installation_id = v.installation_id AND c.claim_id = v.claim_id
        LEFT JOIN repositories r
          ON r.installation_id = v.installation_id AND r.repository_id = v.repository_id
        WHERE v.installation_id = $1 AND v.version_id = $2
      `, [installationId, versionId])
      const row = found.rows[0]
      if (!row) return

      // Deleted/revoked/expired/superseded claims hold no projection.
      if (row.claim_state !== 'active') {
        await deps.pool.query(`
          DELETE FROM claim_search_documents
          WHERE installation_id = $1 AND version_id = ANY (
            SELECT version_id FROM knowledge_versions
            WHERE installation_id = $1 AND claim_id = $2
          )
        `, [installationId, row.claim_id])
        return
      }

      // A late job for an old immutable Version may race a correction. Delete
      // only that stale projection; never remove the new current document.
      if (row.current_version_id !== versionId) {
        await deps.pool.query(`
          DELETE FROM claim_search_documents
          WHERE installation_id = $1 AND version_id = $2
        `, [installationId, versionId])
        return
      }

      const document = buildSearchDocument({
        claimType: (await deps.pool.query<{ claim_type: string }>(
          `SELECT claim_type FROM knowledge_claims WHERE installation_id = $1 AND claim_id = $2`,
          [installationId, row.claim_id],
        )).rows[0]?.claim_type ?? '',
        statement: row.statement,
        structuredContent: row.structured_content ?? {},
        repositoryKey: row.repository_key,
        branch: row.branch,
      })

      await deps.pool.query(`
        DELETE FROM claim_search_documents
        WHERE installation_id = $1
          AND version_id IN (
            SELECT version_id FROM knowledge_versions
            WHERE installation_id = $1 AND claim_id = $2 AND version_id <> $3
          )
      `, [installationId, row.claim_id, versionId])
      await deps.pool.query(`
        INSERT INTO claim_search_documents
          (installation_id, version_id, document, embedding_status)
        VALUES ($1, $2, $3, 'disabled')
        ON CONFLICT (installation_id, version_id) DO UPDATE SET
          document = EXCLUDED.document,
          indexed_at = NOW()
      `, [installationId, versionId, document])

      const mode = await embeddingModeFor(
        deps.pool,
        installationId,
        deps.embeddingConsentFingerprint,
      )
      if (mode === 'off' || !deps.embed) {
        await deps.pool.query(`
          UPDATE claim_search_documents SET embedding_status = 'disabled', embedding = NULL
          WHERE installation_id = $1 AND version_id = $2
        `, [installationId, versionId])
        return
      }

      try {
        const embedded = await deps.embed.embed({
          operation: 'claim_index',
          texts: [document],
          signal,
        })
        if (embedded.vectors.length !== 1) throw new Error('embedding count mismatch')
        const vector = normalize(embedded.vectors[0])
        if (vector.length !== (deps.embed?.dimensions ?? 0)) throw new Error('embedding dimension mismatch')
        await deps.pool.query(`
          WITH updated AS (
          UPDATE claim_search_documents SET
            embedding = $3::real[],
            embedding_provider = $4,
            embedding_model = $5,
            embedding_dimensions = $6,
            embedding_fingerprint = $7,
            embedding_status = 'ready'
          WHERE installation_id = $1 AND version_id = $2
          RETURNING 1
          )
          INSERT INTO memory_usage_outbox
            (installation_id, usage_id, operation, model, input_tokens, output_tokens,
             embedding_tokens, cached_tokens, cost_micros, occurred_at)
          SELECT $1, 'embedding:index:' || gen_random_uuid()::text, 'embedding', $8,
                 0, 0, $9, 0, $10, NOW()
          FROM updated
        `, [installationId, versionId, vector, deps.embed!.provider,
            deps.embed!.model, (deps.embed?.dimensions ?? 0),
            deps.embeddingConsentFingerprint ?? null, deps.embed!.model,
            embedded.tokens, embedded.costMicros ?? 0])
      } catch {
        // Bounded retry via the job ladder; lexical stays searchable.
        await deps.pool.query(`
          UPDATE claim_search_documents SET embedding_status = 'failed'
          WHERE installation_id = $1 AND version_id = $2
        `, [installationId, versionId])
        throw new Error('claim_embedding_failed')
      }
    },

    /** Rebuild: re-enqueue index jobs for every active current Version. */
    async handleRebuildClaimIndex(job: JobClaim): Promise<void> {
      if (!job.installation_id) return
      const adapterFingerprint = typeof job.payload.adapter_fingerprint === 'string'
        ? job.payload.adapter_fingerprint
        : 'default'
      await deps.pool.query(`
        INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
        SELECT gen_random_uuid(), c.installation_id, 'index_claim_version',
               'index:' || c.current_version_id::text || ':' || $2::text, 90,
               jsonb_build_object('version_id', c.current_version_id::text,
                                  'adapter_fingerprint', $2::text)
        FROM knowledge_claims c
        WHERE c.installation_id = $1 AND c.state = 'active' AND c.current_version_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_jobs pending
            WHERE pending.installation_id = c.installation_id
              AND pending.job_type = 'index_claim_version'
              AND pending.state IN ('pending', 'running')
              AND pending.payload->>'version_id' = c.current_version_id::text
          )
        ON CONFLICT DO NOTHING
      `, [job.installation_id, adapterFingerprint])
    },

    /** On adapter change enqueue one bounded rebuild; never mix adapter ranks. */
    async enqueueRebuildIfModelChanged(
      installationId: string,
      configured: { provider: string; model: string; dimensions: number; fingerprint: string },
    ): Promise<boolean> {
      const mismatch = await deps.pool.query(`
        SELECT 1 FROM claim_search_documents
        WHERE installation_id = $1
          AND embedding_status = 'ready'
          AND (embedding_provider IS DISTINCT FROM $2
            OR embedding_model IS DISTINCT FROM $3
            OR embedding_dimensions IS DISTINCT FROM $4
            OR embedding_fingerprint IS DISTINCT FROM $5)
        LIMIT 1
      `, [installationId, configured.provider, configured.model, configured.dimensions,
          configured.fingerprint])
      if (!mismatch.rows[0]) return false
      await deps.pool.query(`
        INSERT INTO memory_jobs (job_id, installation_id, job_type, idempotency_key, priority, payload)
        VALUES (gen_random_uuid(), $1, 'rebuild_claim_index', $2, 95,
                jsonb_build_object('model', $3::text, 'adapter_fingerprint', $4::text))
        ON CONFLICT DO NOTHING
      `, [installationId, `rebuild:${configured.fingerprint}`, configured.model, configured.fingerprint])
      return true
    },
  }
}

async function embeddingModeFor(
  pool: Pick<pg.Pool, 'query'>,
  installationId: string,
  requiredConsentFingerprint?: string,
): Promise<EmbeddingMode> {
  const result = await pool.query<{
    embedding_mode: string | null
    embedding_consent_fingerprint: string | null
  }>(`
    SELECT embedding_mode, embedding_consent_fingerprint
    FROM memory_feature_settings WHERE installation_id = $1
  `, [installationId])
  const mode = result.rows[0]?.embedding_mode
  if (requiredConsentFingerprint
    && result.rows[0]?.embedding_consent_fingerprint !== requiredConsentFingerprint) return 'off'
  return mode === 'shadow' || mode === 'enabled' ? mode : 'off'
}

export type ClaimIndexer = ReturnType<typeof createClaimIndexer>
