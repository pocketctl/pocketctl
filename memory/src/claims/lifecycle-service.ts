import {currentClaimVersionSql} from './version-selection.js'
import type pg from 'pg'
import type { ClaimRepository } from './repository.js'
import {evaluateClaimLifecycle} from './lifecycle-evaluator.js'
import type {LifecycleMode,LifecycleFacts} from './lifecycle-policy.js'
import {requireCurrentScopePermission,assertCurrentGrantClock,type V2GrantFacts} from '../governance/authorization.js'
import {contextClaimFacts,eligibleContextFacts,type ContextQueryFrame} from '../context/consumption.js'
import {lifecycleObservationAvailableSql} from './lifecycle-observation.js'

/**
 * Claim lifecycle: correct (immutable Version N+1), expire, revoke, supersede
 * — plus the idempotent `expire_claims` maintenance pass driven by the
 * database clock and registered in the worker.
 */
export function createLifecycleService(pool: pg.Pool, claims: ClaimRepository, options:{lifecycleMode?:LifecycleMode}={}) {
  return {
    correctClaim: claims.correctClaim.bind(claims) as typeof claims.correctClaim,
    expireClaim: (input: Omit<Parameters<ClaimRepository['transitionClaim']>[0], 'target'>) =>
      claims.transitionClaim({ ...input, target: 'expired' }),
    revokeClaim: (input: Omit<Parameters<ClaimRepository['transitionClaim']>[0], 'target'>) =>
      claims.transitionClaim({ ...input, target: 'revoked' }),
    supersedeClaim: claims.supersedeClaim.bind(claims) as typeof claims.supersedeClaim,

    async evaluateDueClaims(input:{limit?:number}={}):Promise<{evaluated:number;cooled:number;reclaimEligible:number}> {
      const counts={evaluated:0,cooled:0,reclaimEligible:0}
      if(!options.lifecycleMode||options.lifecycleMode==='off')return counts
      const limit=input.limit??100
      if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('invalid_lifecycle_batch')
      const ids=(await pool.query(`SELECT l.installation_id,l.claim_id FROM memory_claim_lifecycle l
        JOIN memory_curation_policies p ON p.installation_id=l.installation_id
        WHERE l.next_evaluate_at<=clock_timestamp() AND p.cold_mode<>'off'
        ORDER BY l.next_evaluate_at,l.installation_id,l.claim_id LIMIT $1`,[limit])).rows
      for(const id of ids){
        const client=await pool.connect()
        try{
          await client.query('BEGIN')
          if(options.lifecycleMode==='enabled')await lockLifecycleScope(client,id.installation_id)
          else await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[id.installation_id])
          const row=(await client.query(`SELECT l.*,CASE WHEN ${lifecycleObservationAvailableSql()} THEN l.observation_state ELSE 'unknown' END AS observation_state,c.state,c.created_at,c.consumption_hold_reason,v.authority,v.valid_until,
            p.cold_mode,p.reclaim_mode,clock_timestamp() AS now,
            memory_delivery_version_available(v.installation_id,v.version_id) AS source_available,
            v.version_id FROM memory_claim_lifecycle l JOIN knowledge_claims c USING(installation_id,claim_id)
            JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
            JOIN memory_curation_policies p ON p.installation_id=c.installation_id
            JOIN memory_installations i ON i.installation_id=c.installation_id JOIN memory_owner_scopes s ON s.installation_id=c.installation_id
            WHERE l.installation_id=$1 AND l.claim_id=$2 AND l.next_evaluate_at<=clock_timestamp()
             AND i.local_status='ready' AND i.relay_status='active' AND s.state='active' AND s.owner_scope_kind='personal'
            FOR UPDATE OF c,l FOR SHARE OF p,s,i`,[id.installation_id,id.claim_id])).rows[0]
          if(!row){await client.query('COMMIT');continue}
          const decision=evaluateClaimLifecycle(lifecycleFacts(row,options.lifecycleMode))
          counts.evaluated++
          if(options.lifecycleMode==='enabled'){
            if(decision.action==='cool'&&!row.consumption_hold_reason){
              await client.query(`UPDATE memory_claim_lifecycle SET storage_tier='cold',cold_since=clock_timestamp(),revision=revision+1,next_evaluate_at=$3 WHERE installation_id=$1 AND claim_id=$2`,[id.installation_id,id.claim_id,decision.nextEvaluateAt])
              await client.query(`DELETE FROM claim_search_documents WHERE installation_id=$1 AND version_id IN(SELECT version_id FROM knowledge_versions WHERE installation_id=$1 AND claim_id=$2)`,[id.installation_id,id.claim_id])
              await client.query(`INSERT INTO memory_lifecycle_maintenance_receipts(installation_id,claim_id,version_id,action,lifecycle_revision) VALUES($1,$2,$3,'cool',$4)`,[id.installation_id,id.claim_id,row.version_id,Number(row.revision)+1])
              counts.cooled++
            }else{
              // Explicit expiry remains in the existing worker path. This pass
              // never turns validity failures into value-based deletion.
              await client.query('UPDATE memory_claim_lifecycle SET next_evaluate_at=$3 WHERE installation_id=$1 AND claim_id=$2',[id.installation_id,id.claim_id,decision.nextEvaluateAt])
              if(decision.action==='reclaim_eligible')counts.reclaimEligible++
            }
          }
          await client.query('COMMIT')
        }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e}finally{client.release()}
      }
      return counts
    },

    /** One explicitly requested Claim, not a project-wide thaw. Permission,
     * source, validity and applicability are rechecked inside the transaction. */
    async reactivateClaim(input:{installationId:string;claimId:string;expectedRevision:number;grant:V2GrantFacts;frame:ContextQueryFrame}):Promise<boolean>{
      if(options.lifecycleMode!=='enabled')throw new Error('lifecycle_disabled')
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        const binding=await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:input.installationId,permission:'contribute'})
        if(binding.owner_scope_kind!=='personal')throw new Error('personal_scope_required')
        await lockLifecycleScope(client,input.installationId)
        const row=(await client.query(`SELECT l.*,c.state,c.scope_kind,c.scope_key,c.canonical_repository_key,c.consumption_hold_reason,
          v.version_id,v.applicability,v.repository_id,v.repo_snapshot_id,v.branch,v.valid_from,v.valid_until,
          v.body_state AS version_body_state,
          memory_delivery_version_available(v.installation_id,v.version_id) AS source_available,
          ((v.valid_from IS NULL OR v.valid_from<=clock_timestamp()) AND(v.valid_until IS NULL OR v.valid_until>clock_timestamp())) AS valid,
          EXISTS(SELECT 1 FROM knowledge_evidence e WHERE e.installation_id=v.installation_id AND e.version_id=v.version_id) AS has_evidence,
          (NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=v.installation_id AND t.repository_id=v.repository_id)
           AND NOT EXISTS(SELECT 1 FROM repo_snapshots s JOIN memory_source_snapshot_tombstones t USING(installation_id,repository_id,commit_sha) WHERE s.installation_id=v.installation_id AND s.repo_snapshot_id=v.repo_snapshot_id)
           AND NOT EXISTS(SELECT 1 FROM memory_logical_claims m JOIN memory_logical_tombstones t USING(installation_id,logical_key) WHERE m.installation_id=c.installation_id AND m.claim_id=c.claim_id)) AS repository_available
          FROM memory_claim_lifecycle l JOIN knowledge_claims c USING(installation_id,claim_id)
          JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
          JOIN memory_curation_policies p ON p.installation_id=c.installation_id
          WHERE l.installation_id=$1 AND l.claim_id=$2 AND p.cold_mode='enabled' FOR UPDATE OF c,l FOR SHARE OF v,p`,[input.installationId,input.claimId])).rows[0]
        if(!row||Number(row.revision)!==input.expectedRevision)throw new Error('lifecycle_conflict')
        const facts=(await contextClaimFacts(client,input.installationId,[row.version_id])).get(row.version_id)
        // Reuse the ordinary consumer's source, scene and origin authority
        // checks, changing only the tier being explicitly requested here.
        const applicable=!!facts&&eligibleContextFacts({...facts,lifecycle:facts.lifecycle?{...facts.lifecycle,hot:true}:undefined},input.frame)
        if(row.state!=='active'||row.body_state!=='present'||row.version_body_state!=='present'||!row.valid||!row.source_available||!row.has_evidence||!row.repository_available||!applicable)throw new Error('lifecycle_reactivation_unavailable')
        if(row.storage_tier==='hot'){await client.query('COMMIT');return false}
        await client.query(`UPDATE memory_claim_lifecycle SET storage_tier='hot',cold_since=NULL,last_confirmed_at=clock_timestamp(),next_evaluate_at=clock_timestamp()+interval '90 days',revision=revision+1 WHERE installation_id=$1 AND claim_id=$2`,[input.installationId,input.claimId])
        await client.query(`INSERT INTO memory_lifecycle_maintenance_receipts(installation_id,claim_id,version_id,action,lifecycle_revision) VALUES($1,$2,$3,'reactivate',$4)`,[input.installationId,input.claimId,row.version_id,Number(row.revision)+1])
        await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload) VALUES(gen_random_uuid(),$1,'index_claim_version',$2,90,$3::jsonb) ON CONFLICT DO NOTHING`,[input.installationId,`lifecycle-reactivate:${input.claimId}:${Number(row.revision)+1}`,JSON.stringify({version_id:row.version_id})])
        await assertCurrentGrantClock(client,input.grant,[input.installationId])
        await client.query('COMMIT');return true
      }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e}finally{client.release()}
    },

    /**
     * Database-clock expiry sweep: any active claim whose current version's
     * valid_until passed NOW() expires. Idempotent, removes the search
     * projection, records feedback, never mutates the immutable version.
     */
    async expireDueClaims(): Promise<number> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Discover without holding Claims; a purge owns generation/outbox
          // rows first. Lock the complete installation set before domain rows,
          // then recheck eligibility on this bounded batch after every wait.
          const observed = await client.query<{ claim_id: string; installation_id: string }>(`
            SELECT c.claim_id::text, c.installation_id::text
            FROM knowledge_claims c
            JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id = c.current_version_id
            WHERE c.state = 'active' AND ${currentClaimVersionSql()}
              AND v.valid_until IS NOT NULL
              AND v.valid_until <= NOW()
            ORDER BY c.claim_id
            LIMIT 500
          `)
          const installationIds=[...new Set(observed.rows.map(row=>row.installation_id))].sort()
          for(const id of installationIds)await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`,[id])
          const due=await client.query<{claim_id:string}>(`
            SELECT c.claim_id::text FROM knowledge_claims c
            JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
            WHERE c.claim_id=ANY($1::uuid[]) AND c.state='active' AND ${currentClaimVersionSql()}
              AND v.valid_until IS NOT NULL AND v.valid_until<=clock_timestamp()
            ORDER BY c.installation_id,c.claim_id FOR UPDATE OF c
          `,[observed.rows.map(row=>row.claim_id)])
          let expired = 0
          for (const row of due.rows) {
            await client.query(`
              UPDATE knowledge_claims SET state = 'expired', revision = revision + 1, updated_at = NOW()
              WHERE claim_id = $1 AND state = 'active'
            `, [row.claim_id])
            await client.query(`
              DELETE FROM claim_search_documents
              WHERE version_id IN (
                SELECT version_id FROM knowledge_versions
                WHERE claim_id = $1
              )
            `, [row.claim_id])
            await client.query(`
              INSERT INTO memory_feedback (feedback_id, installation_id, claim_id, version_id, action)
              SELECT gen_random_uuid(), c.installation_id, c.claim_id, c.current_version_id, 'claim_expired'
              FROM knowledge_claims c WHERE c.claim_id = $1
            `, [row.claim_id])
            expired++
          }
          await client.query('COMMIT')
          return expired
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

export type LifecycleService = ReturnType<typeof createLifecycleService>

export async function lockLifecycleScope(client:pg.PoolClient,installationId:string):Promise<void>{
 await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[installationId])
 await client.query('INSERT INTO memory_scope_consumption_generations(installation_id) VALUES($1) ON CONFLICT DO NOTHING',[installationId])
 await client.query('SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=$1 FOR UPDATE',[installationId])
}
export function lifecycleFacts(r:Record<string,any>,mode:LifecycleMode='off'):LifecycleFacts{
 return {now:r.now,createdAt:r.created_at,validUntil:r.valid_until,state:r.state,sourceAvailable:r.source_available,authority:r.authority,
  kind:r.kind,protection:r.protection,storageTier:r.storage_tier,bodyState:r.body_state,coldSince:r.cold_since,lastConfirmedAt:r.last_confirmed_at,
  lastDeliveredAt:r.last_delivered_at,lastConfirmedUseAt:r.last_confirmed_use_at,observationState:r.observation_state,observationStartedAt:r.observation_started_at,
  valueAssessment:r.value_assessment,coldMode:mode==='enabled'?r.cold_mode:mode,reclaimMode:mode==='enabled'?r.reclaim_mode:mode}
}
