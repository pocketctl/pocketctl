import {assertJobFence} from '../generation/fence.js'
import type {JobFence} from '../jobs/types.js'
import {currentClaimVersionSql} from '../claims/version-selection.js'
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
  claim_type: string
  consumption_hold_reason: string | null
}

export function createClaimIndexer(deps: IndexerDeps) {
  /** A projection write shares the installation's privacy fence and locks the
   * current ledger head only for this short transaction. Never keep these
   * locks or a checked-out client across a provider request. */
  async function withCurrentVersion<T>(installationId:string,versionId:string,
    run:(client:pg.PoolClient,row:VersionRow)=>Promise<T>,fence?:JobFence):Promise<T|null>{
    const client=await deps.pool.connect()
    try{
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[installationId])
      const installation=await client.query(`SELECT 1 FROM memory_installations WHERE installation_id=$1
        AND local_status NOT IN('purging','purged','integrity_error') AND relay_status NOT IN('revoking','revoked') FOR SHARE`,[installationId])
      // Writers lock Claim before Version. Follow that order explicitly; a
      // single join locking both can deadlock with a correction's validity edit.
      const head=installation.rowCount?(await client.query<Pick<VersionRow,'claim_id'|'claim_state'|'current_version_id'|'consumption_hold_reason'>>(`
        SELECT c.claim_id::text,c.state AS claim_state,c.current_version_id::text,c.consumption_hold_reason
        FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id)
        WHERE c.installation_id=$1 AND v.version_id=$2 FOR SHARE OF c
      `,[installationId,versionId])).rows[0]:undefined
      let result:T|null=null
      if(head&&(head.claim_state!=='active'||head.consumption_hold_reason!==null)){
        await client.query(`DELETE FROM claim_search_documents WHERE installation_id=$1 AND version_id IN(
          SELECT version_id FROM knowledge_versions WHERE installation_id=$1 AND claim_id=$2)`,[installationId,head.claim_id])
      }else if(!head||head.current_version_id!==versionId){
        // A stale request may remove only its own projection, never the new head.
        await client.query('DELETE FROM claim_search_documents WHERE installation_id=$1 AND version_id=$2',[installationId,versionId])
      }else{
        const found=await client.query<VersionRow>(`
        SELECT v.version_id::text,v.claim_id::text,v.version_number,v.statement,v.structured_content,
          v.repository_id::text,r.repository_key,v.branch,c.state AS claim_state,c.current_version_id::text,
          c.claim_type,c.consumption_hold_reason
        FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
        LEFT JOIN repositories r ON r.installation_id=v.installation_id AND r.repository_id=v.repository_id
        WHERE v.installation_id=$1 AND v.version_id=$2 FOR SHARE OF v
      `,[installationId,versionId])
        const row=found.rows[0]
        if(row)result=await run(client,row)
      }
      if(fence)await assertJobFence(client,fence)
      await client.query('COMMIT')
      return result
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  async function embeddingAllowed(client:pg.PoolClient,installationId:string,versionId:string):Promise<boolean>{
    if(deps.embed&&await embeddingModeFor(client,installationId,deps.embeddingConsentFingerprint)!=='off')return true
    await client.query(`UPDATE claim_search_documents SET embedding_status='disabled',embedding=NULL
      WHERE installation_id=$1 AND version_id=$2`,[installationId,versionId])
    return false
  }
  return {
    async handleIndexClaimVersion(job: JobClaim, signal: AbortSignal,ctx?:{fence:JobFence}): Promise<void> {
      if (!job.installation_id) return
      const versionId = typeof job.payload.version_id === 'string' ? job.payload.version_id : ''
      if (!versionId) return
      await this.indexVersion(job.installation_id, versionId, signal,ctx?.fence)
    },

    async indexVersion(installationId: string, versionId: string, signal: AbortSignal,fence?:JobFence): Promise<void> {
      const prepared=await withCurrentVersion(installationId,versionId,async(client,row)=>{
        const document=buildSearchDocument({claimType:row.claim_type,statement:row.statement,
          structuredContent:row.structured_content??{},repositoryKey:row.repository_key,branch:row.branch})
        await client.query(`
        DELETE FROM claim_search_documents
        WHERE installation_id = $1
          AND version_id IN (
            SELECT version_id FROM knowledge_versions
            WHERE installation_id = $1 AND claim_id = $2 AND version_id <> $3
          )
      `, [installationId, row.claim_id, versionId])
        await client.query(`
        INSERT INTO claim_search_documents
          (installation_id, version_id, document, embedding_status)
        SELECT $1,$2,$3,'disabled' FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id)
        WHERE c.installation_id=$1 AND v.version_id=$2 AND ${currentClaimVersionSql()}
          AND c.state='active' AND c.consumption_hold_reason IS NULL
        ON CONFLICT (installation_id, version_id) DO UPDATE SET
          document = EXCLUDED.document,
          indexed_at = NOW()
      `, [installationId, versionId, document])
        return{document,embedAllowed:await embeddingAllowed(client,installationId,versionId)}
      },fence)
      if(!prepared?.embedAllowed)return
      // The lexical transaction may have completed before a purge/hold wins.
      // Revalidate immediately before dispatch without holding a connection
      // through the external request; an in-flight result is fenced below.
      if(!await withCurrentVersion(installationId,versionId,client=>embeddingAllowed(client,installationId,versionId),fence))return

      try {
        const embedded = await deps.embed!.embed({
          operation: 'claim_index',
          texts: [prepared.document],
          signal,
        })
        if (embedded.vectors.length !== 1) throw new Error('embedding count mismatch')
        const vector = normalize(embedded.vectors[0])
        if (vector.length !== (deps.embed?.dimensions ?? 0)) throw new Error('embedding dimension mismatch')
        await withCurrentVersion(installationId,versionId,async client=>{
          if(!await embeddingAllowed(client,installationId,versionId))return
          await client.query(`
          WITH updated AS (
          UPDATE claim_search_documents d SET
            embedding = $3::real[],
            embedding_provider = $4,
            embedding_model = $5,
            embedding_dimensions = $6,
            embedding_fingerprint = $7,
            embedding_status = 'ready'
          FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id)
          WHERE d.installation_id=$1 AND d.version_id=$2 AND c.installation_id=d.installation_id AND v.version_id=d.version_id
            AND ${currentClaimVersionSql()} AND c.state='active' AND c.consumption_hold_reason IS NULL
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
        },fence)
      } catch {
        // Retry only while the target and consent still admit indexing. A
        // failed in-flight request cannot recreate a held/deleted projection.
        const retry=await withCurrentVersion(installationId,versionId,async client=>{
          if(!await embeddingAllowed(client,installationId,versionId))return false
          await client.query(`
          UPDATE claim_search_documents SET embedding_status = 'failed'
          WHERE installation_id = $1 AND version_id = $2
        `, [installationId, versionId])
          return true
        },fence)
        if(retry)throw new Error('claim_embedding_failed')
      }
    },

    /** Rebuild: re-enqueue index jobs for every active current Version. */
    async handleRebuildClaimIndex(job: JobClaim,_signal?:AbortSignal,ctx?:{fence:JobFence}): Promise<void> {
      if (!job.installation_id) return
      const adapterFingerprint = typeof job.payload.adapter_fingerprint === 'string'
        ? job.payload.adapter_fingerprint
        : 'default'
      const client=await deps.pool.connect()
      try{
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[job.installation_id])
        const after=typeof job.payload.after_version_id==='string'?job.payload.after_version_id:null
        if(after&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(after))throw new Error('invalid_rebuild_cursor')
        const batch=await client.query<{last:string|null;n:number}>(`
        WITH eligible AS MATERIALIZED (
          SELECT c.installation_id,c.current_version_id FROM knowledge_claims c
          WHERE c.installation_id=$1 AND c.state='active' AND c.current_version_id IS NOT NULL
            AND c.consumption_hold_reason IS NULL AND ($3::uuid IS NULL OR c.current_version_id>$3)
          ORDER BY c.current_version_id LIMIT 1000 FOR SHARE OF c
        ),queued AS(
          INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
          SELECT gen_random_uuid(),c.installation_id,'index_claim_version',
            'index:'||c.current_version_id::text||':'||$2::text,90,
            jsonb_build_object('version_id',c.current_version_id::text,'adapter_fingerprint',$2::text)
          FROM eligible c WHERE NOT EXISTS(SELECT 1 FROM memory_jobs pending
            WHERE pending.installation_id=c.installation_id AND pending.job_type='index_claim_version'
              AND pending.state IN('pending','running') AND pending.payload->>'version_id'=c.current_version_id::text)
          ON CONFLICT DO NOTHING RETURNING job_id)
        SELECT MAX(current_version_id::text) AS last,count(*)::int AS n,(SELECT count(*) FROM queued) AS queued FROM eligible`,
        [job.installation_id,adapterFingerprint,after])
        const page=batch.rows[0]
        if(page?.n===1000&&page.last)await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
          VALUES(gen_random_uuid(),$1,'rebuild_claim_index',$2,95,$3::jsonb) ON CONFLICT DO NOTHING`,
          [job.installation_id,`rebuild:${adapterFingerprint}:after:${page.last}`,JSON.stringify({adapter_fingerprint:adapterFingerprint,after_version_id:page.last})])
        if(ctx?.fence)await assertJobFence(client,ctx.fence)
        await client.query('COMMIT')
      }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    },

    /** On adapter change enqueue one bounded rebuild; never mix adapter ranks. */
    async enqueueRebuildIfModelChanged(
      installationId: string,
      configured: { provider: string; model: string; dimensions: number; fingerprint: string },
    ): Promise<boolean> {
      const mismatch = await deps.pool.query(`
        SELECT 1 FROM claim_search_documents d
        JOIN knowledge_versions v USING(installation_id,version_id)
        JOIN knowledge_claims c USING(installation_id,claim_id)
        WHERE d.installation_id = $1 AND c.state='active' AND ${currentClaimVersionSql()} AND c.consumption_hold_reason IS NULL
          AND d.embedding_status = 'ready'
          AND (d.embedding_provider IS DISTINCT FROM $2
            OR d.embedding_model IS DISTINCT FROM $3
            OR d.embedding_dimensions IS DISTINCT FROM $4
            OR d.embedding_fingerprint IS DISTINCT FROM $5)
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
    FROM memory_feature_settings WHERE installation_id = $1 FOR SHARE
  `, [installationId])
  const mode = result.rows[0]?.embedding_mode
  if (requiredConsentFingerprint
    && result.rows[0]?.embedding_consent_fingerprint !== requiredConsentFingerprint) return 'off'
  return mode === 'shadow' || mode === 'enabled' ? mode : 'off'
}

export type ClaimIndexer = ReturnType<typeof createClaimIndexer>
