import type pg from 'pg'
import {lockRetentionLifecycle} from '../../retention/transaction.js'
import {LIFECYCLE_POLICY_VERSION,migrationToolHash,manifestDigest,readItem,deletionWatermark,type LifecycleManifest} from './inventory.js'
export async function applyLifecycleManifest(pool:pg.Pool,m:LifecycleManifest,options:{expectedDigest:string;policyVersion:string;batchSize?:number}){
 if(m.format!==1||manifestDigest(m)!==options.expectedDigest)throw new Error('manifest_digest_mismatch')
 if(m.toolHash!==migrationToolHash())throw new Error('tool_code_mismatch')
 if(m.policyVersion!==LIFECYCLE_POLICY_VERSION||options.policyVersion!==m.policyVersion)throw new Error('policy_version_mismatch')
 const size=options.batchSize??100;if(!Number.isInteger(size)||size<1||size>1000)throw new Error('invalid_batch_size')
 if(!m.installationIds.length||new Set(m.items.map(i=>i.claimId)).size!==m.items.length||m.items.some(i=>!m.installationIds.includes(i.installationId)))throw new Error('invalid_fixed_manifest')
 const c=await pool.connect()
 try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");await lockRetentionLifecycle(c)
  if(Number((await c.query('SELECT max(version) n FROM memory_schema_migrations')).rows[0].n)!==m.schema)throw new Error('schema_version_changed')
  // Policy locks are shared with legacy reservation and commit paths. No source
  // ownership changes until every fixed item has a durable receipt.
  const policies=(await c.query(`SELECT p.*,s.authorization_epoch::text AS epoch,s.state AS owner_state FROM memory_curation_policies p JOIN memory_owner_scopes s USING(installation_id) WHERE p.installation_id=ANY($1::uuid[]) ORDER BY p.installation_id FOR UPDATE OF p FOR SHARE OF s`,[m.installationIds])).rows
  await c.query(`INSERT INTO memory_lifecycle_migration_runs(manifest_digest,policy_version,installation_ids,target_mode,total,source_watermark,deletion_watermark) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[options.expectedDigest,m.policyVersion,m.installationIds,m.targetMode,m.items.length,m.sourceWatermark,m.deletionWatermark])
  const run=(await c.query('SELECT * FROM memory_lifecycle_migration_runs WHERE manifest_digest=$1 FOR UPDATE',[options.expectedDigest])).rows[0]
  if(run.state==='completed'){await c.query('COMMIT');return {complete:true,checkpoint:Number(run.checkpoint),digest:options.expectedDigest}}
  if(policies.length!==m.policies.length||policies.some(p=>{const expected=m.policies.find(e=>e.installationId===p.installation_id);return !expected||String(p.revision)!==expected.revision||p.policy_version!==m.policyVersion||p.mode!==expected.mode||p.epoch!==expected.authorizationEpoch||p.owner_state!=='active'}))throw new Error('policy_or_authorization_changed')
  if(await deletionWatermark(c,m.installationIds)!==m.deletionWatermark)throw new Error('deletion_watermark_changed_replan_required')
  const watermark=(await c.query('SELECT coalesce(max(feed_id),0)::text n FROM memory_feed_inbox WHERE installation_id=ANY($1::uuid[])',[m.installationIds])).rows[0].n
  if(BigInt(watermark)<BigInt(m.sourceWatermark))throw new Error('source_watermark_regressed')
  if(m.targetMode==='enabled'&&(await c.query(`SELECT count(*)::int n FROM memory_extraction_runs WHERE installation_id=ANY($1::uuid[]) AND (state IN('running','provider_result_unknown') OR error_code='provider_result_unknown')`,[m.installationIds])).rows[0].n>0)throw new Error('legacy_work_in_flight')
  const start=Number(run.checkpoint),end=Math.min(m.items.length,start+size)
  for(let ordinal=start;ordinal<end;ordinal++){
   const item=m.items[ordinal],current=await readItem(c,item.installationId,item.claimId,true)
   // Serialize changes to a current version too; a stale body fingerprint is
   // preserved, never overwritten with the old snapshot.
   if(current?.currentVersionId)await c.query('SELECT version_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2 FOR SHARE',[item.installationId,current.currentVersionId])
   const fresh=current?await readItem(c,item.installationId,item.claimId):null
   let outcome='missing_deleted'
   if(fresh){
    if(fresh.fingerprint!==item.fingerprint)outcome='preserved_concurrent_change'
    else if(fresh.state!=='active'||!['user_accepted','user_corrected'].includes(fresh.authority??'')||fresh.collision)outcome='preserved_inactive'
    else{
     const kind=fresh.claimType==='architecture_decision'?'decision':['work_method','operational_runbook','repository_convention'].includes(fresh.claimType)?'method':'fact'
     const inserted=await c.query(`INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,protection) VALUES($1,$2,$3,'user_asserted',$4) ON CONFLICT DO NOTHING RETURNING claim_id`,[item.installationId,item.claimId,kind,fresh.authority==='user_corrected'?'user_corrected':'none'])
     outcome=inserted.rowCount?'migrated':'preserved_existing'
    }
   }
   await c.query(`INSERT INTO memory_lifecycle_migration_items(manifest_digest,ordinal,installation_id,claim_id,outcome,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6)`,[options.expectedDigest,ordinal,item.installationId,item.claimId,outcome,item.fingerprint])
  }
  const complete=end===m.items.length
  if(complete){
   // Explicit mode in the digest; all other consumption/cold/reclaim switches
   // remain independently controlled. This is not a deploy/release command.
   await c.query('UPDATE memory_curation_policies SET mode=$2,revision=revision+1,updated_at=clock_timestamp() WHERE installation_id=ANY($1::uuid[]) AND mode<>$2',[m.installationIds,m.targetMode])
  }
  await c.query(`UPDATE memory_lifecycle_migration_runs SET checkpoint=$2,state=$3,completed_at=CASE WHEN $3='completed' THEN clock_timestamp() ELSE NULL END WHERE manifest_digest=$1`,[options.expectedDigest,end,complete?'completed':'running'])
  await c.query('COMMIT');return {complete,checkpoint:end,digest:options.expectedDigest}
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
