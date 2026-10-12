import type pg from 'pg'
import {createTransactionBoundPool} from '../../api/transaction-bound-pool.js'
import {migrationTransaction,type MigrationBaseline} from './backfill.js'
import {validateGovernanceMigration} from './validate.js'
import {reconcileGovernanceChanges} from './reconcile.js'
export async function ensureGovernanceIndexes(pool:pg.Pool){
 const specs=[{name:'knowledge_claims_active_identity_v1_idx',columns:'installation_id,claim_type,scope_key,normalized_key,conflict_variant',generation:1},{name:'knowledge_claims_active_identity_v2_idx',columns:'installation_id,duplicate_digest_v2,conflict_variant',generation:2}]
 for(const s of specs){
  const row=(await pool.query(`SELECT i.indisvalid,i.indisunique,i.indnkeyatts,i.indnatts,i.indrelid='knowledge_claims'::regclass AS target,i.indnullsnotdistinct,am.amname,
    pg_get_expr(i.indpred,i.indrelid) predicate,ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true) FROM generate_series(1,i.indnkeyatts) n) keys
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam WHERE i.indexrelid=to_regclass($1)`,[s.name])).rows[0]
  const normalize=(v:string)=>v.replace(/::text/g,'').replace(/[()\s]/g,'')
  if(row&&(!row.indisvalid||!row.indisunique||!row.target||row.amname!=='btree'||row.indnullsnotdistinct||row.indnkeyatts!==s.columns.split(',').length||row.indnatts!==row.indnkeyatts||row.keys.join(',')!==s.columns||normalize(row.predicate??'')!==`state='active'ANDidentity_generation=${s.generation}`))throw new Error('index_build_failed')
  if(!row)try{await pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${s.name} ON knowledge_claims(${s.columns}) WHERE state='active' AND identity_generation=${s.generation}`)}catch{throw new Error('index_build_failed')}
 }
}
export async function cutoverGovernance(pool:pg.Pool,input:{runId:string;installationId:string;writerProof:string[]}){
 if(!['api:identity_v2','worker:identity_v2','relay:identity_v2'].every(w=>input.writerProof.includes(w)))throw new Error('writer_proof_required')
 const run=(await pool.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[input.runId])).rows[0]
 if(!(run?.manifest as MigrationBaseline)?.installationIds.includes(input.installationId))throw new Error('migration_scope_mismatch')
 await ensureGovernanceIndexes(pool);await reconcileGovernanceChanges(pool,{runId:input.runId})
 const validation=await validateGovernanceMigration(pool,input.runId);if(validation.violations.length)throw new Error('migration_validation_failed')
 await migrationTransaction(pool,async c=>{
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
  const scope=(await c.query(`SELECT 1 FROM memory_installations i JOIN memory_owner_scopes s USING(installation_id) WHERE i.installation_id=$1 AND i.local_status NOT IN('purging','purged','integrity_error') AND i.relay_status='active' AND s.state='active' FOR SHARE OF i,s`,[input.installationId])).rows[0]
  if(!scope)throw new Error('migration_scope_stale')
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-jobs:claim',0))")
  await c.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND state='running' ORDER BY job_id FOR UPDATE NOWAIT",[input.installationId])
  // Resource tables before control rows, all NOWAIT, avoid row/table inversion.
  // Source/control Feed ingress is outside this short barrier.
  await c.query('LOCK TABLE knowledge_claims,knowledge_versions,knowledge_evidence,memory_candidates,memory_promotion_candidates,memory_promotion_candidate_versions,memory_review_decisions,memory_authority_records,memory_review_policy_heads,memory_review_automation_policies,memory_review_automation_policy_heads,memory_review_automation_runs,memory_review_automation_decisions,memory_governance_executor_principals,memory_automation_authority_records,memory_publication_delegations IN ACCESS EXCLUSIVE MODE NOWAIT')
  const bound=createTransactionBoundPool(c)
  await reconcileGovernanceChanges(bound,{runId:input.runId})
  const final=await validateGovernanceMigration(bound,input.runId)
  if(final.violations.length)throw new Error('migration_validation_failed')
  await c.query('SELECT 1 FROM memory_governance_v2_states WHERE installation_id=$1 FOR UPDATE',[input.installationId])
  const dirty=await c.query(`SELECT 1 FROM knowledge_claims WHERE installation_id=$1 AND state='active' AND consumption_hold_reason IS NULL AND (identity_generation<>2 OR normalized_key_v2 IS NULL OR topic_key_v2 IS NULL OR duplicate_digest_v2 IS NULL) LIMIT 1`,[input.installationId]);if(dirty.rowCount)throw new Error('migration_overlap_required')
  await c.query(`UPDATE memory_jobs SET state='dead',claim_epoch=claim_epoch+1,claimed_by=NULL,claim_expires_at=NULL,last_error_code='migration_cutover_fenced' WHERE installation_id=$1 AND state='running'`,[input.installationId])
  await c.query('DROP INDEX IF EXISTS knowledge_claims_active_identity_variant_idx')
  await c.query(`UPDATE memory_governance_v2_states SET identity_generation=2,phase='active',writer_floor='identity_v2',generation=generation+1,updated_at=clock_timestamp() WHERE installation_id=$1`,[input.installationId])
  await c.query(`UPDATE memory_governance_migration_runs SET manifest=jsonb_set(manifest,'{writerProof}',$2::jsonb) WHERE run_id=$1`,[input.runId,JSON.stringify(input.writerProof)])
 })
 return validateGovernanceMigration(pool,input.runId)
}
