import {recallPoolBudget} from './recall-pools.js'
import {currentClaimVersionSql,asOfClaimVersionSql} from '../claims/version-selection.js'
import {ORIGIN_POLICY_REQUIRED_SQL,originPolicyDecisions} from '../governance/origin-policy.js'
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type pg from 'pg'
import { fuseRanks, type FusedResult, type RankedPool } from './rrf.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'
import { normalize } from './postgres-vector-index.js'
import {claimConsumptionDecision} from '../governance/applicability.js'
import {canonicalRepositoryRemotes} from '../governance/publication-applicability.js'
import type {RepositoryContextProof} from './federated-context.js'
import { normalizedClaimKey } from './query-normalizer.js'

/**
 * Deterministic hybrid claim search (plan §8). Candidate pools are enforced
 * in SQL (installation, active claim, as-of-effective Version, evidence, validity,
 * scope); lexical recall uses websearch_to_tsquery('simple') with a pg_trgm
 * fallback; the vector pool compares only the configured provider/model/
 * dimensions family and degrades to lexical-only on any embedding failure.
 * Query text is never logged or persisted here.
 */


export interface SearchInput {
  installationId: string
  query: string
  repositoryId?: string | null
  repoSnapshotId?: string | null
  branch?: string | null
  taskScopeKey?: string | null
  /** Server-only resolved context proof; never accepted from REST/MCP request bodies. */
  canonicalRepositoryKey?:string|null
  snapshotCommitSha?:string|null
  requireUniqueCanonicalRepository?:boolean
  repositoryContextValidated?:boolean
  sourceRepositoryContext?:RepositoryContextProof
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
  poolRanks?:Record<string,number>
}

export interface SearchResult {
  hits: SearchHit[]
  nextCursor: string | null
  degradedComponents: string[]
  poolSizes: Record<string, number>
  rankedPools?:RankedPool[]
  candidatePoolTruncated?:boolean
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
  consumption_hold_reason: string | null
  canonical_repository_key: string | null
  applicability: unknown
  origin_policy_required?:boolean
  vector_score?:number|string|null
  eligible_count?:string
  selected_cap?:boolean
}

export interface SearchServiceDeps {
  pool: pg.Pool
  /** Configured embedding adapter plus identity (vector pool stays off without it). */
  embed?: EmbeddingProvider & { provider: string; model: string }
  recallEmbeddingTimeoutMs: number
  cursorSigningKey: string
  embeddingConsentFingerprint?: string
  onRecallMetrics?(input:{eligible:number;hydrated:number;returned:number;truncated:boolean;degraded:boolean;durationMs:number}):void
}

export function createSearchService(deps: SearchServiceDeps) {
  const service={
    async search(input: SearchInput,internalBudget?:number): Promise<SearchResult> {
      const started=performance.now()
      const internal=internalBudget!==undefined,budget=recallPoolBudget(internalBudget)
      const limit = internal?budget*3:Math.min(Math.max(1, input.limit ?? 10), 20)
      const query = input.query.trim()
      if (query.length === 0 || query.length > 2000) {
        throw new Error('query must be 1..2000 characters')
      }
      const cursorContext = cursorContextFor(input)
      const cursorState = decodeCursor(input.cursor, cursorContext, deps.cursorSigningKey, input.asOf)
      const requestedAsOf = cursorState?.asOf ?? input.asOf?.toISOString() ?? null
      const historicalSelection=cursorState?.historical??Boolean(input.asOf)
      const degraded: string[] = []

      const claimTypes = input.claimTypes && input.claimTypes.length > 0
        ? input.claimTypes.slice(0, 9)
        : null

      const queryTokensLower=new Set(query.toLowerCase().split(/[^a-z0-9_\u3040-\u30ff\u3400-\u9fff]+/i).filter(token=>token.length>1))
      const embeddingMode=await deps.pool.query<{embedding_mode:string|null;embedding_consent_fingerprint:string|null}>(`
        SELECT embedding_mode,embedding_consent_fingerprint FROM memory_feature_settings WHERE installation_id=$1`,[input.installationId])
      const mode=embeddingMode.rows[0]?.embedding_mode
      const consentMatches=!deps.embeddingConsentFingerprint||embeddingMode.rows[0]?.embedding_consent_fingerprint===deps.embeddingConsentFingerprint
      let queryEmbedding:number[]|null=null
      if((mode==='shadow'||mode==='enabled')&&(!deps.embed||!consentMatches))degraded.push('embedding')
      if((mode==='shadow'||mode==='enabled')&&deps.embed&&consentMatches){
        try{
          const controller=new AbortController()
          const embedded=await withTimeout(deps.embed.embed({operation:'recall_query',texts:[query],signal:controller.signal}),deps.recallEmbeddingTimeoutMs,controller)
          await deps.pool.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,
            embedding_tokens,cached_tokens,cost_micros,occurred_at)
            VALUES($1,'embedding:query:'||gen_random_uuid()::text,'embedding',$2,0,0,$3,0,$4,NOW())`,
            [input.installationId,deps.embed.model,embedded.tokens,embedded.costMicros??0])
          const vector=embedded.vectors[0]
          if(!vector||vector.length!==deps.embed.dimensions)degraded.push('embedding')
          else if(vector.every(value=>value===0))degraded.push('empty_vector')
          else queryEmbedding=normalize(vector)
        }catch{degraded.push('embedding')}
      }
      // SQL ranks the entire eligible corpus before bounded hydration. No UUID prefix scan.
      const prefiltered = await deps.pool.query<PrefilteredRow>(`
        WITH search_clock AS (
          SELECT COALESCE($2::timestamptz, statement_timestamp()) AS as_of
        ), eligible AS MATERIALIZED (
        SELECT v.version_id::text, c.claim_id::text, c.claim_type, v.statement,
               ${ORIGIN_POLICY_REQUIRED_SQL} AS origin_policy_required,
               COALESCE(d.document,v.statement) AS search_document,
               COALESCE(d.search_vector,to_tsvector('simple'::regconfig,v.statement)) AS search_vector,
               c.scope_kind, c.scope_key, v.valid_from, v.freshness_at, v.repository_id::text,
               v.repo_snapshot_id::text, v.branch, v.authority, c.consumption_hold_reason, c.canonical_repository_key, v.applicability,
               to_char(search_clock.as_of AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS search_as_of
        FROM search_clock
        CROSS JOIN knowledge_claims c
        JOIN knowledge_versions v ON v.claim_id = c.claim_id
                                  AND v.installation_id = c.installation_id
        LEFT JOIN claim_search_documents d ON d.installation_id=v.installation_id AND d.version_id=v.version_id
        WHERE c.installation_id = $1
          AND c.state = 'active'
          AND c.consumption_hold_reason IS NULL
          AND (v.applicability IS NULL OR v.applicability->>'status'='verified')
          AND ${historicalSelection ? asOfClaimVersionSql('c','v','search_clock.as_of') : currentClaimVersionSql('c','v','search_clock.as_of')}
          AND (v.valid_from IS NULL OR v.valid_from <= search_clock.as_of)
          AND (v.valid_until IS NULL OR v.valid_until > search_clock.as_of)
          AND EXISTS (
            SELECT 1 FROM knowledge_evidence e
            WHERE e.installation_id = c.installation_id AND e.version_id = v.version_id
          )
          AND ($3::uuid IS NULL OR v.repository_id = $3
            OR (v.applicability IS NOT NULL AND c.scope_kind IN ('installation','task')))
          AND ($4::uuid IS NULL OR v.repo_snapshot_id = $4
            OR (v.applicability IS NOT NULL AND c.scope_kind <> 'snapshot'))
          AND ($5::text IS NULL OR v.branch = $5
            OR (v.applicability IS NOT NULL AND c.scope_kind <> 'branch'))
          AND ($6::text[] IS NULL OR c.claim_type = ANY($6))
          AND ($7::text IS NULL OR v.applicability IS NULL OR c.scope_kind NOT IN ('repository','snapshot','branch') OR c.canonical_repository_key=$7)
          AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM repositories r WHERE r.installation_id=$1 AND r.repository_id=$3
            AND ($7::text IS NULL OR r.canonical_remote=ANY($8::text[]))
            AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)))
          AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM repo_snapshots s WHERE s.installation_id=$1 AND s.repository_id=$3 AND s.repo_snapshot_id=$4 AND s.commit_sha=$9
            AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)))
          AND (NOT $11::boolean OR (SELECT count(*) FROM repositories r WHERE r.installation_id=$1 AND r.canonical_remote=ANY($8::text[])
            AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id))=1)
          AND ($12::uuid IS NULL OR EXISTS(SELECT 1 FROM repositories origin WHERE origin.installation_id=$12 AND origin.repository_id=$13
            AND origin.canonical_remote=ANY($8::text[])
            AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=origin.installation_id AND t.repository_id=origin.repository_id)
            AND ($14::uuid IS NULL OR EXISTS(SELECT 1 FROM repo_snapshots origin_snapshot
              WHERE origin_snapshot.installation_id=$12 AND origin_snapshot.repository_id=$13 AND origin_snapshot.repo_snapshot_id=$14 AND origin_snapshot.commit_sha=$15
               AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=origin_snapshot.installation_id AND t.repository_id=origin_snapshot.repository_id AND t.commit_sha=origin_snapshot.commit_sha)))))
          AND (v.applicability IS NULL OR (
            v.applicability->>'scopeKind'=c.scope_kind AND v.applicability->>'scopeKey'=c.scope_key
            AND v.applicability->>'repositoryId' IS NOT DISTINCT FROM v.repository_id::text
            AND v.applicability->>'snapshotId' IS NOT DISTINCT FROM v.repo_snapshot_id::text
            AND v.applicability->>'branch' IS NOT DISTINCT FROM v.branch
            AND v.applicability->>'canonicalRepositoryKey' IS NOT DISTINCT FROM c.canonical_repository_key
            AND (c.scope_kind NOT IN('repository','snapshot','branch') OR ($3::uuid IS NOT NULL AND v.repository_id=$3))
            AND (c.scope_kind<>'snapshot' OR ($4::uuid IS NOT NULL AND v.repo_snapshot_id=$4))
            AND (c.scope_kind<>'branch' OR ($5::text IS NOT NULL AND v.branch=$5))
            AND (c.scope_kind<>'task' OR ($23::text IS NOT NULL AND c.scope_key=$23))))
        ), metadata_candidates AS(
          SELECT version_id FROM eligible WHERE EXISTS(SELECT 1 FROM unnest($22::text[]) token
            WHERE strpos(lower(claim_type||'|'||scope_key||'|'||statement),token)>0)
          ORDER BY authority ASC,freshness_at DESC,version_id LIMIT $21
        ), lexical_candidates AS(
          SELECT version_id FROM eligible
          WHERE search_vector@@websearch_to_tsquery('simple'::regconfig,$16)
            OR word_similarity($16,search_document)>.3
          ORDER BY CASE WHEN search_vector@@websearch_to_tsquery('simple'::regconfig,$16)
            THEN 1+ts_rank(search_vector,websearch_to_tsquery('simple'::regconfig,$16))
            ELSE word_similarity($16,search_document) END DESC,authority DESC,freshness_at DESC,version_id LIMIT $21
        ), vector_candidates AS(
          SELECT eligible.version_id,sc.score FROM eligible
          JOIN claim_search_documents vd ON vd.installation_id=$1 AND vd.version_id=eligible.version_id::uuid
          CROSS JOIN LATERAL(SELECT COALESCE(sum(pair.a*pair.b),0) AS score FROM unnest(embedding,$17::real[]) pair(a,b)) sc
          WHERE sc.score>.05 AND $17::real[] IS NOT NULL AND embedding_provider=$18 AND embedding_model=$19
            AND embedding_dimensions=$20 AND cardinality(embedding)=$20 AND embedding_status='ready'
          ORDER BY score DESC,authority ASC,freshness_at DESC,version_id LIMIT $21
        ), picked AS(SELECT version_id FROM metadata_candidates UNION SELECT version_id FROM lexical_candidates
          UNION SELECT version_id FROM vector_candidates)
        SELECT e.version_id,e.claim_id,e.claim_type,e.statement,e.origin_policy_required,e.scope_kind,e.scope_key,
          e.valid_from,e.freshness_at,e.repository_id,e.repo_snapshot_id,e.branch,e.authority,e.consumption_hold_reason,
          e.canonical_repository_key,e.applicability,e.search_as_of,vc.score AS vector_score,
          (SELECT count(*)::text FROM eligible) AS eligible_count,
          ((SELECT count(*) FROM metadata_candidates)>=$21 OR (SELECT count(*) FROM lexical_candidates)>=$21
            OR (SELECT count(*) FROM vector_candidates)>=$21) AS selected_cap
        FROM eligible e JOIN picked USING(version_id) LEFT JOIN vector_candidates vc USING(version_id)
        ORDER BY e.version_id
      `, [
        input.installationId, requestedAsOf,
        input.repositoryId ?? null,
        input.repoSnapshotId ?? null,
        input.branch ?? null,
        claimTypes,
        input.canonicalRepositoryKey??null,
        input.canonicalRepositoryKey?canonicalRepositoryRemotes(input.canonicalRepositoryKey):null,
        input.snapshotCommitSha??null,input.repositoryContextValidated===true,input.requireUniqueCanonicalRepository===true,
        input.sourceRepositoryContext?.installationId??null,input.sourceRepositoryContext?.repositoryId??null,
        input.sourceRepositoryContext?.repoSnapshotId??null,input.sourceRepositoryContext?.commitSha??null,
        query,queryEmbedding,deps.embed?.provider??null,deps.embed?.model??null,deps.embed?.dimensions??null,budget,
        [...queryTokensLower],input.taskScopeKey??null,
      ])
      const origin=await originPolicyDecisions(deps.pool,input.installationId,prefiltered.rows.filter(r=>r.origin_policy_required).map(r=>r.version_id))
      const rows = prefiltered.rows.filter(row=>claimConsumptionDecision({
        scopeKind:row.scope_kind,scopeKey:row.scope_key,repositoryId:row.repository_id,snapshotId:row.repo_snapshot_id,branch:row.branch,
        consumptionHoldReason:row.consumption_hold_reason,canonicalRepositoryKey:row.canonical_repository_key,applicability:row.applicability,
      },{repositoryId:input.repositoryId,snapshotId:input.repoSnapshotId,branch:input.branch,taskScopeKey:input.taskScopeKey}).eligible).filter(row=>{if(!row.origin_policy_required)return true;const decision=origin.get(row.version_id);if(decision?.eligible)return true;
        const reason=decision?.reason??'origin_policy_requires_review';if(!degraded.includes(reason))degraded.push(reason);return false})
      const candidatePoolTruncated=prefiltered.rows[0]?.selected_cap===true
      if(rows.length<prefiltered.rows.length&&candidatePoolTruncated)degraded.push('post_filter_pool_truncated')
      if (rows.length === 0) {
        deps.onRecallMetrics?.({eligible:Number(prefiltered.rows[0]?.eligible_count??0),hydrated:prefiltered.rows.length,returned:0,truncated:candidatePoolTruncated,degraded:degraded.length>0,durationMs:performance.now()-started})
        return { hits: [], nextCursor: null, degradedComponents: degraded, poolSizes: {} }
      }
      const byVersion = new Map(rows.map(row => [row.version_id, row]))
      const asOf = requestedAsOf ?? rows[0].search_as_of
      const versionIds = rows.map(row => row.version_id)

      const pools: RankedPool[] = []
      const vectorSimilarityByVersion = new Map<string, number>()

      // 2. Metadata pool: query tokens hit the normalized identity.
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
        .slice(0,budget)
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
      lexicalPool=lexicalPool.slice(0,internal?budget:200)
      pools.push({ name: 'lexical', ranked: lexicalPool })

      // Database exact cosine returns only Top-K scores, never corpus-sized arrays.
      let shadowComparison:SearchResult['shadowComparison']
      if(queryEmbedding){
        const scored=rows.filter(row=>row.vector_score!=null).map(row=>({versionId:row.version_id,score:Number(row.vector_score)}))
          .filter(entry=>entry.score>.05).sort((a,b)=>b.score-a.score||compareRankingRows(byVersion.get(a.versionId)!,byVersion.get(b.versionId)!)).slice(0,budget)
        const vectorRanked=scored.map(entry=>entry.versionId)
        for(const entry of scored)vectorSimilarityByVersion.set(entry.versionId,entry.score)
        if(mode==='enabled')pools.push({name:'vector',ranked:vectorRanked})
        else if(mode==='shadow'){
          const topK=Math.min(20,lexicalPool.length,vectorRanked.length),lexicalTop=new Set(lexicalPool.slice(0,topK))
          shadowComparison={topK,overlapCount:vectorRanked.slice(0,topK).filter(id=>lexicalTop.has(id)).length}
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
      deps.onRecallMetrics?.({eligible:Number(prefiltered.rows[0]?.eligible_count??0),hydrated:prefiltered.rows.length,returned:page.length,
        truncated:candidatePoolTruncated,degraded:degraded.length>0,durationMs:performance.now()-started})
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
          ...(internal?{poolRanks:Object.fromEntries(pools.filter(p=>p.ranked.includes(entry.versionId))
            .map(p=>[p.name,p.ranked.indexOf(entry.versionId)+1]))}:{}),
          vectorSimilarity: entry.sources.includes('vector')
            ? vectorSimilarityByVersion.get(entry.versionId) ?? null
            : null,
        })),
        nextCursor: nextOffset < adjusted.length
          ? encodeCursor(nextOffset, cursorContext, asOf, deps.cursorSigningKey,historicalSelection)
          : null,
        degradedComponents: degraded,
        poolSizes,
        candidatePoolTruncated,
        ...(internal?{rankedPools:pools}:{}),
        ...(shadowComparison ? { shadowComparison } : {}),
      }
    },
    async internalRecall(input:SearchInput&{candidateBudget?:number}):Promise<SearchResult>{
      return service.search({...input,cursor:null},recallPoolBudget(input.candidateBudget))
    },
  }
  return service
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

function encodeCursor(offset: number, context: string, asOf: string, key: string,historical:boolean): string {
  const payload = Buffer.from(JSON.stringify({ o: offset, q: context, a: asOf,m:historical }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeCursor(
  cursor: string | null | undefined,
  context: string,
  key: string,
  requestedAsOf?: Date | null,
): { offset: number; asOf: string;historical:boolean } | null {
  if (!cursor) return null
  try {
    const [payload, suppliedSignature, extra] = cursor.split('.')
    if (!payload || !suppliedSignature || extra !== undefined) throw new Error('invalid_cursor')
    const expected = createHmac('sha256', key).update(payload).digest()
    const supplied = Buffer.from(suppliedSignature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid_cursor')
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { o?: unknown; q?: unknown; a?: unknown;m?:unknown }
    if (parsed.q !== context || (parsed.m!==undefined&&typeof parsed.m!=='boolean') || (requestedAsOf&&parsed.m===false)) throw new Error('invalid_cursor')
    const offset = typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0
      ? parsed.o
      : NaN
    if (!Number.isFinite(offset) || typeof parsed.a !== 'string') throw new Error('invalid_cursor')
    const asOf = parsed.a
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(asOf)
      || Number.isNaN(Date.parse(asOf))) throw new Error('invalid_cursor')
    if (requestedAsOf && requestedAsOf.toISOString() !== asOf) throw new Error('invalid_cursor')
    return { offset: Math.min(offset, 100_000), asOf,historical:parsed.m===true||(parsed.m===undefined&&Boolean(requestedAsOf)) }
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
    ...(input.taskScopeKey!=null?{taskScopeKey:input.taskScopeKey}:{}),
    ...(input.repositoryContextValidated||input.sourceRepositoryContext?{canonicalRepositoryKey:input.canonicalRepositoryKey??null,snapshotCommitSha:input.snapshotCommitSha??null,
      repositoryContextValidated:input.repositoryContextValidated===true,requireUniqueCanonicalRepository:input.requireUniqueCanonicalRepository===true,
      sourceRepositoryContext:input.sourceRepositoryContext??null}:{}),
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
