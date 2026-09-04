import { createHmac, timingSafeEqual } from 'crypto'
import type pg from 'pg'

/** Shared installation-scoped read semantics used by REST and MCP. */
export function createMemoryReadService(pool: pg.Pool, cursorSigningKey: string) {
  return {
    async listActiveClaims(
      installationId: string,
      input: { limit?: number; cursor?: string | null } = {},
    ) {
      const limit = Math.min(Math.max(1, input.limit ?? 50), 100)
      const before = decodeClaimListCursor(input.cursor, installationId, cursorSigningKey)
      const [claims, count] = await Promise.all([
        pool.query(`
          SELECT c.claim_id::text, c.claim_type, c.scope_kind, c.scope_key,
                 c.state, c.revision::text, c.current_version_id::text,
                 c.created_at, c.updated_at,
                 v.statement, v.authority, v.repository_id::text,
                 v.repo_snapshot_id::text, v.branch, v.freshness_at,
                 v.created_at AS version_created_at
          FROM knowledge_claims c
          JOIN knowledge_versions v
            ON v.installation_id = c.installation_id
           AND v.version_id = c.current_version_id
          WHERE c.installation_id = $1 AND c.state = 'active'
            AND ($2::timestamptz IS NULL
              OR (c.updated_at, c.claim_id) < ($2::timestamptz, $3::uuid))
          ORDER BY c.updated_at DESC, c.claim_id DESC
          LIMIT $4
        `, [installationId, before?.updatedAt ?? null, before?.claimId ?? null, limit + 1]),
        pool.query(`
          SELECT COUNT(*)::int AS count
          FROM knowledge_claims c
          JOIN knowledge_versions v
            ON v.installation_id = c.installation_id
           AND v.version_id = c.current_version_id
          WHERE c.installation_id = $1 AND c.state = 'active'
        `, [installationId]),
      ])
      const hasMore = claims.rows.length > limit
      const page = hasMore ? claims.rows.slice(0, limit) : claims.rows
      const last = page.at(-1)
      return {
        claims: page,
        next_cursor: hasMore && last
          ? encodeClaimListCursor(
            installationId,
            timestampIso(last.updated_at),
            String(last.claim_id),
            cursorSigningKey,
          )
          : null,
        total_count: Number(count.rows[0]?.count ?? 0),
      }
    },

    async getClaim(
      installationId: string,
      claimId: string,
      input: { versionLimit?: number; versionCursor?: string | null } = {},
    ) {
      const versionLimit = Math.min(Math.max(1, input.versionLimit ?? 20), 20)
      const beforeVersion = decodeVersionCursor(input.versionCursor, claimId, cursorSigningKey)
      const claim = await pool.query(`
        SELECT c.claim_id::text, c.claim_type, c.scope_kind, c.scope_key,
               c.state, c.revision::text, c.created_at, c.updated_at,
               c.current_version_id::text
        FROM knowledge_claims c
        WHERE c.installation_id = $1 AND c.claim_id = $2
      `, [installationId, claimId])
      if (!claim.rows[0]) return null
      const versions = await pool.query(`
        SELECT * FROM (
          SELECT version_id::text, version_number, statement, structured_content, authority,
                 confidence::text, repository_id::text, repo_snapshot_id::text,
                 branch, freshness_at, valid_from, valid_until, created_at
          FROM knowledge_versions
          WHERE installation_id = $1 AND claim_id = $2
            AND ($3::integer IS NULL OR version_number < $3)
          ORDER BY version_number DESC
          LIMIT $4
        ) page
        ORDER BY version_number
      `, [installationId, claimId, beforeVersion, versionLimit + 1])
      const hasMore = versions.rows.length > versionLimit
      const page = hasMore ? versions.rows.slice(1) : versions.rows
      const oldestVersion = page[0]?.version_number
      return {
        claim: claim.rows[0],
        versions: page.map(row => ({ ...row, version_number: String(row.version_number) })),
        next_version_cursor: hasMore && typeof oldestVersion === 'number'
          ? encodeVersionCursor(claimId, oldestVersion, cursorSigningKey)
          : null,
      }
    },

    async getEvidence(installationId: string, evidenceId: string) {
      const rows = await pool.query(`
        SELECT e.evidence_id::text, e.evidence_kind, e.episode_id::text,
               e.source_event_id::text, e.artifact_id::text, e.excerpt, e.locator,
               e.occurred_at, e.ordinal, v.claim_id::text, v.version_id::text
        FROM knowledge_evidence e
        JOIN knowledge_versions v
          ON v.installation_id = e.installation_id AND v.version_id = e.version_id
        WHERE e.installation_id = $1 AND e.evidence_id = $2
      `, [installationId, evidenceId])
      const row = rows.rows[0]
      if (!row) return null
      return {
        evidence_id: row.evidence_id,
        evidence_kind: row.evidence_kind,
        episode_id: row.episode_id,
        source_event_id: row.source_event_id,
        artifact_id: row.artifact_id,
        excerpt: row.excerpt.length > 4000 ? `${row.excerpt.slice(0, 3999)}…` : row.excerpt,
        truncated: row.excerpt.length > 4000,
        locator: row.locator,
        occurred_at: row.occurred_at,
        claim_id: row.claim_id,
        version_id: row.version_id,
      }
    },

    async findRelatedEpisodes(
      installationId: string,
      input: { sessionId?: string | null; limit?: number },
    ) {
      const limit = Math.min(Math.max(1, input.limit ?? 20), 100)
      const rows = await pool.query(`
        SELECT episode_id::text, session_id, turn_id, state, outcome,
               started_at, terminal_at, event_count::text
        FROM work_episodes
        WHERE installation_id = $1 AND ($2::text IS NULL OR session_id = $2)
        ORDER BY terminal_at DESC NULLS LAST, episode_id
        LIMIT $3
      `, [installationId, input.sessionId ?? null, limit])
      return { episodes: rows.rows }
    },

    async getRepositoryContext(installationId: string, repositoryId: string) {
      const claims = await pool.query(`
        SELECT c.claim_id::text, c.claim_type, v.statement, v.branch,
               v.valid_from, v.valid_until, v.authority
        FROM knowledge_claims c
        JOIN knowledge_versions v ON v.version_id = c.current_version_id
                                  AND v.installation_id = c.installation_id
        WHERE c.installation_id = $1 AND c.state = 'active' AND v.repository_id = $2
          AND (v.valid_from IS NULL OR v.valid_from <= NOW())
          AND (v.valid_until IS NULL OR v.valid_until > NOW())
        ORDER BY c.claim_type, c.claim_id
        LIMIT 200
      `, [installationId, repositoryId])
      const grouped: Record<string, unknown[]> = {}
      for (const row of claims.rows) {
        grouped[row.claim_type] = grouped[row.claim_type] ?? []
        grouped[row.claim_type].push(row)
      }
      return { repository_id: repositoryId, claims_by_type: grouped }
    },
  }
}

export type MemoryReadService = ReturnType<typeof createMemoryReadService>

function encodeClaimListCursor(
  installationId: string,
  updatedAt: string,
  claimId: string,
  key: string,
): string {
  const payload = Buffer.from(JSON.stringify({ p: 'active-claims', n: installationId, u: updatedAt, i: claimId }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeClaimListCursor(
  cursor: string | null | undefined,
  installationId: string,
  key: string,
): { updatedAt: string; claimId: string } | null {
  if (!cursor) return null
  try {
    const [payload, suppliedSignature, extra] = cursor.split('.')
    if (!payload || !suppliedSignature || extra !== undefined) throw new Error('invalid_cursor')
    const expected = createHmac('sha256', key).update(payload).digest()
    const supplied = Buffer.from(suppliedSignature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid_cursor')
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      p?: unknown
      n?: unknown
      u?: unknown
      i?: unknown
    }
    if (parsed.p !== 'active-claims' || parsed.n !== installationId
      || typeof parsed.u !== 'string' || timestampIso(parsed.u) !== parsed.u
      || typeof parsed.i !== 'string' || !UUID_PATTERN.test(parsed.i)) throw new Error('invalid_cursor')
    return { updatedAt: parsed.u, claimId: parsed.i }
  } catch {
    throw new Error('invalid_cursor')
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function timestampIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('invalid_cursor')
  return date.toISOString()
}

function encodeVersionCursor(claimId: string, beforeVersion: number, key: string): string {
  const payload = Buffer.from(JSON.stringify({ c: claimId, b: beforeVersion }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeVersionCursor(cursor: string | null | undefined, claimId: string, key: string): number | null {
  if (!cursor) return null
  try {
    const [payload, suppliedSignature, extra] = cursor.split('.')
    if (!payload || !suppliedSignature || extra !== undefined) throw new Error('invalid_cursor')
    const expected = createHmac('sha256', key).update(payload).digest()
    const supplied = Buffer.from(suppliedSignature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid_cursor')
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { c?: unknown; b?: unknown }
    if (parsed.c !== claimId || typeof parsed.b !== 'number' || !Number.isInteger(parsed.b)
      || parsed.b <= 1 || parsed.b > 2_147_483_647) throw new Error('invalid_cursor')
    return parsed.b
  } catch {
    throw new Error('invalid_cursor')
  }
}
