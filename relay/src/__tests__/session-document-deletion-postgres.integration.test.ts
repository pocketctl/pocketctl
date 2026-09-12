import { createHash } from 'crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { deleteSession, deleteUserAccount, initDB } from '../db.js'
import {
  SessionDocumentNotFoundError,
  SessionDocumentRepository,
} from '../session-documents/repository.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('session document deletion lifecycle (PostgreSQL)', () => {
  let pool: pg.Pool
  let userId: number
  let repository: SessionDocumentRepository

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
    userId = (await pool.query<{ id: number }>(`
      INSERT INTO users (email, password_hash)
      VALUES ('document-delete@example.test', 'x') RETURNING id
    `)).rows[0].id
    await pool.query(`
      INSERT INTO daemons (daemon_id, hostname, agents, status, user_id)
      VALUES ('document-delete-daemon', 'host', '[]'::jsonb, 'online', $1)
    `, [userId])
    await pool.query(`
      INSERT INTO sessions (session_id, daemon_id, agent_type, cwd, status, user_id, model)
      VALUES ('document-delete-session-a', 'document-delete-daemon', 'codex', '/repo', 'running', $1, 'gpt-test'),
             ('document-delete-session-b', 'document-delete-daemon', 'codex', '/repo', 'running', $1, 'gpt-test')
    `, [userId])
    repository = new SessionDocumentRepository(pool, { uploadTimeoutMs: 60_000 })
  })

  async function upload(sessionId: string, documentId: string, versionId: string, commit: boolean) {
    const bytes = Buffer.from(`# ${documentId}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const common = { userId, sessionId, documentId, versionId }
    await repository.beginUpload({
      ...common,
      daemonId: 'document-delete-daemon', daemonGeneration: 1,
      displayName: `${documentId}.md`, format: 'markdown', sourceTurnId: `turn-${documentId}`,
      sourceEventId: `source-${documentId}`, totalBytes: bytes.length, sha256, chunkCount: 1,
      capturedAt: new Date(),
    })
    await repository.storeChunk({
      ...common, chunkIndex: 0, byteOffset: 0, bytes, sha256,
    })
    if (commit) await repository.commitUpload({ ...common, totalBytes: bytes.length, sha256 })
    return { bytes, sha256, common }
  }

  async function expectNoDocumentRows(): Promise<void> {
    const counts = await pool.query<{ table_name: string; count: number }>(`
      SELECT 'documents' AS table_name, COUNT(*)::int AS count FROM session_documents
      UNION ALL SELECT 'versions', COUNT(*)::int FROM session_document_versions
      UNION ALL SELECT 'uploads', COUNT(*)::int FROM session_document_uploads
      UNION ALL SELECT 'chunks', COUNT(*)::int FROM session_document_upload_chunks
    `)
    expect(Object.fromEntries(counts.rows.map((row) => [row.table_name, row.count]))).toEqual({
      documents: 0, versions: 0, uploads: 0, chunks: 0,
    })
  }

  test('deletion during upload purges ingress and assemblies, preserves usage, and rejects late replay', async () => {
    const pending = await upload('document-delete-session-a', 'pending-document', 'pending-version', false)
    await pool.query(`
      INSERT INTO events (session_id, event_type, payload)
      VALUES ('document-delete-session-a', 'agent_text',
              '{"type":"agent_text","usage":{"input_tokens":9,"output_tokens":3}}')
    `)
    const inbox = await pool.query<{ inbox_id: string }>(`
      INSERT INTO event_inbox
        (user_id, daemon_id, daemon_generation, seq, dedup_key, session_id,
         event_type, priority_class, payload)
      VALUES ($1, 'document-delete-daemon', 1, 1, 'pending-document-ingress',
              'document-delete-session-a', 'session_document_commit', 2, '{}')
      RETURNING inbox_id
    `, [userId])
    await pool.query(`
      INSERT INTO realtime_outbox
        (inbox_id, delivery_key, event_id, user_id, session_id, event_type, audience, payload)
      VALUES ($1, 'pending-document-outbox', NULL, $2, 'document-delete-session-a',
              'session_documents_changed', 'user', '{}')
    `, [inbox.rows[0].inbox_id, userId])

    await deleteSession(pool, 'document-delete-session-a')

    await expectNoDocumentRows()
    expect((await pool.query(`SELECT 1 FROM event_inbox WHERE inbox_id = $1`, [inbox.rows[0].inbox_id])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM realtime_outbox WHERE inbox_id = $1`, [inbox.rows[0].inbox_id])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM deleted_sessions WHERE session_id = 'document-delete-session-a'`)).rowCount).toBe(1)
    const usage = await pool.query(`
      SELECT input, output, requests FROM token_daily_stats
      WHERE user_id = $1 AND daemon_id = 'document-delete-daemon' AND model = 'gpt-test'
    `, [userId])
    expect(usage.rows[0]).toEqual({ input: '9', output: '3', requests: 1 })

    await expect(repository.beginUpload({
      ...pending.common,
      daemonId: 'document-delete-daemon', daemonGeneration: 1,
      displayName: 'pending-document.md', format: 'markdown', sourceTurnId: 'late-turn',
      sourceEventId: 'late-source', totalBytes: pending.bytes.length, sha256: pending.sha256,
      chunkCount: 1, capturedAt: new Date(),
    })).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    await expect(repository.storeChunk({
      ...pending.common, chunkIndex: 0, byteOffset: 0, bytes: pending.bytes, sha256: pending.sha256,
    })).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    await expect(repository.commitUpload({
      ...pending.common, totalBytes: pending.bytes.length, sha256: pending.sha256,
    })).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    await expectNoDocumentRows()
  })

  test('deletion after commit removes the projection, immutable version, and body', async () => {
    await upload('document-delete-session-a', 'committed-document', 'committed-version', true)
    expect(await repository.listLatest(userId, 'document-delete-session-a')).toHaveLength(1)

    await deleteSession(pool, 'document-delete-session-a', { usageFactsAuthoritative: true })

    await expectNoDocumentRows()
    await expect(repository.readCommittedContent(
      userId, 'document-delete-session-a', 'committed-document', 'committed-version',
    )).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
  })

  test('account deletion explicitly purges committed and pending documents across sessions', async () => {
    await upload('document-delete-session-a', 'committed-document', 'committed-version', true)
    await upload('document-delete-session-b', 'pending-document', 'pending-version', false)

    await expect(deleteUserAccount(pool, userId)).resolves.toBe(true)

    await expectNoDocumentRows()
    expect((await pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [userId])).rowCount).toBe(0)
    expect((await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId])).rowCount).toBe(0)
  })

  test.each([
    'before begin acknowledgement',
    'between chunks',
    'before commit acknowledgement',
  ])('at-least-once replay %s converges on one immutable version', async (interruption) => {
    const bytes = Buffer.from('replayed document')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const common = {
      userId, sessionId: 'document-delete-session-a', documentId: 'replay-document', versionId: 'replay-version',
    }
    const capturedAt = new Date()
    const begin = () => repository.beginUpload({
      ...common, daemonId: 'document-delete-daemon', daemonGeneration: 1,
      displayName: 'replay.md', format: 'markdown' as const, sourceTurnId: 'replay-turn',
      sourceEventId: 'replay-source', totalBytes: bytes.length, sha256, chunkCount: 2,
      capturedAt,
    })
    const chunk = (index: number, start: number, end: number) => {
      const body = bytes.subarray(start, end)
      return repository.storeChunk({
        ...common, chunkIndex: index, byteOffset: start, bytes: body,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
    }
    const commit = () => repository.commitUpload({ ...common, totalBytes: bytes.length, sha256 })

    await begin()
    if (interruption === 'before begin acknowledgement') await begin()
    await chunk(0, 0, 8)
    if (interruption === 'between chunks') {
      await begin()
      await chunk(0, 0, 8)
    }
    await chunk(1, 8, bytes.length)
    await commit()
    if (interruption === 'before commit acknowledgement') {
      await begin()
      await chunk(0, 0, 8)
      await chunk(1, 8, bytes.length)
      await expect(commit()).resolves.toMatchObject({ status: 'duplicate' })
    }

    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM session_documents WHERE document_id = 'replay-document') AS documents,
        (SELECT COUNT(*)::int FROM session_document_versions WHERE document_id = 'replay-document') AS versions,
        (SELECT COUNT(*)::int FROM session_document_uploads WHERE document_id = 'replay-document') AS uploads,
        (SELECT COUNT(*)::int FROM session_document_upload_chunks WHERE version_id = 'replay-version') AS chunks
    `)
    expect(counts.rows[0]).toEqual({ documents: 1, versions: 1, uploads: 0, chunks: 0 })
  })
})
