import type pg from 'pg'
import {manifestDigest,type LifecycleManifest} from './inventory.js'
/** Verification only observes; it cannot restore old bodies or user decisions. */
export async function verifyLifecycleManifest(pool:pg.Pool,m:LifecycleManifest){
 const c=await pool.connect()
 try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const digest=manifestDigest(m),run=(await c.query('SELECT state,checkpoint,total,source_watermark,deletion_watermark FROM memory_lifecycle_migration_runs WHERE manifest_digest=$1',[digest])).rows[0]
  const receipts=(await c.query('SELECT ordinal,installation_id,claim_id,outcome,source_fingerprint FROM memory_lifecycle_migration_items WHERE manifest_digest=$1 ORDER BY ordinal',[digest])).rows
  const reasons:string[]=[]
  if(!run||run.state!=='completed'||Number(run.checkpoint)!==m.items.length||receipts.length!==m.items.length)reasons.push('migration_incomplete')
  for(const [i,r]of receipts.entries()){const expected=m.items[i];if(!expected||r.ordinal!==i||r.claim_id!==expected.claimId||r.installation_id!==expected.installationId||r.source_fingerprint!==expected.fingerprint)reasons.push('receipt_mismatch')}
  const policies=(await c.query('SELECT installation_id,mode FROM memory_curation_policies WHERE installation_id=ANY($1::uuid[])',[m.installationIds])).rows
  if(policies.length!==m.installationIds.length||policies.some(p=>p.mode!==m.targetMode))reasons.push('processing_owner_changed')
  await c.query('COMMIT');return {status:reasons.length?'fail':'pass',digest,checkpoint:Number(run?.checkpoint??0),total:m.items.length,reasons:[...new Set(reasons)],outcomes:Object.fromEntries([...new Set(receipts.map(r=>r.outcome))].map(o=>[o,receipts.filter(r=>r.outcome===o).length])),body_restore_supported:false}
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
