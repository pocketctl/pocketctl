import type pg from 'pg'
import {migrationTransaction,backfillClaim,recordMigrationAction,BACKFILL_FAMILIES,type MigrationBaseline} from './backfill.js'
/** Replay the complete overlap after the starting watermark. Sequence allocation
 * is not commit order: the final pass runs after the writer barrier, not from an
 * optimistic previous MAX(sequence). No source/authority body is resurrected. */
export async function reconcileGovernanceChanges(pool:pg.Pool,input:{runId:string}){
 const run=(await pool.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[input.runId])).rows[0]
 if(!run)throw new Error('migration_run_missing')
 const m=run.manifest as MigrationBaseline;let after=m.startWatermark,processed=0
 while(true){const batch=(await pool.query(`SELECT * FROM memory_governance_migration_changes WHERE installation_id=ANY($1::uuid[]) AND sequence>$2 ORDER BY sequence LIMIT 200`,[m.installationIds,after])).rows
  for(const change of batch){await migrationTransaction(pool,async c=>{
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[change.installation_id])
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('migration:'||$1,0))",[change.installation_id])
   const key=JSON.parse(change.entity_id)
   if(change.entity_kind==='knowledge_claims'&&key.claim_id){const row=(await c.query('SELECT to_jsonb(c) row FROM knowledge_claims c WHERE installation_id=$1 AND claim_id=$2',[change.installation_id,key.claim_id])).rows[0]?.row;if(row)await backfillClaim(c,input.runId,change.installation_id,JSON.stringify([key.claim_id]),row)}
   else if(BACKFILL_FAMILIES.includes(change.entity_kind))await recordMigrationAction(c,{runId:input.runId,installationId:change.installation_id,table:change.entity_kind,id:change.entity_id,row:{sequence:String(change.sequence),operation:change.operation,source_revision:change.source_revision},action:'unchanged',reason:change.operation==='DELETE'?'captured_source_deletion':'captured_immutable_change'})
  });processed++}
  if(batch.length<200)break;after=String(batch.at(-1)!.sequence)
 }
 return {processed,overlapFrom:m.startWatermark}
}

export interface PrivacyWatermarks {
 installations:{installation_id:string;local_status:string;relay_status:string;config_version:string}[]
 scopes:Record<string,any>[]
 memberships:Record<string,any>[]
 sessions:Record<string,any>[]
 scopeTombstones:Record<string,any>[]
 tombstones:Record<string,any>[]
 principals:Record<string,any>[]
 delegations:Record<string,any>[]
 capturedAt:string
}
/** Keep this recovery capsule in a restricted store; it contains no plaintext
 * evidence, model prompts, credentials or HMAC keys. It is not a public report. */
export async function capturePrivacyWatermarks(pool:pg.Pool):Promise<PrivacyWatermarks>{return migrationTransaction(pool,async c=>({
 principals:(await c.query('SELECT installation_id,principal_id,state,permission_revision::text,valid_until FROM memory_governance_executor_principals ORDER BY installation_id,principal_id')).rows,
 delegations:(await c.query('SELECT installation_id,delegation_id,state,valid_until FROM memory_publication_delegations ORDER BY installation_id,delegation_id')).rows,
 installations:(await c.query('SELECT installation_id,local_status,relay_status,config_version::text FROM memory_installations ORDER BY installation_id')).rows,
 scopes:(await c.query('SELECT installation_id,owner_scope_kind,owner_scope_id,authorization_epoch::text,state FROM memory_owner_scopes ORDER BY installation_id')).rows,
 memberships:(await c.query('SELECT installation_id,membership_id,membership_revision::text,state,roles,valid_from,valid_until FROM memory_scope_memberships ORDER BY installation_id,membership_id')).rows,
 sessions:(await c.query('SELECT installation_id,session_id,reason FROM memory_session_tombstones ORDER BY installation_id,session_id')).rows,
 scopeTombstones:(await c.query('SELECT owner_scope_kind,owner_scope_id,authorization_epoch::text,reason,tombstoned_at FROM memory_scope_tombstones ORDER BY owner_scope_kind,owner_scope_id')).rows,
 tombstones:(await c.query('SELECT installation_id,key_id,encode(identity_hmac,\'hex\') AS identity_hmac,reason,deleted_at FROM knowledge_tombstones ORDER BY installation_id,key_id,identity_hmac')).rows,
 capturedAt:(await c.query('SELECT clock_timestamp()::text n')).rows[0].n,
}))}
export async function replayPrivacyWatermarks(pool:pg.Pool,w:PrivacyWatermarks,input:{purgeHmacKey:string}){
 const {createPurgeRepository}=await import('../../purge/repository.js'),{randomUUID}=await import('node:crypto')
 if(!Array.isArray(w.principals)||!Array.isArray(w.delegations))throw new Error('restore_executor_watermarks_required')
 const purge=createPurgeRepository(pool,{hmacKey:input.purgeHmacKey})
 for(const row of w.installations.filter(i=>i.local_status==='purged'||i.relay_status==='revoked'||i.relay_status==='revoking')){
  if((await pool.query('SELECT 1 FROM memory_installations WHERE installation_id=$1',[row.installation_id])).rowCount)await purge.purgeInstallation({installationId:row.installation_id,requestId:randomUUID(),reason:'restore_privacy_replay'})
 }
 for(const row of w.sessions)if((await pool.query('SELECT 1 FROM memory_installations WHERE installation_id=$1 AND local_status<>\'purged\'',[row.installation_id])).rowCount)await purge.purgeSession({installationId:row.installation_id,sessionId:row.session_id,sourceFeedId:null,reason:'restore_privacy_replay'})
 // Disable restored service before replaying semantic holds. Control and source
 // writes are separate transactions; installation gates close the intervening gap.
 await migrationTransaction(pool,async c=>{
  await c.query(`UPDATE memory_installations SET local_status='integrity_error' WHERE installation_id=ANY($1::uuid[]) AND local_status<>'purged'`,[w.installations.map(i=>i.installation_id)])
  await c.query(`UPDATE memory_governance_v2_states SET phase='hold',writer_floor='identity_v2',generation=generation+1 WHERE installation_id=ANY($1::uuid[])`,[w.installations.map(i=>i.installation_id)])
  await c.query(`UPDATE memory_jobs SET state='dead',claim_epoch=claim_epoch+1,claimed_by=NULL,claim_expires_at=NULL,last_error_code='restore_authority_revalidation' WHERE installation_id=ANY($1::uuid[]) AND state IN('pending','running')`,[w.installations.map(i=>i.installation_id)])
 })
 await migrationTransaction(pool,async c=>{
  for(const i of [...w.installations].sort((a,b)=>a.installation_id.localeCompare(b.installation_id)))await c.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[i.installation_id])
  for(const s of w.scopes)await c.query(`UPDATE memory_owner_scopes SET authorization_epoch=GREATEST(authorization_epoch,$2::bigint),state=CASE WHEN authorization_epoch<=$2::bigint THEN $3 ELSE state END WHERE installation_id=$1`,[s.installation_id,s.authorization_epoch,s.state])
  for(const t of w.scopeTombstones)await c.query(`INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason,tombstoned_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_scope_kind,owner_scope_id) DO UPDATE SET authorization_epoch=GREATEST(memory_scope_tombstones.authorization_epoch,$3::bigint),reason=CASE WHEN memory_scope_tombstones.authorization_epoch<=$3::bigint THEN $4 ELSE memory_scope_tombstones.reason END`,[t.owner_scope_kind,t.owner_scope_id,t.authorization_epoch,t.reason,t.tombstoned_at])
  for(const m of w.memberships)await c.query(`UPDATE memory_scope_memberships SET membership_revision=$3,state=$4,roles=$5,valid_from=$6,valid_until=$7 WHERE installation_id=$1 AND membership_id=$2 AND membership_revision<=$3::bigint`,[m.installation_id,m.membership_id,m.membership_revision,m.state,m.roles,m.valid_from,m.valid_until])
  for(const t of w.tombstones)if((await c.query('SELECT 1 FROM memory_installations WHERE installation_id=$1 AND local_status<>\'purged\'',[t.installation_id])).rowCount)await c.query(`INSERT INTO knowledge_tombstones(installation_id,key_id,identity_hmac,reason,deleted_at) VALUES($1,$2,decode($3,'hex'),$4,$5) ON CONFLICT DO NOTHING`,[t.installation_id,t.key_id,t.identity_hmac,t.reason,t.deleted_at])
  // Restored data is held until current Relay authority, newer purge watermarks
  // and origin mirrors have been reconciled. Never auto-resume old workers.
  await c.query(`UPDATE knowledge_claims SET consumption_hold_reason=COALESCE(consumption_hold_reason,'restore_authority_revalidation') WHERE installation_id=ANY($1::uuid[])`,[w.installations.map(i=>i.installation_id)])
  for(const p of w.principals??[])await c.query(`UPDATE memory_governance_executor_principals SET state='disabled',permission_revision=GREATEST(permission_revision,$3::bigint) WHERE installation_id=$1 AND principal_id=$2 AND ($4='disabled' OR permission_revision<$3::bigint OR valid_until>$5::timestamptz)`,[p.installation_id,p.principal_id,p.permission_revision,p.state,p.valid_until])
  for(const d of w.delegations??[])await c.query(`UPDATE memory_publication_delegations SET state='revoked' WHERE installation_id=$1 AND delegation_id=$2 AND state='active' AND ($3<>'active' OR valid_until>$4::timestamptz)`,[d.installation_id,d.delegation_id,d.state,d.valid_until])

 })
 return {heldInstallations:w.installations.length,sessionPurges:w.sessions.length,productionEstimate:false}
}
