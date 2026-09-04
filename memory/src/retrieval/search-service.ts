import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type pg from 'pg'
import { fuseRanks, type FusedResult, type RankedPool } from './rrf.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import { normalize } from './postgres-vector-index.js'
import { normalizedClaimKey } from './query-normalizer.js'

/**
 * Deterministic hybrid claim search (plan §8). Candidate pools are enforced
 * in SQL (installation, active claim, as-of-effective Version, evidence, validity,
 * scope); lexical recall uses websearch_to_tsquery('simple') with a pg_trgm
 * fallback; the vector pool compares only the configured provider/model/
 * dimensions family and degrades to lexical-only on any embedding failure.
 * Query text is never logged or persisted here.
 */

const MAX_AUTHORIZED_VERSIONS = 10_000
const MAX_VECTOR_CANDIDATES = 2000

export interface SearchInput {
  installationId: string
  query: string
  repositoryId?: string | null
  repoSnapshotId?: string | null
  branch?: string | null
  claimTypes?: readonly string[] | null
  asOf?: Date | null
  limit?: number
  cursor?: string | null
}

export interface SearchHit {
  versionId: string
  claimId: string
  claimType: string
  statement: string
  scopeKind: string
  scopeKey: string
  freshnessAt: Date | null
  authority: string
  repositoryId: string | null
  repoSnapshotId: string | null
  branch: string | null
  score: number
  sources: string[]
  /** Raw cosine from the configured embedding family; null outside vector recall. */
  vectorSimilarity: number | null
}

export interface SearchResult {
  hits: SearchHit[]
  nextCursor: string | null
  degradedComponents: string[]
  poolSizes: Record<string, number>
  shadowComparison?: { topK: number; overlapCount: number }
}

interface PrefilteredRow {
  version_id: string
  claim_id: string
  claim_type: string
  statement: string
  scope_kind: string
  scope_key: string
  valid_from: Date | null
  freshness_at: Date
  authority: string
  repository_id: string | null
  repo_snapshot_id: string | null
  branch: string | null
  search_as_of: string
}

export interface SearchServiceDeps {
  pool: pg.Pool
  /** Configured embedding adapter plus identity (vector pool stays off without it). */
  embed?: EmbeddingProvider & { provider: string; model: string }
  recallEmbeddingTimeoutMs: number
  cursorSigningKey: string
  embeddingConsentFingerprint?: string
}

export function createSearchService(deps: SearchServiceDeps) {
  return {
    async search(input: SearchInput): Promise<SearchResult> {
      const limit = Math.min(Math.max(1, input.limit ?? 10), 20)
      const query = input.query.trim()
      if (query.length === 0 || query.length > 2000) {
        throw new Error('query must be 1..2000 characters')
      }
      const cursorContext = cursorContextFor(input)
      const cursorState = decodeCursor(input.cursor, cursorContext, deps.cursorSigningKey, input.asOf)
      const requestedAsOf = cursorState?.asOf ?? input.asOf?.toISOString() ?? null
      const degraded: string[] = []

      const claimTypes = input.claimTypes && input.claimTypes.length > 0
        ? input.claimTypes.slice(0, 9)
        : null

      // 1. The one authorized prefilter — every lexical/metadata pool draws
      //    from the full supported personal corpus. The smaller 2,000-row cap
      //    applies only after those pools prioritize vector candidates.
      const prefiltered = await deps.pool.query<PrefilteredRow>(`
        WITH search_clock AS (
          SELECT COALESCE($2::timestamptz, statement_timestamp()) AS as_of
        )
        SELECT v.version_id::text, c.claim_id::text, c.claim_type, v.statement,
               c.scope_kind, c.scope_key, v.valid_from, v.freshness_at, v.repository_id::text,
               v.repo_snapshot_id::text, v.branch, v.authority,
               to_char(search_clock.as_of AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS search_as_of
        FROM search_clock
        CROSS JOIN knowledge_claims c
        JOIN knowledge_versions v ON v.claim_id = c.claim_id
                                  AND v.installation_id = c.installation_id
        WHERE c.installation_id = $1
          AND c.state = 'active'
          AND v.created_at <= search_clock.as_of
          AND COALESCE(v.valid_from, v.created_at) <= search_clock.as_of
          AND (v.valid_until IS NULL OR v.valid_until > search_clock.as_of)
          AND EXISTS (
            SELECT 1 FROM knowledge_evidence e
            WHERE e.installation_id = c.installation_id AND e.version_id = v.version_id
          )
          AND ($3::uuid IS NULL OR v.repository_id = $3)
          AND ($4::uuid IS NULL OR v.repo_snapshot_id = $4)
          AND ($5::text IS NULL OR v.branch = $5)
          AND ($6::text[] IS NULL OR c.claim_type = ANY($6))
        ORDER BY v.version_id
        LIMIT ${MAX_AUTHORIZED_VERSIONS}
      `, [
        input.installationId, requestedAsOf,
        input.repositoryId ?? null,
        input.repoSnapshotId ?? null,
        input.branch ?? null,
        claimTypes,
      ])
      const rows = prefiltered.rows
      if (rows.length === 0) {
        return { hits: [], nextCursor: null, degradedComponents: [], poolSizes: {} }
      }
      const byVersion = new Map(rows.map(row => [row.version_id, row]))
      const asOf = requestedAsOf ?? rows[0].search_as_of
      const versionIds = rows.map(row => row.version_id)

      const pools: RankedPool[] = []
      const vectorSimilarityByVersion = new Map<string, number>()

      // 2. Metadata pool: query tokens hit the normalized identity.
      const queryTokensLower = new Set(
        query.toLowerCase().split(/[^a-z0-9_\u3040-\u30ff\u3400-\u9fff]+/i)
          .filter(token => token.length > 1),
      )
      const metadataPool = rows
        .filter(row => {
          const key = normalizedClaimKey({
            claimType: row.claim_type,
            scopeKey: row.scope_key,
            statement: row.statement,
          }).toLowerCase()
          for (const token of queryTokensLower) {
            if (key.includes(token)) return true
          }
          return false
        })
        .sort(compareRankingRows)
        .map(row => row.version_id)
      pools.push({ name: 'metadata', ranked: metadataPool })

      // 3. Lexical pool: FTS over the projection, trigram fallback on parse
      //    failure or empty recall (covers CJK and code tokens).
      let lexicalPool: string[] = []
      try {
        const fts = await deps.pool.query<{ version_id: string }>(`
          WITH candidate_documents AS (
            SELECT v.version_id, v.authority, v.freshness_at,
                   COALESCE(d.search_vector, to_tsvector('simple'::regconfig, v.statement)) AS search_vector
            FROM knowledge_versions v
            LEFT JOIN claim_search_documents d
              ON d.installation_id = v.installation_id AND d.version_id = v.version_id
            WHERE v.installation_id = $1 AND v.version_id = ANY($2::uuid[])
          )
          SELECT version_id::text
          FROM candidate_documents
          WHERE search_vector @@ websearch_to_tsquery('simple'::regconfig, $3)
          ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple'::regconfig, $3)) DESC,
                   authority DESC, freshness_at DESC,
                   version_id
          LIMIT 200
        `, [input.installationId, versionIds, query])
        lexicalPool = fts.rows.map(row => row.version_id)
      } catch {
        lexicalPool = []
      }
      if (lexicalPool.length === 0) {
        // word_similarity ranks the best matching span of the document —
        // substring semantics that cover CJK text and code identifiers the
        // 'simple' tokenizer cannot split.
        const trgm = await deps.pool.query<{ version_id: string }>(`
          WITH candidate_documents AS (
            SELECT v.version_id, v.authority, v.freshness_at,
                   COALESCE(d.document, v.statement) AS document
            FROM knowledge_versions v
            LEFT JOIN claim_search_documents d
              ON d.installation_id = v.installation_id AND d.version_id = v.version_id
            WHERE v.installation_id = $1 AND v.version_id = ANY($2::uuid[])
          )
          SELECT version_id::text
          FROM candidate_documents
          WHERE word_similarity($3, document) > 0.3
          ORDER BY word_similarity($3, document) DESC,
                   authority DESC, freshness_at DESC, version_id
          LIMIT 200
        `, [input.installationId, versionIds, query])
        lexicalPool = trgm.rows.map(row => row.version_id)
      }
      pools.push({ name: 'lexical', ranked: lexicalPool })

      // 4. Vector pool: only for installations that enabled embeddings, over
      //    the prefiltered candidates only, same model family only.
      const embeddingMode = await deps.pool.query<{
        embedding_mode: string | null
        embedding_consent_fingerprint: string | null
      }>(`
        SELECT embedding_mode, embedding_consent_fingerprint
        FROM memory_feature_settings WHERE installation_id = $1
      `, [input.installationId])
      const mode = embeddingMode.rows[0]?.embedding_mode
      const consentMatches = !deps.embeddingConsentFingerprint
        || embeddingMode.rows[0]?.embedding_consent_fingerprint === deps.embeddingConsentFingerprint
      if ((mode === 'shadow' || mode === 'enabled') && (!deps.embed || !consentMatches)) degraded.push('embedding')
      let shadowComparison: SearchResult['shadowComparison']
      if ((mode === 'shadow' || mode === 'enabled') && deps.embed && consentMatches) {
        try {
          const controller = new AbortController()
          const queryVector = await withTimeout(
            deps.embed.embed({ operation: 'recall_query', texts: [query], signal: controller.signal }),
            deps.recallEmbeddingTimeoutMs,
            controller,
          )
          await deps.pool.query(`
            INSERT INTO memory_usage_outbox
              (installation_id, usage_id, operation, model, input_tokens, output_tokens,
               embedding_tokens, cached_tokens, cost_micros, occurred_at)
            VALUES ($1, 'embedding:query:' || gen_random_uuid()::text, 'embedding', $2,
                    0, 0, $3, 0, $4, NOW())
          `, [input.installationId, deps.embed.model, queryVector.tokens, queryVector.costMicros ?? 0])
          const vector = queryVector.vectors[0]
          if (vector && vector.length === deps.embed.dimensions) {
            // Score in application space over the prefiltered pool: exact
            // cosine against stored, normalized vectors.
            const vectorCandidateIds = prioritizedVectorCandidates(
              lexicalPool,
              metadataPool,
              versionIds,
              MAX_VECTOR_CANDIDATES,
            )
            const stored = await deps.pool.query<{
              version_id: string
              embedding: number[] | null
            }>(`
              SELECT version_id::text, embedding
              FROM claim_search_documents
              WHERE installation_id = $1
                AND version_id = ANY($2::uuid[])
                AND embedding_provider = $3
                AND embedding_model = $4
                AND embedding_dimensions = $5
                AND embedding_status = 'ready'
            `, [input.installationId, vectorCandidateIds,
                deps.embed.provider, deps.embed.model, deps.embed.dimensions])
            const normalizedQuery = normalize(vector)
            const scored = stored.rows
              .map(row => ({
                versionId: row.version_id,
                score: row.embedding
                  ? row.embedding.reduce((sum, value, index) =>
                    sum + value * (normalizedQuery[index] ?? 0), 0)
                  : -1,
              }))
              .filter(entry => entry.score > 0.05)
              .sort((a, b) => b.score - a.score
                || compareRankingRows(byVersion.get(a.versionId)!, byVersion.get(b.versionId)!))
              .slice(0, 200)
            const vectorRanked = scored.map(entry => entry.versionId)
            for (const entry of scored) {
              vectorSimilarityByVersion.set(entry.versionId, entry.score)
            }
            if (mode === 'enabled') {
              pools.push({ name: 'vector', ranked: vectorRanked })
            } else {
              const topK = Math.min(20, lexicalPool.length, vectorRanked.length)
              const lexicalTop = new Set(lexicalPool.slice(0, topK))
              shadowComparison = {
                topK,
                overlapCount: vectorRanked.slice(0, topK).filter(id => lexicalTop.has(id)).length,
              }
            }
          } else {
            degraded.push('embedding')
          }
        } catch {
          degraded.push('embedding')
        }
      }

      // 5. Fuse and apply the deterministic adjustments.
      const fused = fuseRanks(pools, rows.length)
      const adjusted = fused.map(entry => {
        const row = byVersion.get(entry.versionId)!
        let score = entry.score
        if (input.repoSnapshotId && row.repo_snapshot_id === input.repoSnapshotId) score += 0.01
        return { entry, row, score }
      })
      // Global deterministic order: adjusted score, freshness, version id.
      adjusted.sort((a, b) =>
        b.score - a.score
        || (b.row.authority < a.row.authority ? 1 : b.row.authority > a.row.authority ? -1 : 0)
        || freshKey(b.row) - freshKey(a.row)
        || (a.entry.versionId < b.entry.versionId ? -1 : 1),
      )

      const poolSizes: Record<string, number> = {}
      for (const pool of pools) poolSizes[pool.name] = pool.ranked.length

      const offset = cursorState?.offset ?? 0
      const page = adjusted.slice(offset, offset + limit)
      const nextOffset = offset + limit
      return {
        hits: page.map(({ entry, row, score }) => ({
          versionId: entry.versionId,
          claimId: row.claim_id,
          claimType: row.claim_type,
          statement: row.statement,
          scopeKind: row.scope_kind,
          scopeKey: row.scope_key,
          freshnessAt: row.freshness_at,
          authority: row.authority,
          repositoryId: row.repository_id,
          repoSnapshotId: row.repo_snapshot_id,
          branch: row.branch,
          score: Number(score.toFixed(6)),
          sources: entry.sources,
          vectorSimilarity: entry.sources.includes('vector')
            ? vectorSimilarityByVersion.get(entry.versionId) ?? null
            : null,
        })),
        nextCursor: nextOffset < adjusted.length
          ? encodeCursor(nextOffset, cursorContext, asOf, deps.cursorSigningKey)
          : null,
        degradedComponents: degraded,
        poolSizes,
        ...(shadowComparison ? { shadowComparison } : {}),
      }
    },
  }
}

function prioritizedVectorCandidates(
  lexicalPool: readonly string[],
  metadataPool: readonly string[],
  authorized: readonly string[],
  limit: number,
): string[] {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const versionId of [...metadataPool, ...lexicalPool, ...authorized]) {
    if (seen.has(versionId)) continue
    seen.add(versionId)
    selected.push(versionId)
    if (selected.length >= limit) break
  }
  return selected
}

function freshKey(row: PrefilteredRow): number {
  return row.freshness_at.getTime()
}

function compareRankingRows(a: PrefilteredRow, b: PrefilteredRow): number {
  return (b.authority < a.authority ? 1 : b.authority > a.authority ? -1 : 0)
    || freshKey(b) - freshKey(a)
    || (a.version_id === b.version_id ? 0 : a.version_id < b.version_id ? -1 : 1)
}

function encodeCursor(offset: number, context: string, asOf: string, key: string): string {
  const payload = Buffer.from(JSON.stringify({ o: offset, q: context, a: asOf }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeCursor(
  cursor: string | null | undefined,
  context: string,
  key: string,
  requestedAsOf?: Date | null,
): { offset: number; asOf: string } | null {
  if (!cursor) return null
  try {
    const [payload, suppliedSignature, extra] = cursor.split('.')
    if (!payload || !suppliedSignature || extra !== undefined) throw new Error('invalid_cursor')
    const expected = createHmac('sha256', key).update(payload).digest()
    const supplied = Buffer.from(suppliedSignature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid_cursor')
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { o?: unknown; q?: unknown; a?: unknown }
    if (parsed.q !== context) throw new Error('invalid_cursor')
    const offset = typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0
      ? parsed.o
      : NaN
    if (!Number.isFinite(offset) || typeof parsed.a !== 'string') throw new Error('invalid_cursor')
    const asOf = parsed.a
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(asOf)
      || Number.isNaN(Date.parse(asOf))) throw new Error('invalid_cursor')
    if (requestedAsOf && requestedAsOf.toISOString() !== asOf) throw new Error('invalid_cursor')
    return { offset: Math.min(offset, 100_000), asOf }
  } catch {
    throw new Error('invalid_cursor')
  }
}

function cursorContextFor(input: SearchInput): string {
  return createHash('sha256').update(JSON.stringify({
    query: input.query,
    repositoryId: input.repositoryId ?? null,
    repoSnapshotId: input.repoSnapshotId ?? null,
    branch: input.branch ?? null,
    claimTypes: input.claimTypes ? [...input.claimTypes].sort() : null,
  })).digest('base64url')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('embedding_timeout'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Request-id helper for metrics: never carries query text. */
export function searchRequestId(input: SearchInput): string {
  return createHash('sha256')
    .update(`${input.installationId}|${input.query.length}|${Date.now()}`)
    .digest('hex').slice(0, 16)
}

export type SearchService = ReturnType<typeof createSearchService>
