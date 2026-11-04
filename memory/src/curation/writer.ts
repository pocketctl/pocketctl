import type pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import type {TombstoneHmacKey} from '../config.js'
import type {LogicalIdentity} from '../claims/logical-identity.js'
import {resolveClaimApplicability,projectClaimIdentity,assertIdentityNotTombstoned,assertClaimIdentityAvailable} from '../claims/identity-writer.js'
import {activateRevisionInterval} from '../claims/version-selection.js'
import type {Conclusion,ConclusionEvidence} from './conclusion-validator.js'
import type {RelationDecision} from './relation-evaluator.js'
export interface WriterEvidence extends ConclusionEvidence {occurredAt:Date;digest:Buffer}
export interface WriterTarget {claim_id:string;current_version_id:string;revision:string;version_number:number;structured_content:Record<string,unknown>;statement:string;valid_from:Date|null;valid_until:Date|null}
export interface WriteConclusionInput {installationId:string;candidateId:string;runId:string;bundleId:string;candidateRevision:number;conclusion:Conclusion;identity:LogicalIdentity;logicalKey:string;relation:RelationDecision;target:WriterTarget|null;evidence:WriterEvidence[];tombstoneKeys:readonly TombstoneHmacKey[]}
export interface CurationWriteResult {action:string;reason:string;claimId:string|null;versionId:string|null;decisionId:string}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Caller owns source, policy, candidate, logical identity and target locks. No
 * provider I/O. This is the shared transactional automatic ledger write path. */
export async function writeLifecycleConclusion(c:pg.PoolClient,input:WriteConclusionInput):Promise<CurationWriteResult>{
 const {installationId,candidateId,runId,conclusion:next,identity,logicalKey,relation,target}=input
 const action=relation.action,decisionId=randomUUID(),idempotency=`candidate:${candidateId}:${input.candidateRevision}`
 let claimId=target?.claim_id??null,versionId=target?.current_version_id??null
 if(['create','create_variant','replace'].includes(action)){
  // The final ledger boundary independently checks action identity and the
  // locked current head. Evaluator mistakes cannot overwrite human/protected
  // versions or turn a variant creation into replacement of an existing claim.
  if((action==='replace')!==Boolean(target))throw new Error('curation_action_identity_mismatch')
  if(target){
   const current=(await c.query(`SELECT c.current_version_id,c.state,v.authority,v.freshness_at,COALESCE(l.protection,'none') AS protection FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id LEFT JOIN memory_claim_lifecycle l ON l.installation_id=c.installation_id AND l.claim_id=c.claim_id WHERE c.installation_id=$1 AND c.claim_id=$2 FOR UPDATE OF c`,[installationId,target.claim_id])).rows[0]
   if(!current||current.current_version_id!==target.current_version_id)throw new Error('curation_target_stale')
   if(current.state!=='active'||current.protection!=='none'||!['machine_concluded','automation_accepted'].includes(current.authority))throw new Error('curation_target_protected')
   if(current.freshness_at&&Math.max(...input.evidence.map(e=>e.occurredAt.getTime()))<new Date(current.freshness_at).getTime())throw new Error('curation_late_source_event')
  }

  const applicability=await resolveClaimApplicability(c,{installationId,scopeKind:'installation',scopeKey:installationId,repositoryId:null,snapshotId:null,branch:null})
  const structured={...next,lifecycle:{logical_key:logicalKey,space_id:identity.spaceId,source_kind:'task_bundle',bundle_id:input.bundleId}}
  const projection=await projectClaimIdentity(c,{installationId,claimType:'work_method',statement:next.statement,structuredContent:structured,applicability,validFrom:next.fact_at,validUntil:next.valid_until})
  await assertIdentityNotTombstoned(c,{installationId,projection,keys:input.tombstoneKeys})
  // Stable logical identities distinguish identical wording in different scenes
  // under the compatibility v1 unique index. V2 remains the canonical content
  // projection; its duplicate digest includes the explicit scene/identity.
  const stable={...projection,legacyKey:`lifecycle:${logicalKey}`}
  await assertIdentityNotTombstoned(c,{installationId,projection:stable,keys:input.tombstoneKeys})
  await assertClaimIdentityAvailable(c,{installationId,claimType:'work_method',scopeKey:installationId,projection:stable,excludeClaimId:target?.claim_id})
  if(!claimId){claimId=randomUUID();await c.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2)
   VALUES($1,$2::uuid,'work_method','installation',$2::text,$3,'active',$4,$5,$6,$7)`,[claimId,installationId,stable.legacyKey,stable.generation,stable.keyV2,stable.topicKeyV2,stable.duplicateDigestV2])}
  versionId=randomUUID();const versionNumber=target?Number(target.version_number)+1:1
  await c.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,freshness_at,valid_from,valid_until,source_candidate_id,applicability,effective_from)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,'machine_concluded',1,$7,$8,$9,$10,$11::jsonb,CASE WHEN $12 THEN NULL ELSE clock_timestamp() END)`,[versionId,installationId,claimId,versionNumber,next.statement,JSON.stringify(structured),new Date(Math.max(...input.evidence.map(e=>e.occurredAt.getTime()))),next.fact_at,next.valid_until,candidateId,JSON.stringify(applicability),Boolean(target)])
  if(target)await activateRevisionInterval(c,{installationId,claimId,previousVersionId:target.current_version_id,versionId})
  const updated=await c.query(`UPDATE knowledge_claims SET current_version_id=$3,normalized_key=$4,normalized_key_v2=$5,topic_key_v2=$6,duplicate_digest_v2=$7,revision=revision+$8,updated_at=clock_timestamp() WHERE installation_id=$1 AND claim_id=$2 AND ($9::uuid IS NULL OR current_version_id=$9)`,[installationId,claimId,versionId,stable.legacyKey,stable.keyV2,stable.topicKeyV2,stable.duplicateDigestV2,target?1:0,target?.current_version_id??null])
  if(updated.rowCount!==1)throw new Error('curation_target_stale')
  if(!target)await c.query(`INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,variant,cardinality,member_key,claim_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,[installationId,identity.spaceId,identity.subjectEntityId,logicalKey,identity.predicateId,JSON.stringify(identity.variant??{}),identity.cardinality,identity.memberKey??null,claimId])
  await c.query(`INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,last_confirmed_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(installation_id,claim_id) DO UPDATE SET kind=EXCLUDED.kind,assertion_mode=EXCLUDED.assertion_mode,last_confirmed_at=clock_timestamp(),value_assessment='unknown',
   storage_tier=CASE WHEN $5 THEN 'hot' ELSE memory_claim_lifecycle.storage_tier END,body_state=CASE WHEN $5 THEN 'present' ELSE memory_claim_lifecycle.body_state END,
   cold_since=CASE WHEN $5 THEN NULL ELSE memory_claim_lifecycle.cold_since END,revision=memory_claim_lifecycle.revision+1`,[installationId,claimId,next.kind,next.assertion_mode,relation.reason==='fresh_source_revalidation'])
  if(relation.reason==='fresh_source_revalidation')await c.query(`INSERT INTO memory_lifecycle_maintenance_receipts(installation_id,claim_id,version_id,action,lifecycle_revision,body_bytes) SELECT installation_id,claim_id,$3,'reactivate',revision,0 FROM memory_claim_lifecycle WHERE installation_id=$1 AND claim_id=$2`,[installationId,claimId,versionId])
 }
 if(versionId&&['create','create_variant','replace','merge','link_evidence'].includes(action)){
  const capsule=(await c.query(`INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES(gen_random_uuid(),$1,$2,'automation_conclusion',$3) ON CONFLICT(installation_id,version_id) DO UPDATE SET source_content_hash=knowledge_evidence_capsules.source_content_hash RETURNING capsule_id`,[installationId,versionId,Buffer.from(digest(input.evidence.map(e=>e.digest.toString('hex')).sort()),'hex')])).rows[0].capsule_id
  const priorEvidence=(await c.query('SELECT ordinal,source_evidence_hash FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2 ORDER BY ordinal',[installationId,versionId])).rows
  let ordinal=Math.max(-1,...priorEvidence.map(r=>Number(r.ordinal)))+1
  const seen=new Set(priorEvidence.map(r=>r.source_evidence_hash))
  for(const e of input.evidence){
   const hash=digest({id:e.id,digest:e.digest.toString('hex')});if(seen.has(hash)||ordinal>63)continue
   await c.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,locator,excerpt,excerpt_hash,source_evidence_hash,occurred_at,ordinal)
    VALUES(gen_random_uuid(),$1,$2,$3,'accepted_excerpt',$4::jsonb,$5,sha256(convert_to($5,'utf8')),$6,$7,$8)`,[installationId,versionId,capsule,JSON.stringify({source_kind:'task_bundle',bundle_id:input.bundleId,source_event_id:e.id,source_digest:e.digest.toString('hex')}),e.text,hash,e.occurredAt,ordinal++]);seen.add(hash)
  }
  await c.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload) VALUES(gen_random_uuid(),$1,'index_claim_version',$2,90,$3::jsonb) ON CONFLICT DO NOTHING`,[installationId,`index:${versionId}`,JSON.stringify({version_id:versionId})])
  await c.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload) VALUES(gen_random_uuid(),$1,'invalidate_context_packs',$2,10,$3::jsonb) ON CONFLICT DO NOTHING`,[installationId,`curation-invalidate:${candidateId}`,JSON.stringify({claim_id:claimId})])
 }
 const committed=!['defer','skip'].includes(action)
 await c.query(`INSERT INTO memory_curation_decisions(installation_id,decision_id,run_id,candidate_id,action,idempotency_key,expected_version_id,claim_id,version_id,reason_code,state,evidence_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,[installationId,decisionId,runId,candidateId,action,idempotency,target?.current_version_id??null,claimId,versionId,relation.reason,committed?'committed':'skipped',JSON.stringify(input.evidence.map(e=>({source_event_id:e.id,digest:e.digest.toString('hex')})))])
 if(committed)await c.query("UPDATE memory_candidates SET status='accepted',reviewed_at=clock_timestamp(),revision=revision+1 WHERE installation_id=$1 AND candidate_id=$2",[installationId,candidateId])
 if(action==='defer'){
  const deferred=(await c.query(`UPDATE memory_task_bundles SET state='deferred_semantic',reason_code=$3,semantic_deadline=COALESCE(semantic_deadline,clock_timestamp()+interval '7 days'),next_evaluate_at=COALESCE(semantic_deadline,clock_timestamp()+interval '7 days') WHERE installation_id=$1 AND bundle_id=$2 RETURNING semantic_deadline`,[installationId,input.bundleId,relation.reason])).rows[0]
  await c.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload,available_at) VALUES(gen_random_uuid(),$1,'curate_conclusions',$2,86,$3::jsonb,$4) ON CONFLICT DO NOTHING`,[installationId,`curate-deadline:${candidateId}`,JSON.stringify({candidate_id:candidateId,bundle_id:input.bundleId,run_id:runId}),deferred.semantic_deadline])
 }
 return {action,reason:relation.reason,claimId,versionId,decisionId}
}
