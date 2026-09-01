import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import type pg from 'pg'

import {
  CODE_SNAPSHOT_MAX_FILE_BYTES,
  CODE_SNAPSHOT_MAX_FILES,
  CODE_SNAPSHOT_MAX_TOTAL_BYTES,
  PHASE4_PARSER_MATRIX_VERSION,
  languageCapabilityFor,
  normalizeSourcePath,
} from './types.js'

/**
 * Phase 4 content-addressed snapshot repository (ADR-0006 §2): strict wire
 * schemas, the cross-language canonical manifest hash, and the SQL ledger
 * for repositories, snapshots, blobs, and entries. Every query carries
 * installation_id; cross-installation references are impossible.
 */

export const BlobHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const CommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

export const StartCodeSnapshotRequestSchema = z.object({
  repository: z.object({
    repository_key: z.string().min(1).max(512),
    canonical_remote: z.string().min(1).max(1024).optional(),
  }).strict(),
  git_object_format: z.enum(['sha1', 'sha256']),
  commit_sha: CommitShaSchema,
  manifest_sha256: BlobHashSchema,
  expected_file_count: z.number().int().min(1).max(CODE_SNAPSHOT_MAX_FILES),
  expected_byte_count: z.number().int().min(1).max(CODE_SNAPSHOT_MAX_TOTAL_BYTES),
  parser_matrix_version: z.literal(PHASE4_PARSER_MATRIX_VERSION),
  idempotency_key: z.string().min(1).max(256),
}).strict()

export const CodeSnapshotBatchSchema = z.object({
  batch_index: z.number().int().min(0).max(999_999),
  entries: z.array(z.object({
    path: z.string().refine(path => normalizeSourcePath(path) !== null),
    git_mode: z.enum(['100644', '100755']),
    language: z.string().min(1).max(64),
    capability: z.enum(['symbols_and_edges', 'file_only']),
    blob_sha256: BlobHashSchema,
    byte_count: z.number().int().min(1).max(CODE_SNAPSHOT_MAX_FILE_BYTES),
    content_base64: z.string().min(1),
  })).min(1).max(512),
}).strict()

export const FinalizeCodeSnapshotRequestSchema = z.object({
  manifest_sha256: BlobHashSchema,
  expected_file_count: z.number().int().min(1).max(CODE_SNAPSHOT_MAX_FILES),
  expected_byte_count: z.number().int().min(1).max(CODE_SNAPSHOT_MAX_TOTAL_BYTES),
  idempotency_key: z.string().min(1).max(256),
}).strict()

export type StartCodeSnapshotRequest = z.infer<typeof StartCodeSnapshotRequestSchema>
export type CodeSnapshotBatch = z.infer<typeof CodeSnapshotBatchSchema>
export type FinalizeCodeSnapshotRequest = z.infer<typeof FinalizeCodeSnapshotRequestSchema>

/** Manifest rows sorted by path with deterministic field order. */
export interface ManifestEntry {
  path: string
  gitMode: string
  language: string
  capability: string
  blobSha256: string
  byteCount: number
}

/**
 * The canonical manifest hash both the Go collector and Memory compute:
 * one tab-separated line per sorted entry, SHA-256 over the joined bytes.
 * Changing this format breaks cross-language integrity and is forbidden.
 */
export function computeManifestHash(entries: readonly ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hasher = createHash('sha256')
  for (const entry of sorted) {
    hasher.update(`${entry.path}\t${entry.gitMode}\t${entry.language}\t${entry.capability}\t${entry.blobSha256}\t${entry.byteCount}\n`)
  }
  return hasher.digest('hex')
}

export interface SourceSnapshotRecord {
  snapshotId: string
  repositoryId: string
  commitSha: string
  manifestHash: string
  state: string
  generation: number
  fileCount: number
  byteCount: number
}

type Queryable = pg.Pool | pg.PoolClient

export class SourceRepositoryTombstonedError extends Error {
  constructor(readonly code: 'repository_tombstoned' | 'snapshot_tombstoned') {
    super(code)
  }
}

export function createSourceRepository(pool: pg.Pool) {
  return {
    /** Resolve or create the installation-scoped repositories row. */
    async resolveRepository(input: {
      installationId: string
      repositoryKey: string
      canonicalRemote?: string
    }, client?: Queryable): Promise<string> {
      const query = client ?? pool
      const result = await query.query<{ repository_id: string }>(`
        INSERT INTO repositories
          (repository_id, installation_id, repository_key, canonical_remote,
           first_observed_at, last_observed_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (installation_id, repository_key) DO UPDATE
          SET last_observed_at = NOW(),
              canonical_remote = COALESCE(EXCLUDED.canonical_remote, repositories.canonical_remote)
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_repository_tombstones t
          WHERE t.installation_id = repositories.installation_id
            AND t.repository_id = repositories.repository_id
        )
        RETURNING repository_id::text
      `, [
        randomUUID(),
        input.installationId,
        input.repositoryKey,
        input.canonicalRemote ?? null,
      ])
      if (result.rows[0]) return result.rows[0].repository_id
      throw new SourceRepositoryTombstonedError('repository_tombstoned')
    },

    /** Insert the staging snapshot; the unique manifest tuple is idempotent. */
    async insertSnapshot(input: {
      installationId: string
      repositoryId: string
      commitSha: string
      gitObjectFormat: string
      manifestHash: string
      expectedFileCount: number
      expectedByteCount: number
    }, client?: Queryable): Promise<SourceSnapshotRecord> {
      const query = client ?? pool
      const result = await query.query<SourceSnapshotRow>(`
        INSERT INTO memory_source_snapshots
          (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
           manifest_hash, state, generation, parser_matrix_version, file_count, byte_count)
        SELECT $1, $2, $3, $4, $5, $6, 'staging', 0, $7, $8, $9
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_repository_tombstones rt
          WHERE rt.installation_id = $2 AND rt.repository_id = $3
        ) AND NOT EXISTS (
          SELECT 1 FROM memory_source_snapshot_tombstones st
          WHERE st.installation_id = $2 AND st.repository_id = $3 AND st.commit_sha = $4
        )
        ON CONFLICT (installation_id, repository_id, commit_sha, manifest_hash)
          DO UPDATE SET created_at = memory_source_snapshots.created_at
        RETURNING snapshot_id::text, repository_id::text, commit_sha, manifest_hash,
                  state, generation, file_count, byte_count
      `, [
        randomUUID(),
        input.installationId,
        input.repositoryId,
        input.commitSha,
        input.gitObjectFormat,
        input.manifestHash,
        PHASE4_PARSER_MATRIX_VERSION,
        input.expectedFileCount,
        input.expectedByteCount,
      ])
      if (result.rows[0]) return toSnapshotRecord(result.rows[0])
      throw new SourceRepositoryTombstonedError('snapshot_tombstoned')
    },

    async getSnapshot(input: {
      installationId: string
      snapshotId: string
    }, client?: Queryable): Promise<SourceSnapshotRecord | null> {
      const query = client ?? pool
      const result = await query.query<SourceSnapshotRow>(`
        SELECT snapshot_id::text, repository_id::text, commit_sha, manifest_hash,
               state, generation, file_count, byte_count
        FROM memory_source_snapshots
        WHERE installation_id = $1 AND snapshot_id = $2
      `, [input.installationId, input.snapshotId])
      return result.rows[0] ? toSnapshotRecord(result.rows[0]) : null
    },

    /** Store one blob inside the installation; identical bytes are a no-op. */
    async insertBlob(input: {
      installationId: string
      blobHash: string
      byteCount: number
      content: string
    }, client?: Queryable): Promise<void> {
      const query = client ?? pool
      await query.query(`
        INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (installation_id, blob_hash) DO NOTHING
      `, [input.installationId, input.blobHash, input.byteCount, input.content])
    },

    /** Insert one entry; a differing re-insert is an integrity conflict. */
    async insertEntry(input: {
      installationId: string
      snapshotId: string
      path: string
      blobHash: string
      language: string
      capability: string
      byteCount: number
      mode: string
    }, client?: Queryable): Promise<'inserted' | 'replayed' | 'conflict'> {
      const query = client ?? pool
      const result = await query.query<{ inserted: number }>(`
        INSERT INTO memory_source_snapshot_entries
          (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (snapshot_id, path) DO NOTHING
        RETURNING 1 AS inserted
      `, [
        input.snapshotId,
        input.installationId,
        input.path,
        input.blobHash,
        input.language,
        input.capability,
        input.byteCount,
        input.mode,
      ])
      if ((result.rowCount ?? 0) === 1) return 'inserted'
      // A conflicting path is replay-safe only when every immutable field
      // matches the row already committed by this snapshot.
      const existing = await query.query<{
        blob_hash: string
        byte_count: string | number
        mode: string
        language: string
        capability: string
      }>(`
        SELECT blob_hash, byte_count, mode, language, capability
        FROM memory_source_snapshot_entries
        WHERE snapshot_id = $1 AND path = $2
      `, [input.snapshotId, input.path])
      const row = existing.rows[0]
      if (!row) return 'conflict'
      const identical = row.blob_hash === input.blobHash
        && Number(row.byte_count) === input.byteCount
        && row.mode === input.mode
        && row.language === input.language
        && row.capability === input.capability
      return identical ? 'replayed' : 'conflict'
    },

    async listEntries(input: {
      installationId: string
      snapshotId: string
    }, client?: Queryable): Promise<ManifestEntry[]> {
      const query = client ?? pool
      const result = await query.query<{
        path: string
        blob_hash: string
        language: string
        capability: string
        byte_count: string | number
        mode: string
      }>(`
        SELECT path, blob_hash, language, capability, byte_count, mode
        FROM memory_source_snapshot_entries
        WHERE installation_id = $1 AND snapshot_id = $2
        ORDER BY path
      `, [input.installationId, input.snapshotId])
      return result.rows.map(row => ({
        path: row.path,
        gitMode: row.mode,
        language: row.language,
        capability: row.capability,
        blobSha256: row.blob_hash,
        byteCount: Number(row.byte_count),
      }))
    },

    /** Transition staging -> ready inside one transaction. */
    async markReady(input: {
      installationId: string
      snapshotId: string
      fileCount: number
      byteCount: number
    }, client: Queryable): Promise<boolean> {
      const result = await client.query(`
        UPDATE memory_source_snapshots
        SET state = 'ready', file_count = $3, byte_count = $4, completed_at = NOW()
        WHERE installation_id = $1 AND snapshot_id = $2 AND state = 'staging'
      `, [input.installationId, input.snapshotId, input.fileCount, input.byteCount])
      return (result.rowCount ?? 0) === 1
    },

    /** Abort: staging entries vanish; the snapshot reads failed forever. */
    async abortSnapshot(input: {
      installationId: string
      snapshotId: string
    }): Promise<boolean> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const removed = await client.query(`
          DELETE FROM memory_source_snapshot_entries
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [input.installationId, input.snapshotId])
        const marked = await client.query(`
          UPDATE memory_source_snapshots
          SET state = 'failed', completed_at = NOW()
          WHERE installation_id = $1 AND snapshot_id = $2 AND state IN ('staging', 'ready')
        `, [input.installationId, input.snapshotId])
        await client.query('COMMIT')
        return (marked.rowCount ?? 0) === 1 || (removed.rowCount ?? 0) > 0
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    /** Read one blob's content (never cross-installation). */
    async getBlob(input: {
      installationId: string
      blobHash: string
    }, client?: Queryable): Promise<string | null> {
      const query = client ?? pool
      const result = await query.query<{ utf8_content: string }>(`
        SELECT utf8_content FROM memory_source_blobs
        WHERE installation_id = $1 AND blob_hash = $2
      `, [input.installationId, input.blobHash])
      return result.rows[0]?.utf8_content ?? null
    },
  }
}

export type SourceRepository = ReturnType<typeof createSourceRepository>

interface SourceSnapshotRow {
  snapshot_id: string
  repository_id: string
  commit_sha: string
  manifest_hash: string
  state: string
  generation: string | number
  file_count: string | number
  byte_count: string | number
}

function toSnapshotRecord(row: SourceSnapshotRow): SourceSnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    manifestHash: row.manifest_hash,
    state: row.state,
    generation: Number(row.generation),
    fileCount: Number(row.file_count),
    byteCount: Number(row.byte_count),
  }
}

export { languageCapabilityFor }
