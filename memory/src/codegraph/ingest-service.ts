import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import { createIdempotencyStore } from '../api/idempotency.js'
import {
  CODE_SNAPSHOT_MAX_FILE_BYTES,
  CODE_SNAPSHOT_MAX_FILES,
  CODE_SNAPSHOT_MAX_TOTAL_BYTES,
  canonicalJsonStringify,
  languageCapabilityFor,
} from './types.js'
import {
  computeManifestHash,
  createSourceRepository,
  SourceRepositoryTombstonedError,
} from './source-repository.js'
import type { Phase4Metrics } from '../metrics.js'

/**
 * Phase 4 snapshot ingest service (ADR-0006 §2): start/upload/finalize with
 * content-addressed integrity. Finalize verifies the complete manifest
 * transactionally and only then flips the snapshot to ready and enqueues the
 * parse job — nothing parses before the manifest commits.
 */

export class SnapshotIngestError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function createSourceIngestService(
  pool: pg.Pool,
  options: { metrics?: Phase4Metrics } = {},
) {
  const repository = createSourceRepository(pool)
  const idempotency = createIdempotencyStore(pool)

  const languageClass = (entry: {
    language: string
    capability: string
  }): 'typescript' | 'javascript' | 'file_only' | 'unsupported' => {
    if (entry.capability === 'unsupported') return 'unsupported'
    if (entry.capability === 'file_only') return 'file_only'
    if (entry.language === 'javascript' || entry.language === 'jsx') return 'javascript'
    return 'typescript'
  }

  const idempotencyResult = <T extends Record<string, unknown>>(
    result:
      | { kind: 'replayed'; metadata: Record<string, unknown> }
      | { kind: 'conflict' }
      | { kind: 'completed'; metadata: Record<string, unknown> }
      | { kind: 'failed'; error: unknown },
    conflictCode = 'idempotency_conflict',
  ): T => {
    if (result.kind === 'conflict') throw new SnapshotIngestError(conflictCode)
    if (result.kind === 'failed') throw result.error
    return result.metadata as T
  }

  const assertReplayTarget = async (input: {
    installationId: string
    snapshotId: string
    repositoryId?: string
  }): Promise<void> => {
    const snapshot = await repository.getSnapshot({
      installationId: input.installationId,
      snapshotId: input.snapshotId,
    })
    if (snapshot) {
      if (snapshot.state === 'failed') throw new SnapshotIngestError('state_conflict')
      return
    }
    const snapshotTombstone = await pool.query(`
      SELECT 1 FROM memory_source_snapshot_tombstones
      WHERE installation_id = $1 AND snapshot_id = $2
    `, [input.installationId, input.snapshotId])
    if (snapshotTombstone.rows[0]) {
      throw new SourceRepositoryTombstonedError('snapshot_tombstoned')
    }
    if (input.repositoryId) {
      const repositoryTombstone = await pool.query(`
        SELECT 1 FROM memory_repository_tombstones
        WHERE installation_id = $1 AND repository_id = $2
      `, [input.installationId, input.repositoryId])
      if (repositoryTombstone.rows[0]) {
        throw new SourceRepositoryTombstonedError('repository_tombstoned')
      }
    }
    throw new SnapshotIngestError('not_found')
  }

  return {
    repository,

    async startSnapshot(input: {
      installationId: string
      repository: { repository_key: string; canonical_remote?: string }
      gitObjectFormat: string
      commitSha: string
      manifestSha256: string
      expectedFileCount: number
      expectedByteCount: number
      idempotencyKey: string
      sourceKind?: 'personal' | 'shared'
    }): Promise<{ snapshotId: string; repositoryId: string; state: string }> {
      if (input.gitObjectFormat !== 'sha1' && input.gitObjectFormat !== 'sha256') {
        throw new SnapshotIngestError('invalid_request')
      }
      if (input.expectedFileCount > CODE_SNAPSHOT_MAX_FILES
        || input.expectedByteCount > CODE_SNAPSHOT_MAX_TOTAL_BYTES) {
        throw new SnapshotIngestError('invalid_request')
      }
      const result = await idempotency.execute({
        installationId: input.installationId,
        operation: 'code_snapshot_start',
        key: input.idempotencyKey,
        requestCanonical: canonicalJsonStringify({
          repository_key: input.repository.repository_key,
          git_object_format: input.gitObjectFormat,
          commit_sha: input.commitSha,
          manifest_sha256: input.manifestSha256,
          expected_file_count: input.expectedFileCount,
          expected_byte_count: input.expectedByteCount,
        }),
        run: async client => {
          try {
            const repositoryId = await repository.resolveRepository({
              installationId: input.installationId,
              repositoryKey: input.repository.repository_key,
              ...(input.repository.canonical_remote
                ? { canonicalRemote: input.repository.canonical_remote } : {}),
            }, client)
            const snapshot = await repository.insertSnapshot({
              installationId: input.installationId,
              repositoryId,
              commitSha: input.commitSha,
              gitObjectFormat: input.gitObjectFormat,
              manifestHash: input.manifestSha256,
              expectedFileCount: input.expectedFileCount,
              expectedByteCount: input.expectedByteCount,
            }, client)
            return { ok: true, metadata: {
              snapshotId: snapshot.snapshotId,
              repositoryId: snapshot.repositoryId,
              state: snapshot.state,
            } }
          } catch (error) {
            return { ok: false, error }
          }
        },
      })
      if (result.kind === 'replayed') {
        await assertReplayTarget({
          installationId: input.installationId,
          snapshotId: String(result.metadata.snapshotId),
          repositoryId: String(result.metadata.repositoryId),
        })
      }
      return idempotencyResult<{ snapshotId: string; repositoryId: string; state: string }>(result)
    },

    async uploadBatch(input: {
      installationId: string
      snapshotId: string
      batchIndex: number
      entries: Array<{
        path: string
        git_mode: string
        language: string
        capability: string
        blob_sha256: string
        byte_count: number
        content_base64: string
      }>
    }): Promise<{ accepted: number }> {
      // Duplicate paths inside one batch are malformed, not idempotent.
      const seen = new Set<string>()
      const validated: Array<{ entry: typeof input.entries[number]; content: Buffer }> = []
      for (const entry of input.entries) {
        if (seen.has(entry.path)) throw new SnapshotIngestError('invalid_request')
        seen.add(entry.path)
        // The language capability matrix is frozen: a lying capability claim
        // is rejected before any content is stored.
        const expected = languageCapabilityFor(entry.path)
        if (expected !== entry.capability) {
          throw new SnapshotIngestError('invalid_request')
        }
        let content: Buffer
        try {
          content = Buffer.from(entry.content_base64, 'base64')
        } catch {
          throw new SnapshotIngestError('invalid_request')
        }
        if (content.length === 0 || content.length > CODE_SNAPSHOT_MAX_FILE_BYTES) {
          throw new SnapshotIngestError('invalid_request')
        }
        if (Buffer.byteLength(entry.content_base64, 'utf8') > content.length * 2 + 1024) {
          throw new SnapshotIngestError('invalid_request')
        }
        if (content.length !== entry.byte_count) {
          throw new SnapshotIngestError('integrity_mismatch')
        }
        const digest = createHash('sha256').update(content).digest('hex')
        if (digest !== entry.blob_sha256) {
          throw new SnapshotIngestError('integrity_mismatch')
        }
        if (content.includes(0)) throw new SnapshotIngestError('invalid_request')
        validated.push({ entry, content })
      }
      const result = await idempotency.execute({
        installationId: input.installationId,
        operation: `code_snapshot_batch:${input.snapshotId}`,
        key: String(input.batchIndex),
        requestCanonical: canonicalJsonStringify({
          snapshot_id: input.snapshotId,
          batch_index: input.batchIndex,
          entries: input.entries,
        }),
        run: async client => {
          try {
            const snapshot = await repository.getSnapshot({
              installationId: input.installationId,
              snapshotId: input.snapshotId,
            }, client)
            if (!snapshot) throw new SnapshotIngestError('not_found')
            if (snapshot.state !== 'staging') throw new SnapshotIngestError('state_conflict')
            const acceptedBytes: Record<string, number> = {}
            for (const { entry, content } of validated) {
              await repository.insertBlob({
                installationId: input.installationId,
                blobHash: entry.blob_sha256,
                byteCount: entry.byte_count,
                content: content.toString('utf8'),
              }, client)
              const outcome = await repository.insertEntry({
                installationId: input.installationId,
                snapshotId: input.snapshotId,
                path: entry.path,
                blobHash: entry.blob_sha256,
                language: entry.language,
                capability: entry.capability,
                byteCount: entry.byte_count,
                mode: entry.git_mode,
              }, client)
              if (outcome === 'conflict') throw new SnapshotIngestError('integrity_mismatch')
              if (outcome === 'inserted') {
                const classification = languageClass(entry)
                acceptedBytes[classification] = (acceptedBytes[classification] ?? 0) + entry.byte_count
              }
            }
            return { ok: true, metadata: {
              accepted: validated.length,
              repositoryId: snapshot.repositoryId,
              acceptedBytes,
            } }
          } catch (error) {
            return { ok: false, error }
          }
        },
      })
      if (result.kind === 'completed') {
        const acceptedBytes = result.metadata.acceptedBytes
        if (acceptedBytes && typeof acceptedBytes === 'object') {
          for (const classification of ['typescript', 'javascript', 'file_only', 'unsupported'] as const) {
            const bytes = Number((acceptedBytes as Record<string, unknown>)[classification] ?? 0)
            if (bytes > 0) {
              options.metrics?.codeSnapshotBytes.inc({ language_class: classification }, bytes)
            }
          }
        }
      } else if (result.kind === 'replayed') {
        await assertReplayTarget({
          installationId: input.installationId,
          snapshotId: input.snapshotId,
          repositoryId: typeof result.metadata.repositoryId === 'string'
            ? result.metadata.repositoryId : undefined,
        })
      }
      return idempotencyResult<{ accepted: number }>(result, 'integrity_mismatch')
    },

    async finalizeSnapshot(input: {
      installationId: string
      snapshotId: string
      manifestSha256: string
      expectedFileCount: number
      expectedByteCount: number
      idempotencyKey: string
      sourceKind?: 'personal' | 'shared'
    }): Promise<{
      snapshotId: string
      state: string
    }> {
      const result = await idempotency.execute({
        installationId: input.installationId,
        operation: `code_snapshot_finalize:${input.snapshotId}`,
        key: input.idempotencyKey,
        requestCanonical: canonicalJsonStringify({
          snapshot_id: input.snapshotId,
          manifest_sha256: input.manifestSha256,
          expected_file_count: input.expectedFileCount,
          expected_byte_count: input.expectedByteCount,
        }),
        run: async client => {
          try {
            const snapshot = await repository.getSnapshot({
              installationId: input.installationId,
              snapshotId: input.snapshotId,
            }, client)
            if (!snapshot) throw new SnapshotIngestError('not_found')
            if (snapshot.state === 'ready') {
              return { ok: true, metadata: {
                snapshotId: snapshot.snapshotId,
                repositoryId: snapshot.repositoryId,
                state: 'ready',
                transitioned: false,
              } }
            }
            if (snapshot.state !== 'staging') throw new SnapshotIngestError('state_conflict')

            const entries = await repository.listEntries({
              installationId: input.installationId,
              snapshotId: input.snapshotId,
            }, client)
            const totalBytes = entries.reduce((total, entry) => total + entry.byteCount, 0)
            if (entries.length !== input.expectedFileCount
              || totalBytes !== input.expectedByteCount
              || totalBytes > CODE_SNAPSHOT_MAX_TOTAL_BYTES) {
              throw new SnapshotIngestError('manifest_mismatch')
            }
            const manifest = computeManifestHash(entries)
            if (manifest !== input.manifestSha256 || manifest !== snapshot.manifestHash) {
              throw new SnapshotIngestError('manifest_mismatch')
            }

            const ready = await repository.markReady({
              installationId: input.installationId,
              snapshotId: input.snapshotId,
              fileCount: entries.length,
              byteCount: totalBytes,
            }, client)
            if (!ready) throw new SnapshotIngestError('state_conflict')
            await client.query(`
              INSERT INTO memory_jobs
                (job_id, installation_id, job_type, idempotency_key, priority, payload, available_at)
              VALUES ($1, $2, 'parse_code_snapshot', $3, 70, $4::jsonb, NOW())
              ON CONFLICT DO NOTHING
            `, [randomUUID(), input.installationId,
              `parse_code_snapshot:${input.snapshotId}:${snapshot.generation}`,
              JSON.stringify({ snapshot_id: input.snapshotId })])
            return { ok: true, metadata: {
              snapshotId: input.snapshotId,
              repositoryId: snapshot.repositoryId,
              state: 'ready',
              transitioned: true,
            } }
          } catch (error) {
            return { ok: false, error }
          }
        },
      })
      if (result.kind === 'completed') {
        if (result.metadata.transitioned === true) {
          options.metrics?.codeSnapshots.inc({
            result: 'accepted', source_kind: input.sourceKind ?? 'personal',
          })
        }
      } else if (result.kind === 'failed' || result.kind === 'conflict') {
        options.metrics?.codeSnapshots.inc({
          result: 'rejected', source_kind: input.sourceKind ?? 'personal',
        })
      } else if (result.kind === 'replayed') {
        await assertReplayTarget({
          installationId: input.installationId,
          snapshotId: input.snapshotId,
          repositoryId: typeof result.metadata.repositoryId === 'string'
            ? result.metadata.repositoryId : undefined,
        })
      }
      return idempotencyResult<{ snapshotId: string; state: string }>(result)
    },

    async abortSnapshot(input: {
      installationId: string
      snapshotId: string
      sourceKind?: 'personal' | 'shared'
    }): Promise<boolean> {
      const snapshot = await repository.getSnapshot({
        installationId: input.installationId,
        snapshotId: input.snapshotId,
      })
      if (!snapshot) throw new SnapshotIngestError('not_found')
      const aborted = await repository.abortSnapshot({
        installationId: input.installationId,
        snapshotId: input.snapshotId,
      })
      if (aborted) {
        options.metrics?.codeSnapshots.inc({
          result: 'aborted', source_kind: input.sourceKind ?? 'personal',
        })
      }
      return aborted
    },
  }
}

export type SourceIngestService = ReturnType<typeof createSourceIngestService>
