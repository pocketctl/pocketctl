import {currentClaimVersionSql,asOfClaimVersionSql} from '../claims/version-selection.js'
import {deliveryVersionAvailableSql} from '../episodes/delivery-withdrawal.js'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import {retainedSourceRead,type SourceReadGrant} from './retained-read.js'
import {assertRetainedSourceGuards,adoptRetainedSourceRead} from './retained-authority.js'
import {assertCurrentGrantClock} from '../governance/authorization.js'
import type pg from 'pg'
import {sourcePoolContext} from './pool-context.js'
import {guardRetainedEvidence,registerRetainedReadCheck} from './retained-authority.js'
/** A bounded final view of derived versions and their explicit source refs.
 * No canonical body/archive/model IO. The enclosing retainedSourceRead owns
 * the final authority/root barrier and transaction. */
const observedStatements=new WeakMap<object,string>()
export function rememberRetainedVersionStatement(value:object,statement:string):void{observedStatements.set(value,statement)}
export async function guardRetainedVersions(client:Pick<pg.PoolClient,'query'>,installationId:string,ids:readonly string[],options:{expectedStatements?:ReadonlyMap<string,string>;expectedBodyStates?:ReadonlyMap<string,string>;requireCurrent?:boolean;requireAvailable?:boolean;asOf?:Date;expectedSnapshot?:string;recordCheck?:boolean}={}):Promise<void>{
 if(sourcePoolContext(client).namespace!=='memory')return
 const versions=[...new Set(ids)].sort()
 if(versions.length>512)throw Error('source_reference_limit')
 if(!versions.length)return
 const current=(await client.query(`SELECT v.version_id::text,v.xmin::text AS version_stamp,c.xmin::text AS claim_stamp,v.statement,v.body_state,c.state,c.current_version_id::text,c.consumption_hold_reason,
  ${deliveryVersionAvailableSql()} AS delivery_available,
  (CASE WHEN $3::timestamptz IS NULL THEN ${currentClaimVersionSql()} ELSE ${asOfClaimVersionSql('c','v','$3::timestamptz')} END
   AND(v.valid_from IS NULL OR v.valid_from<=COALESCE($3::timestamptz,clock_timestamp()))
   AND(v.valid_until IS NULL OR v.valid_until>COALESCE($3::timestamptz,clock_timestamp()))) AS selection_available
  FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
  WHERE v.installation_id=$1 AND v.version_id=ANY($2::uuid[]) ORDER BY v.version_id FOR SHARE OF v,c NOWAIT`,[installationId,versions,options.asOf??null])).rows
 if(current.length!==versions.length||current.some(row=>options.expectedStatements?.has(row.version_id)&&options.expectedStatements.get(row.version_id)!==row.statement
  ||options.expectedBodyStates?.has(row.version_id)&&options.expectedBodyStates.get(row.version_id)!==row.body_state
  ||options.requireAvailable&&(row.body_state!=='present'||row.state!=='active'||row.consumption_hold_reason!==null||row.delivery_available!==true||row.selection_available!==true)
  ||options.requireCurrent&&(row.body_state!=='present'||row.state!=='active'||row.current_version_id!==row.version_id||row.consumption_hold_reason!==null)))throw Error('source_reference_changed')
 const evidence=(await client.query(`SELECT e.evidence_id::text,e.xmin::text AS evidence_stamp,e.version_id::text,e.source_event_id::text,e.artifact_id::text,e.episode_id::text,e.evidence_kind,e.capsule_id::text,
  e.locator#>>'{source_provenance,source_kind}' AS provenance_kind,e.locator#>>'{source_provenance,source_version}' AS provenance_version,
  CASE WHEN e.locator#>>'{source_provenance,source_kind}'='team_session' AND e.locator#>>'{source_provenance,source_version}'='2'
   THEN jsonb_build_object('team_id',e.locator#>>'{source_provenance,team_id}','team_session_id',e.locator#>>'{source_provenance,team_session_id}',
    'submission_id',e.locator#>>'{source_provenance,accepted_delivery,submission_id}','decision_id',e.locator#>>'{source_provenance,accepted_delivery,decision_id}') END AS delivery_proof
  FROM knowledge_evidence e WHERE e.installation_id=$1 AND e.version_id=ANY($2::uuid[])
  ORDER BY e.version_id,e.evidence_id LIMIT 4097 FOR SHARE OF e NOWAIT`,[installationId,versions])).rows
 if(evidence.length>4096)throw Error('source_reference_limit')
 const withEvidence=new Set(evidence.map(row=>row.version_id))
 if(current.some(row=>row.body_state==='present'&&!withEvidence.has(row.version_id)))throw Error('source_reference_changed')
 let capsuleStamps:unknown[]=[]
 const capsules=evidence.filter(row=>row.evidence_kind==='accepted_excerpt').map(row=>row.capsule_id)
 if(capsules.length){
  const retained=(await client.query("SELECT capsule_id::text,version_id::text,xmin::text AS capsule_stamp FROM knowledge_evidence_capsules WHERE installation_id=$1 AND capsule_id=ANY($2::uuid[]) ORDER BY capsule_id FOR SHARE NOWAIT",[installationId,capsules])).rows
  capsuleStamps=retained.map(row=>[row.capsule_id,row.capsule_stamp])
  if(evidence.some(row=>row.evidence_kind==='accepted_excerpt'&&!retained.some(c=>c.capsule_id===row.capsule_id&&c.version_id===row.version_id)))throw Error('source_reference_changed')
 }

 const snapshot=JSON.stringify([current.map(row=>[row.version_id,row.version_stamp,row.claim_stamp]),evidence.map(row=>[row.evidence_id,row.evidence_stamp]),capsuleStamps])
 if(options.expectedSnapshot!==undefined&&snapshot!==options.expectedSnapshot)throw Error('source_reference_changed')
 if(evidence.some(row=>row.provenance_kind==='team_session'&&!['1','2'].includes(row.provenance_version)))throw Error('source_reference_unproven')
 const deliveries=evidence.filter(row=>row.delivery_proof).map(row=>row.delivery_proof)
 if(deliveries.length){
  const unique=[...new Map(deliveries.map(proof=>[JSON.stringify(proof),proof])).values()]
  if(unique.length>512)throw Error('source_reference_limit')
  if((await client.query('SELECT shared.lock_memory_delivery_commit($1::jsonb) AS locked',[JSON.stringify(unique)])).rows[0]?.locked!==true)throw Error('source_reference_changed')
 }
 await guardRetainedEvidence(client,installationId,evidence)
 if(options.recordCheck!==false){
  const repeated={...options,asOf:options.asOf?new Date(options.asOf):undefined,expectedSnapshot:snapshot,recordCheck:false}
  await registerRetainedReadCheck(client,installationId,db=>guardRetainedVersions(db,installationId,versions,repeated))
 }
}

/** Federated returns need one physical final boundary for every selected
 * installation. Earlier per-scope transactions cannot attest later merging. */
export async function assertRetainedVersionResponse(pool:pg.Pool,grant:SourceReadGrant,selections:readonly {installationId:string;versionId:string;statement?:string;witness?:object}[],options:{requireCurrent?:boolean;asOf?:Date;retainedReads?:readonly {installationId:string;result:object}[]}={}):Promise<void>{
 if(sourcePoolContext(pool).namespace!=='memory')return
 if(selections.length>512)throw Error('source_reference_limit')
 const installations=[...new Set([...selections.map(s=>s.installationId),...(options.retainedReads??[]).map(read=>read.installationId)])].sort()
 if(installations.length>16)throw Error('source_reference_limit')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  for(const read of options.retainedReads??[])adoptRetainedSourceRead(client,read.result)
  const bound=createTransactionBoundPool(client)
  for(const installationId of installations){
   const selected=selections.filter(s=>s.installationId===installationId)
   const statements=selected.map(s=>[s.versionId,s.statement??(s.witness?observedStatements.get(s.witness):undefined)] as const)
   if(statements.some(([,statement])=>statement===undefined))throw Error('source_reference_changed')
   const checked=await retainedSourceRead(bound,{installationId,authorityGrant:grant},async nested=>{
    await guardRetainedVersions(nested,installationId,selected.map(s=>s.versionId),{expectedStatements:new Map(statements as readonly (readonly [string,string])[]),requireAvailable:true,requireCurrent:options.requireCurrent!==false,asOf:options.asOf})
    return true
   })
   if(checked!==true)throw Error('source_reference_changed')
  }
  await assertRetainedSourceGuards(client)
  await assertCurrentGrantClock(client,grant,installations)
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
