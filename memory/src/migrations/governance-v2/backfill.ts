import {createHash,randomUUID} from 'node:crypto'
import type pg from 'pg'
import {automationHash} from '../../governance/automation-policy.js'
import {resolveClaimApplicability} from '../../claims/identity-writer.js'
import {claimIdentityV2,claimDuplicateDigestV2} from '../../claims/identity.js'
import {MEMORY_MIGRATIONS} from '../../schema.js'
import {encodeMigrationBaseline} from './baseline-snapshot.js'

// Body/authority/history tables are observed, not rewritten to fabricate proof.
export const BACKFILL_FAMILIES=Object.freeze([
 'knowledge_claims','knowledge_versions','knowledge_evidence','knowledge_evidence_capsules',
 'memory_candidates','memory_promotion_candidates','memory_promotion_candidate_versions','memory_promotion_evidence',
 'memory_authority_records','memory_review_policy_versions','memory_review_policy_heads','memory_review_decisions',
 'memory_jobs','source_events','source_artifacts','work_episodes','knowledge_tombstones','memory_scope_tombstones',
 'memory_wiki_versions','memory_wiki_source_bindings','memory_skill_versions','memory_skill_archive_sources',
 'memory_git_claim_authority','memory_git_snapshot_sources',
 'memory_governance_executor_principals','memory_automation_authority_records','memory_publication_delegations',
 'memory_review_automation_policy_heads','memory_review_automation_policies','memory_review_automation_runs','memory_review_automation_decisions',
])
export async function migrationTransaction<T>(pool:pg.Pool,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();let failed=false
 const onError=()=>{failed=true};c.on?.('error',onError)
 try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'; SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'");const r=await fn(c);await c.query('COMMIT');return r}
 catch(e){failed=true;await c.query('ROLLBACK').catch(()=>undefined);throw e}
 finally{if(!failed)c.removeListener?.('error',onError);c.release(failed)}
}
export interface MigrationBaseline {installationIds:string[];rows:Record<string,Record<string,string>>;owners:Record<string,Record<string,string[]>>;startWatermark:string;createdAt:string}
export async function migrationRows(c:Pick<pg.PoolClient,'query'>,table:string,installationIds:string[],after='',limit=200){
 if(!BACKFILL_FAMILIES.includes(table))throw new Error('unknown_migration_family')
 const attributes=(await c.query(`SELECT a.attname,a.atttypid='uuid'::regtype AS uuid_key FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attnum`,[table])).rows
 const pk=attributes.map(r=>r.attname as string)
 if(!pk.length)throw new Error('migration_primary_key_required')
 const ident=(name:string)=>'"'+name.replace(/"/g,'""')+'"'
 const key=`jsonb_build_array(${pk.map(k=>`t.${ident(k)}::text`).join(',')})::text`
 // These source families are directly installation-owned in every supported
 // schema. Avoid converting large payloads to JSON merely to find that owner;
 // the native predicate also gives the planner accurate scope selectivity.
 const directSource=['source_events','source_artifacts','work_episodes'].includes(table)
 const scope=directSource?`t.installation_id=ANY($3::uuid[])`:table==='memory_promotion_candidates'?`t.target_installation_id=ANY($3::uuid[])`:table==='memory_review_automation_decisions'?`EXISTS(SELECT 1 FROM memory_review_automation_runs r WHERE r.run_id=t.run_id AND r.installation_id=ANY($3::uuid[]))`:table==='memory_review_automation_policy_heads'?`t.installation_id=ANY($3::uuid[])`:`memory_governance_change_scopes($2,to_jsonb(t))&&$3::uuid[]`
 // Canonical UUID byte order equals the existing C-collated JSON-string
 // cursor order. Keep checkpoint IDs unchanged, but let PostgreSQL use the
 // primary key instead of sorting every row's JSON body on every page.
 let uuidCursor:string|null=null,uuidPage=attributes.length===1&&attributes[0].uuid_key===true
 if(uuidPage&&after){
  try{const parsed=JSON.parse(after);uuidPage=Array.isArray(parsed)&&parsed.length===1&&typeof parsed[0]==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed[0])&&JSON.stringify(parsed)===after;if(uuidPage)uuidCursor=parsed[0]}catch{uuidPage=false}
 }
 if(uuidPage){
  const column=`t.${ident(pk[0])}`
  return (await c.query(`SELECT ${key} AS id,to_jsonb(t) AS row FROM ${ident(table)} t WHERE ($1::text='' OR ${column}>$5::uuid) AND ${scope} AND $2::text IS NOT NULL ORDER BY ${column} LIMIT $4`,[after,table,installationIds,limit,uuidCursor])).rows as {id:string;row:Record<string,any>}[]
 }
 const rows=(await c.query(`SELECT ${key} AS id,to_jsonb(t) AS row FROM ${ident(table)} t WHERE (${key} COLLATE "C")>($1 COLLATE "C") AND ${scope} AND $2::text IS NOT NULL ORDER BY ${key} COLLATE "C" LIMIT $4`,[after,table,installationIds,limit])).rows as {id:string;row:Record<string,any>}[]
 return rows
}
function preservedBody(table:string,row:Record<string,unknown>){
 // The original body, evidence hashes, facts, IDs and authority never change.
 const omit=table==='knowledge_claims'?['identity_generation','normalized_key_v2','topic_key_v2','duplicate_digest_v2','canonical_repository_key','consumption_hold_reason','revision','updated_at']
  :table==='knowledge_versions'?['applicability','effective_from','effective_until']:table==='memory_jobs'?['state','claimed_by','claim_epoch','claim_expires_at','last_error_code','updated_at','started_at','completed_at']:[]
 return Object.fromEntries(Object.entries(row).filter(([key])=>!omit.includes(key)))
}
export async function captureMigrationBaseline(c:Pick<pg.PoolClient,'query'>,installationIds:string[]):Promise<MigrationBaseline>{
 const rows:MigrationBaseline['rows']={},owners:MigrationBaseline['owners']={}
 for(const table of BACKFILL_FAMILIES){rows[table]={};owners[table]={};let after='';while(true){const batch=await migrationRows(c,table,installationIds,after);for(const r of batch){rows[table][r.id]=automationHash(preservedBody(table,r.row));owners[table][r.id]=r.row.installation_id?[r.row.installation_id]:r.row.target_installation_id?[r.row.target_installation_id]:(await c.query('SELECT memory_governance_change_scopes($1,$2::jsonb) ids',[table,r.row])).rows[0].ids;}if(batch.length<200)break;after=batch.at(-1)!.id}}
 return {installationIds,rows,owners,startWatermark:(await c.query('SELECT COALESCE(MAX(sequence),0)::text n FROM memory_governance_migration_changes')).rows[0].n,createdAt:(await c.query('SELECT clock_timestamp()::text n')).rows[0].n}
}
export async function governanceEnvironmentFingerprint(pool:Pick<pg.Pool,'query'>){
 const identity=(await pool.query('SELECT current_database() AS db,current_user AS role,version() AS version,inet_server_addr()::text AS server,pg_postmaster_start_time()::text AS started')).rows[0]
 return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
export async function startGovernanceBackfill(pool:pg.Pool,input:{installationIds:string[];environmentFingerprint:string}):Promise<string>{
 if(await governanceEnvironmentFingerprint(pool)!==input.environmentFingerprint)throw new Error('migration_environment_mismatch')
 if(!input.installationIds.length||input.installationIds.length>100||!input.environmentFingerprint)throw new Error('explicit_migration_scope_required')
 return migrationTransaction(pool,async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  const version=Number((await c.query('SELECT MAX(version) n FROM memory_schema_migrations')).rows[0].n)
  if(version!==Math.max(...MEMORY_MIGRATIONS.map(m=>m.version)))throw new Error('migration_schema_incompatible')
  for(const id of [...input.installationIds].sort()){
   if((await c.query("SELECT 1 FROM memory_governance_v2_states WHERE installation_id=$1 AND phase IN('hold','cutover')",[id])).rowCount)throw new Error('migration_scope_held')
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[id])
   if(!(await c.query('SELECT 1 FROM memory_installations WHERE installation_id=$1',[id])).rowCount)throw new Error('installation_missing')
   await c.query(`INSERT INTO memory_governance_v2_states(installation_id,phase,writer_floor) VALUES($1,'bridge','identity_v2') ON CONFLICT(installation_id) DO UPDATE SET phase=CASE WHEN memory_governance_v2_states.identity_generation=2 THEN 'active' ELSE 'bridge' END,writer_floor='identity_v2',generation=memory_governance_v2_states.generation+1`,[id])
  }
  const manifest=await captureMigrationBaseline(c,input.installationIds),runId=randomUUID()
  await c.query(`INSERT INTO memory_governance_migration_runs(run_id,environment_fingerprint,schema_version,manifest,state) VALUES($1,$2,$3,$4,'running')`,[runId,input.environmentFingerprint,version,encodeMigrationBaseline(manifest)]);return runId
 })
}
export async function recordMigrationAction(c:pg.PoolClient,input:{runId:string;installationId:string;table:string;id:string;row:Record<string,any>;action:'updated'|'unchanged'|'quarantined'|'retry';reason:string;afterHash?:string}){
 const hash=automationHash(input.row)
 await c.query(`INSERT INTO memory_governance_migration_actions(run_id,installation_id,entity_kind,entity_id,source_revision,action,reason,change_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[input.runId,input.installationId,input.table,`${input.id}:${hash}:${input.action}:${input.reason}:${input.afterHash??hash}`,String(input.row.revision??input.row.version_number??input.row.revision_number??0),input.action,input.reason,{sourceHash:hash,afterHash:input.afterHash??hash,recordId:input.id}])
}
export async function backfillClaim(c:pg.PoolClient,runId:string,installationId:string,id:string,observed:Record<string,any>){
 const current=(await c.query('SELECT to_jsonb(c) AS row FROM knowledge_claims c WHERE installation_id=$1 AND claim_id=$2 FOR UPDATE',[installationId,observed.claim_id])).rows[0]?.row
 if(!current){await recordMigrationAction(c,{runId,installationId,table:'knowledge_claims',id,row:observed,action:'unchanged',reason:'deleted_during_scan'});return}
 if(automationHash(current)!==automationHash(observed)){await recordMigrationAction(c,{runId,installationId,table:'knowledge_claims',id,row:observed,action:'retry',reason:'revision_cas_conflict',afterHash:automationHash(current)});return}
 const versions=(await c.query('SELECT to_jsonb(v) AS row FROM knowledge_versions v WHERE installation_id=$1 AND claim_id=$2 ORDER BY version_number FOR UPDATE',[installationId,current.claim_id])).rows.map(r=>r.row)
 const v=versions.find(r=>r.version_id===current.current_version_id)
 let reason=current.consumption_hold_reason??null,projection:{key:string;topicKey:string;duplicate:string;canonical:string|null}|null=null
 if(!v)reason='historical_current_pointer_unproven'
 else{
  const applicability=await resolveClaimApplicability(c,{installationId,scopeKind:current.scope_kind,scopeKey:current.scope_key,repositoryId:v.repository_id,snapshotId:v.repo_snapshot_id,branch:v.branch})
  try{const frame={...applicability,claimType:current.claim_type,statement:v.statement,structuredContent:v.structured_content,validFrom:v.valid_from,validUntil:v.valid_until};const identity=claimIdentityV2(frame);projection={key:identity.key,topicKey:identity.topicKey,duplicate:claimDuplicateDigestV2(frame),canonical:applicability.canonicalRepositoryKey}}catch{reason??='historical_repository_mapping_unproven'}
  // Historical approval records remain history, not reconstructed authority.
  if(!['user_accepted','user_corrected'].includes(v.authority))reason??='historical_authority_requires_review'
  if(!(await c.query('SELECT 1 FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2 LIMIT 1',[installationId,v.version_id])).rowCount)reason??='historical_evidence_unproven'
  if((await c.query('SELECT 1 FROM knowledge_tombstones WHERE installation_id=$1 LIMIT 1',[installationId])).rowCount)reason??='historical_tombstone_keyring_requires_review'
  const time=(await c.query(`SELECT NOT EXISTS(SELECT 1 FROM(SELECT version_number,created_at,lag(created_at) OVER(ORDER BY version_number) AS prior FROM knowledge_versions WHERE installation_id=$1 AND claim_id=$2)x WHERE prior IS NOT NULL AND created_at<=prior) AS valid`,[installationId,current.claim_id])).rows[0].valid
  if(!time)reason??='historical_interval_requires_review'
  if(time)for(const historical of versions){
   const app=await resolveClaimApplicability(c,{installationId,scopeKind:current.scope_kind,scopeKey:current.scope_key,repositoryId:historical.repository_id,snapshotId:historical.repo_snapshot_id,branch:historical.branch})
   const changed=(await c.query(`WITH ordered AS(SELECT version_id,created_at,lead(created_at) OVER(ORDER BY version_number) AS next FROM knowledge_versions WHERE installation_id=$1 AND claim_id=$2) UPDATE knowledge_versions v SET effective_from=o.created_at,effective_until=o.next,applicability=COALESCE(v.applicability,$4::jsonb) FROM ordered o WHERE v.version_id=o.version_id AND v.version_id=$3 AND v.effective_from IS NULL RETURNING to_jsonb(v) AS row`,[installationId,current.claim_id,historical.version_id,app])).rows[0]?.row
   if(changed)await recordMigrationAction(c,{runId,installationId,table:'knowledge_versions',id:JSON.stringify([historical.version_id]),row:historical,action:'updated',reason:'ordered_record_time_projection',afterHash:automationHash(changed)})
  }
  if(projection&&(await c.query(`SELECT 1 FROM knowledge_claims WHERE installation_id=$1 AND claim_id<>$2 AND state='active' AND duplicate_digest_v2=$3 AND conflict_variant=$4 LIMIT 1`,[installationId,current.claim_id,projection.duplicate,current.conflict_variant])).rowCount){reason??='historical_identity_collision';projection=null}
 }
 const values={...current,identity_generation:projection?2:current.identity_generation,normalized_key_v2:projection?.key??current.normalized_key_v2,topic_key_v2:projection?.topicKey??current.topic_key_v2,duplicate_digest_v2:projection?.duplicate??current.duplicate_digest_v2,canonical_repository_key:projection?.canonical??current.canonical_repository_key,consumption_hold_reason:reason}
 let changed:any=current
 if(automationHash(values)!==automationHash(current))changed=(await c.query(`UPDATE knowledge_claims SET identity_generation=$3,normalized_key_v2=$4,topic_key_v2=$5,duplicate_digest_v2=$6,canonical_repository_key=$7,consumption_hold_reason=$8,revision=revision+1,updated_at=clock_timestamp() WHERE installation_id=$1 AND claim_id=$2 AND revision=$9 RETURNING to_jsonb(knowledge_claims) AS row`,[installationId,current.claim_id,values.identity_generation,values.normalized_key_v2,values.topic_key_v2,values.duplicate_digest_v2,values.canonical_repository_key,reason,current.revision])).rows[0]?.row
 if(!changed)throw new Error('migration_cas_lost')
 await c.query(`UPDATE memory_governance_migration_actions SET change_summary=jsonb_set(change_summary,'{resolved_by}',$4::jsonb) WHERE run_id=$1 AND installation_id=$2 AND entity_kind='knowledge_claims' AND action='retry' AND change_summary->>'recordId'=$3`,[runId,installationId,id,JSON.stringify(automationHash(changed))])
 await recordMigrationAction(c,{runId,installationId,table:'knowledge_claims',id,row:current,action:reason?'quarantined':automationHash(current)===automationHash(changed)?'unchanged':'updated',reason:reason??'verified_identity_projection',afterHash:automationHash(changed)})
}
export async function backfillGovernance(pool:pg.Pool,input:{runId:string;batchSize?:number;interruptAfterBatch?:number}){
 const size=Math.min(200,Math.max(1,input.batchSize??200)),run=(await pool.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[input.runId])).rows[0]
 if(!run)throw new Error('migration_run_missing')
 const ids=(run.manifest as MigrationBaseline).installationIds;let batches=0,processed=0
 for(const installationId of ids)for(const table of BACKFILL_FAMILIES){
  while(true){const n=await migrationTransaction(pool,async c=>{
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[installationId])
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('migration:'||$1,0))",[installationId])
   const cp=(await c.query('SELECT last_id FROM memory_governance_migration_checkpoints WHERE run_id=$1 AND installation_id=$2 AND entity_kind=$3 FOR UPDATE',[input.runId,installationId,table])).rows[0]
   const rows=await migrationRows(c,table,[installationId],cp?.last_id??'',size)
   for(const r of rows){if(table==='knowledge_claims')await backfillClaim(c,input.runId,installationId,r.id,r.row);else await recordMigrationAction(c,{runId:input.runId,installationId,table,id:r.id,row:r.row,action:'unchanged',reason:'retained_immutable_history'})}
   if(rows.length)await c.query(`INSERT INTO memory_governance_migration_checkpoints(run_id,installation_id,entity_kind,last_id) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,installation_id,entity_kind) DO UPDATE SET last_id=$4,updated_at=clock_timestamp()`,[input.runId,installationId,table,rows.at(-1)!.id])
   return rows.length
  });processed+=n;if(!n)break;batches++
   if(input.interruptAfterBatch&&batches===input.interruptAfterBatch){await pool.query("UPDATE memory_governance_migration_runs SET state='interrupted' WHERE run_id=$1",[input.runId]);return {interrupted:true,batches,processed}}
   if(n<size)break
  }
 }
 await pool.query("UPDATE memory_governance_migration_runs SET state='running' WHERE run_id=$1",[input.runId]);return {interrupted:false,batches,processed}
}
export {preservedBody}
