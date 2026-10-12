import {createHash} from 'node:crypto'
import type pg from 'pg'
import {sanitizeText} from '../episodes/content-policy.js'
import {contextClaimFacts,eligibleContextFacts,type ContextQueryFrame} from '../context/consumption.js'
import {assertCurrentGrantClock,requireCurrentScopePermission,TargetBindingError,type V2GrantFacts} from '../governance/authorization.js'
import {selectedScopeContextCurrent} from '../context/selected-scope-dependencies.js'

export interface EvidenceReadInput {
 installationId:string;evidenceId:string;scopeGrant?:V2GrantFacts;expiresAt?:number
 frame?:ContextQueryFrame;packId?:string;packInstallationId?:string
}
export interface BoundEvidenceReadInput extends EvidenceReadInput {
 versionId:string;excerptHash:string;sourceHash?:string;sourceVersion?:string;page?:number;maxChars?:number
}
interface EvidenceRow {
 evidence_id:string;version_id:string;claim_id:string;excerpt:string;excerpt_hash:string
 evidence_kind:string;capsule_id:string|null;source_text:string|null;source_origin:string|null
 source_event_id:string|null;artifact_id:string|null;source_text_overflow:boolean
}
const emptyFrame:ContextQueryFrame={repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')

/** The result is a sanitized material page, never source JSON or executable
 * authority. A retained capsule does not grant access to its old Team source.
 */
export async function readBoundEvidence(pool:pg.Pool,input:EvidenceReadInput|BoundEvidenceReadInput,bound:boolean){
 const page='page' in input?input.page??0:0,maxChars='maxChars' in input?input.maxChars??4000:4000
 if(!Number.isInteger(page)||page<0||page>3||!Number.isInteger(maxChars)||maxChars<1||maxChars>4000)throw new Error('invalid_evidence_page')
 const client=await pool.connect()
 try{
  await client.query('BEGIN')
  const deny=async()=>{await client.query('ROLLBACK');return null}
  if(input.scopeGrant)await requireCurrentScopePermission({client,grant:input.scopeGrant,targetInstallationId:input.installationId,permission:'read'})
  else{
   await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
   const installation=await client.query(`SELECT 1 FROM memory_installations i LEFT JOIN memory_owner_scopes s USING(installation_id)
     WHERE i.installation_id=$1 AND i.relay_status='active' AND i.local_status NOT IN('purging','purged','integrity_error','paused')
       AND (s.owner_scope_kind IS NULL OR(s.owner_scope_kind='personal' AND s.state='active')) FOR SHARE OF i`,[input.installationId])
   if(!installation.rowCount)return deny()
  }
  if(input.expiresAt!=null&&!(await client.query('SELECT clock_timestamp()<to_timestamp($1) AS live',[input.expiresAt])).rows[0].live)return deny()
  const observed=(await client.query<{claim_id:string;version_id:string;excerpt_hash:string}>(`SELECT v.claim_id::text,e.version_id::text,encode(e.excerpt_hash,'hex') AS excerpt_hash
    FROM knowledge_evidence e JOIN knowledge_versions v USING(installation_id,version_id)
    WHERE e.installation_id=$1 AND e.evidence_id=$2`,[input.installationId,input.evidenceId])).rows[0]
  if(!observed)return deny()
  // Match the ledger writer's Claim -> Version -> Evidence order.
  await client.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1 AND claim_id=$2 FOR SHARE',[input.installationId,observed.claim_id])
  await client.query('SELECT 1 FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2 FOR SHARE',[input.installationId,observed.version_id])
  await client.query('SELECT 1 FROM knowledge_evidence WHERE installation_id=$1 AND evidence_id=$2 FOR SHARE',[input.installationId,input.evidenceId])
  let frame=input.frame??emptyFrame
  let packGeneration:string|undefined,packOwner:string|undefined,snapshotSourceHash:string|null|undefined,snapshotSourceVersion:string|null|undefined
  let foreignPack=false
  if(input.packId){
   const owner=input.packInstallationId??input.installationId
   if(owner!==input.installationId&&input.scopeGrant?.primaryInstallationId!==owner)return deny()
   const pack=(await client.query<{query_context:ContextQueryFrame;consumption_generation:string}>(`SELECT p.query_context,p.consumption_generation::text
    FROM memory_context_packs p WHERE p.pack_id=$1 AND p.installation_id=$2 AND p.state IN('ready','shadow')
      AND p.consumption_generation=COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=p.installation_id),1)`,[input.packId,owner])).rows[0]
   if(!pack||!pack.query_context)return deny()
   packGeneration=pack.consumption_generation;packOwner=owner
   if(owner===input.installationId){
    const reference=await client.query<{source_hash:string|null;source_version:string|null}>(`SELECT source_hash,source_version::text FROM memory_context_pack_evidence WHERE pack_id=$1 AND installation_id=$2
      AND evidence_id=$3 AND evidence_version_id=$4 AND excerpt_hash=decode($5,'hex')`,
     [input.packId,owner,input.evidenceId,'versionId' in input?input.versionId:observed.version_id,'excerptHash' in input?input.excerptHash:observed.excerpt_hash])
    if(!reference.rowCount)return deny()
    snapshotSourceHash=reference.rows[0].source_hash;snapshotSourceVersion=reference.rows[0].source_version
    frame=pack.query_context
   }else{
    foreignPack=true
    const proof=pack.query_context?.selectedScopeProof
    if(!proof||!input.scopeGrant||!await selectedScopeContextCurrent(client,{...proof,grant:input.scopeGrant}))return deny()
    const scope=proof.scopes.find(scope=>scope.installationId===input.installationId)
    if(!scope?.references.some(ref=>ref.source_version===observed.version_id
      &&((ref.source_kind==='memory_evidence'&&ref.source_id===input.evidenceId)||(ref.source_kind==='memory_claim'&&ref.source_id===observed.claim_id))))return deny()
    frame=scope.frame
   }
  }
  const row=(await client.query<EvidenceRow>(`SELECT e.evidence_id::text,e.version_id::text,v.claim_id::text,e.excerpt,
   encode(e.excerpt_hash,'hex') AS excerpt_hash,e.evidence_kind,e.capsule_id::text,e.source_event_id::text,e.artifact_id::text,
   event.origin AS source_origin,
   CASE WHEN event.origin='team' THEN NULL
     WHEN e.artifact_id IS NOT NULL THEN CASE WHEN jsonb_typeof(artifact.details->'text')='string' THEN left(artifact.details->>'text',64000) ELSE NULL END
     WHEN jsonb_typeof(event.payload->'text')='string' THEN left(event.payload->>'text',64000) ELSE NULL END AS source_text,
   (COALESCE(length(event.payload->>'text'),0)>64000 OR COALESCE(length(artifact.details->>'text'),0)>64000) AS source_text_overflow
   FROM knowledge_evidence e JOIN knowledge_versions v USING(installation_id,version_id)
   LEFT JOIN source_artifacts artifact ON artifact.installation_id=e.installation_id AND artifact.artifact_id=e.artifact_id
   LEFT JOIN source_events event ON event.installation_id=e.installation_id
     AND event.source_event_id=CASE WHEN e.artifact_id IS NOT NULL THEN artifact.source_event_id ELSE e.source_event_id END
   WHERE e.installation_id=$1 AND e.evidence_id=$2`,[input.installationId,input.evidenceId])).rows[0]
  if(!row||row.version_id!==observed.version_id||digest(row.excerpt)!==row.excerpt_hash)return deny()
  if(bound&&(!('versionId' in input)||input.versionId!==row.version_id||input.excerptHash!==row.excerpt_hash))return deny()
  const sourceVersion=row.artifact_id??row.source_event_id??row.capsule_id??row.version_id
  if('sourceVersion' in input&&input.sourceVersion!==undefined&&input.sourceVersion.toLowerCase()!==sourceVersion)return deny()
  if('sourceHash' in input&&input.sourceHash&&!('sourceVersion' in input&&input.sourceVersion))return deny()
  if(input.packId&&!foreignPack&&sourceVersion!==snapshotSourceVersion)return deny()
  const source=row.source_text?sanitizeText(row.source_text,64000):null
  const sourceHash=source?digest(source.text):null
  if(input.packId&&!foreignPack&&sourceHash!==snapshotSourceHash)return deny()
  if(foreignPack&&'sourceHash' in input&&input.sourceHash)return deny()
  if('sourceHash' in input&&input.sourceHash!==undefined&&input.sourceHash!==sourceHash)return deny()
  const useSource=bound&&'sourceHash' in input&&Boolean(input.sourceHash)&&source!==null
  const content=useSource?source!.text:row.excerpt
  const materialKind=useSource?'sanitized_source':row.capsule_id?'retained_capsule':row.source_origin==='team'?'retained_team_excerpt':'retained_excerpt'
  const available=Math.min(content.length,maxChars*4),offset=page*maxChars
  const reference={evidence_id:row.evidence_id,version_id:row.version_id,excerpt_hash:row.excerpt_hash,
    source_version:sourceVersion,source_hash:sourceHash}
  const result:(Record<string,unknown>&{receipt_id?:string})=bound?{schema_version:1,reference,material_kind:materialKind,content:content.slice(offset,Math.min(offset+maxChars,available)),
    page,next_page:offset+maxChars<available&&page<3?page+1:null,truncated:content.length>maxChars*4||row.source_text_overflow,
    material_missing:source===null}: {schema_version:1,reference,excerpt:row.excerpt,material_kind:materialKind,
      material_missing:source===null,source_available:source!==null}
  // Natural expiry and late source-policy changes are checked after material assembly.
  const fact=(await contextClaimFacts(client,input.installationId,[row.version_id])).get(row.version_id)
  if(!fact||!eligibleContextFacts(fact,frame))return deny()
  if(input.packId&&packOwner&&packGeneration){
   const fresh=await client.query(`SELECT query_context FROM memory_context_packs p WHERE pack_id=$1 AND installation_id=$2
     AND state IN('ready','shadow') AND consumption_generation=$3
     AND consumption_generation=COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=p.installation_id),1)`,[input.packId,packOwner,packGeneration])
   if(!fresh.rowCount)return deny()
   if(foreignPack&&(!input.scopeGrant||!await selectedScopeContextCurrent(client,{...fresh.rows[0].query_context.selectedScopeProof,grant:input.scopeGrant})))return deny()
   if(bound){
    const actor=input.scopeGrant?.scopeBindings.find(binding=>binding.installation_id===input.scopeGrant?.primaryInstallationId)?.membership_id??null
    const key=digest(JSON.stringify([input.packId,input.installationId,row.evidence_id,row.version_id,row.excerpt_hash,useSource?sourceHash:null,page,maxChars,packGeneration,actor]))
    const id=`${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`
    await client.query(`INSERT INTO memory_context_evidence_reads(receipt_id,installation_id,pack_id,source_installation_id,
      evidence_id,version_id,excerpt_hash,source_hash,page,max_chars,consumption_generation,actor_membership_id)
      VALUES($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8,$9,$10,$11,$12) ON CONFLICT(receipt_id) DO NOTHING`,
      [id,packOwner,input.packId,input.installationId,row.evidence_id,row.version_id,row.excerpt_hash,useSource?sourceHash:null,page,maxChars,packGeneration,actor])
    result.receipt_id=id
   }
  }
  if(input.scopeGrant)await assertCurrentGrantClock(client,input.scopeGrant,[input.installationId])
  if(input.expiresAt!=null&&!(await client.query('SELECT clock_timestamp()<to_timestamp($1) AS live',[input.expiresAt])).rows[0].live)return deny()
  await client.query('COMMIT');return result
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof TargetBindingError)return null;throw error}finally{client.release()}
}
