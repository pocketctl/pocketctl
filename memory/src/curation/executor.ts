import type pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import type {TombstoneHmacKey} from '../config.js'
import type {JobClaim,JobFence} from '../jobs/types.js'
import {assertJobFence} from '../generation/fence.js'
import {canonicalPacketJson} from '../episodes/packet.js'
import {loadCurrentLifecycleSources,refreshLifecycleProcessingReceipt} from './task-repository.js'
import {sanitizeText} from '../episodes/content-policy.js'
import {parseMemorySourceProvenance} from '../episodes/skill-provenance.js'
import {resolvePredicate} from '../claims/predicate-registry.js'
import {logicalIdentity,type LogicalIdentity} from '../claims/logical-identity.js'
import {readCurationPolicy} from './policy.js'
import {curationTransaction} from './worker.js'
import {validateConclusion,conclusionSchema} from './conclusion-validator.js'
import {evaluateRelation,type RelationDecision} from './relation-evaluator.js'
import {writeLifecycleConclusion,type WriterEvidence,type CurationWriteResult} from './writer.js'
import {resolveLifecycleSubject,deferUnresolvedSubject} from './entity-resolver.js'
import type {CurationMode} from './contracts.js'
const sha=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
export function createCurationExecutor(input:{pool:pg.Pool;mode:CurationMode;tombstoneKeys:readonly TombstoneHmacKey[]}){
 return {async curate(job:JobClaim,signal:AbortSignal,fence?:JobFence):Promise<CurationWriteResult|null>{
  if(!job.installation_id||input.mode==='off')return null
  if(signal.aborted)throw new Error('curation_aborted')
  const installationId=job.installation_id,bundleId=String(job.payload.bundle_id??''),candidateId=String(job.payload.candidate_id??''),runId=String(job.payload.run_id??'')
  if([bundleId,candidateId,runId].some(id=>!/^[0-9a-f-]{36}$/.test(id)))throw new Error('curation_identity_invalid')
  return curationTransaction(input.pool,installationId,bundleId,async(c,bundle)=>{
   await c.query("SET LOCAL pocketctl.writer_capability='identity_v2'; SET LOCAL pocketctl.writer_identity_generation='adaptive'")
   if(fence)await assertJobFence(c,fence)
   const policy=await readCurationPolicy(c,installationId,input.mode)
   if(!policy||policy.mode!=='enabled')return null
   const candidate=(await c.query(`SELECT * FROM memory_candidates WHERE installation_id=$1 AND candidate_id=$2 AND source_kind='task_bundle' AND bundle_id=$3 AND curation_run_id=$4 FOR UPDATE`,[installationId,candidateId,bundleId,runId])).rows[0]
   if(!candidate)return null
   const previous=(await c.query('SELECT action,reason_code,claim_id,version_id,decision_id FROM memory_curation_decisions WHERE installation_id=$1 AND candidate_id=$2 ORDER BY created_at DESC LIMIT 1',[installationId,candidateId])).rows[0]
   if(previous){
    if(previous.action==='defer'&&Number(candidate.bundle_revision)===Number(bundle.revision)&&bundle.semantic_deadline&&new Date(bundle.semantic_deadline).getTime()<=Date.now()){
     const decisionId=randomUUID()
     await c.query(`INSERT INTO memory_curation_decisions(installation_id,decision_id,run_id,candidate_id,action,idempotency_key,claim_id,version_id,reason_code,state) VALUES($1,$2,$3,$4,'skip',$5,$6,$7,'semantic_deadline','skipped') ON CONFLICT DO NOTHING`,[installationId,decisionId,runId,candidateId,`candidate:${candidateId}:deadline`,previous.claim_id,previous.version_id])
     await c.query("UPDATE memory_task_bundles SET state='skipped_unresolved',reason_code='semantic_deadline' WHERE installation_id=$1 AND bundle_id=$2",[installationId,bundleId])
     if(bundle.parent_bundle_id)await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:bundle.parent_bundle_id})
     return {action:'skip',reason:'semantic_deadline',claimId:previous.claim_id,versionId:previous.version_id,decisionId}
    }
    return {action:previous.action,reason:previous.reason_code,claimId:previous.claim_id,versionId:previous.version_id,decisionId:previous.decision_id}
   }
   if(candidate.status!=='validated'||Number(candidate.bundle_revision)!==Number(bundle.revision)||bundle.bundle_kind!=='task'||!bundle.space_id)throw new Error('curation_candidate_stale')
   const run=(await c.query(`SELECT * FROM memory_curation_runs WHERE installation_id=$1 AND run_id=$2 FOR SHARE`,[installationId,runId])).rows[0]
   if(!run||run.state!=='completed'||run.mode!=='enabled'||Number(run.policy_revision)!==policy.revision||String(run.authorization_epoch)!==policy.authorizationEpoch||Number(run.bundle_revision)!==Number(bundle.revision)||!run.source_digest.equals(bundle.source_digest))throw new Error('curation_policy_or_source_changed')
   const parent=(await c.query(`SELECT * FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2 AND body_state='present' FOR SHARE`,[installationId,bundle.parent_bundle_id])).rows[0]
   if(!parent||Number(parent.revision)!==Number(bundle.parent_revision))throw new Error('curation_parent_changed')
   if(!(await c.query("SELECT 1 FROM memory_spaces WHERE installation_id=$1 AND space_id=$2 AND state='active' FOR SHARE",[installationId,bundle.space_id])).rowCount)throw new Error('curation_space_unavailable')
   const loaded=await loadCurrentLifecycleSources(c,installationId,parent)
   const sources=loaded.events,allowed=new Set(loaded.admitted.map(e=>e.source_event_id)),spans=bundle.spans as Array<{event_id:string;start:number;end:number}>
   const childDigest=createHash('sha256').update(canonicalPacketJson({source:parent.source_digest.toString('hex'),spans,space:bundle.space_id})).digest()
   if(!childDigest.equals(bundle.source_digest))throw new Error('curation_task_digest_changed')
   const members=(await c.query('SELECT source_event_id,source_digest FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2',[installationId,bundleId])).rows
   if(members.length!==new Set(spans.map(s=>s.event_id)).size||members.some(m=>!spans.some(s=>s.event_id===m.source_event_id)||!sources.find(s=>s.source_event_id===m.source_event_id)?.payload_hash.equals(m.source_digest)))throw new Error('curation_source_changed')
   const evidence:WriterEvidence[]=[]
   for(const span of spans){
    const source=sources.find(s=>s.source_event_id===span.event_id)
    if(!source||!allowed.has(span.event_id))throw new Error('curation_source_unavailable')
    const payload=source.payload as Record<string,unknown>
    const rawText=sanitizeText(typeof payload.text==='string'?payload.text:'',4000).text
    if(!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>rawText.length)throw new Error('curation_source_span_changed')
    const proof=parseMemorySourceProvenance(source.source_provenance?.memory)!
    evidence.push({id:span.event_id,text:rawText.slice(span.start,span.end),role:proof.source_role,verified:proof.source_role==='tool'&&source.event_type==='test_result'&&payload.status==='passed',occurredAt:new Date(source.occurred_at),digest:source.payload_hash})
   }
   const validation=validateConclusion(candidate.structured_content,evidence)
   if(!validation.ok)throw new Error('curation_conclusion_'+validation.reason)
   const conclusion=validation.conclusion,predicate=resolvePredicate(conclusion.predicate)!
   if(Object.hasOwn(conclusion.conditions,'lifecycle_assertion'))throw new Error('curation_reserved_condition')
   const subject=conclusion.subject.normalize('NFKC').trim().toLowerCase()
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-entity:'||$1||':'||$2||':'||$3,0))",[installationId,bundle.space_id,subject])
   const resolution=await resolveLifecycleSubject(c,{installationId,spaceId:bundle.space_id,subject:conclusion.subject,
    subjectEvidence:evidence.filter(e=>conclusion.evidence.subject.includes(e.id)).map(e=>e.text)})
   if(resolution.kind==='unresolved'){
    const deferred=await deferUnresolvedSubject(c,{installationId,candidateId,runId,bundleId,candidateRevision:Number(candidate.revision)})
    await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:parent.bundle_id})
    return deferred
   }
   const entityId=resolution.kind==='existing'?resolution.entityId:randomUUID()
   if(resolution.kind==='new')await c.query('INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,$3,$4,$5)',[installationId,bundle.space_id,entityId,subject==='self'?'self':'other',conclusion.subject])
   const variant={...conclusion.conditions,...(conclusion.assertion_mode==='planned'?{lifecycle_assertion:'planned'}:{})}
   if(predicate.cardinality==='event'&&!conclusion.fact_at)throw new Error('curation_event_time_required')
   const identity:LogicalIdentity={installationId,spaceId:bundle.space_id,subjectEntityId:entityId,predicateId:predicate.id,variant,cardinality:predicate.cardinality,...(predicate.cardinality==='single'?{}:{memberKey:sha([conclusion.value,predicate.cardinality==='event'?conclusion.fact_at:null])})}
   const key=logicalIdentity(identity)
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-logical:'||$1||':'||$2,0))",[installationId,key])
   if((await c.query('SELECT 1 FROM memory_logical_tombstones WHERE installation_id=$1 AND logical_key=$2',[installationId,key])).rowCount){
    // Privacy suppression is a terminal outcome, not a retryable failure.
    // Keep the decision content-free and preserve the same authority/source
    // fences as a normal automatic write before acknowledging this candidate.
    const skipped=await writeLifecycleConclusion(c,{installationId,candidateId,runId,bundleId,candidateRevision:Number(candidate.revision),conclusion,identity,logicalKey:key,
     relation:{action:'skip',reason:'logical_identity_deleted',differences:[]},target:null,evidence:[],tombstoneKeys:input.tombstoneKeys})
    await c.query("UPDATE memory_candidates SET status='rejected',reviewed_at=clock_timestamp(),revision=revision+1 WHERE installation_id=$1 AND candidate_id=$2",[installationId,candidateId])
    await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:parent.bundle_id})
    return skipped
   }
   const target=(await c.query(`SELECT c.*,v.version_number,v.authority AS current_authority,v.structured_content,v.statement,v.valid_from,v.valid_until,v.freshness_at AS source_freshness,COALESCE(l.protection,'none') AS protection,COALESCE(l.storage_tier,'hot') AS storage_tier,COALESCE(v.body_state,'present') AS version_body_state
    FROM memory_logical_claims m JOIN knowledge_claims c USING(installation_id,claim_id) JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id LEFT JOIN memory_claim_lifecycle l ON l.installation_id=c.installation_id AND l.claim_id=c.claim_id WHERE m.installation_id=$1 AND m.logical_key=$2 FOR UPDATE OF c`,[installationId,key])).rows[0]
   let relation:RelationDecision
   if(target){
    const parsed=conclusionSchema.safeParse(Object.fromEntries(Object.entries(target.structured_content).filter(([name])=>name!=='lifecycle')))
    if(!['machine_concluded','automation_accepted'].includes(target.current_authority))relation={action:'defer',reason:'human_authority_protected',differences:[]}
    else if(target.version_body_state==='reclaimed'){
     const newSourceTime=Math.max(...evidence.filter(e=>Object.values(conclusion.evidence).flat().includes(e.id)).map(e=>e.occurredAt.getTime()))
     const fresh=target.state==='active'&&target.protection==='none'&&['user_asserted','decided','verified'].includes(conclusion.assertion_mode)&&target.source_freshness&&newSourceTime>new Date(target.source_freshness).getTime()&&(!target.valid_from||(conclusion.fact_at&&new Date(conclusion.fact_at).getTime()>=new Date(target.valid_from).getTime()))
     relation=fresh?{action:'replace',reason:'fresh_source_revalidation',differences:['body_availability']}:{action:'skip',reason:'reclaimed_without_fresh_source',differences:[]}
    }else relation=parsed.success?evaluateRelation(conclusion,{conclusion:parsed.data,protection:target.protection,bodyState:target.version_body_state,storageTier:target.storage_tier,state:target.state},true):{action:'defer',reason:'legacy_identity_unproven',differences:[]}
   }else{
    const nearby=(await c.query('SELECT 1 FROM memory_logical_claims WHERE installation_id=$1 AND space_id=$2 AND subject_entity_id=$3 AND predicate_id=$4 LIMIT 1',[installationId,identity.spaceId,identity.subjectEntityId,predicate.id])).rowCount
    relation={action:nearby?'create_variant' as const:'create' as const,reason:nearby?'independent_conditions':'new_logical_identity',differences:[]}
   }
   const citedEvidence=evidence.filter(e=>Object.values(conclusion.evidence).flat().includes(e.id))
   if(target&&['create','create_variant','replace'].includes(relation.action)&&target.source_freshness&&Math.max(...citedEvidence.map(e=>e.occurredAt.getTime()))<new Date(target.source_freshness).getTime())relation={action:'defer',reason:'late_source_event',differences:['source_time']}
   if(target&&['link_evidence','merge'].includes(relation.action)){
    const stored=new Set((await c.query('SELECT source_evidence_hash FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2',[installationId,target.current_version_id])).rows.map(e=>e.source_evidence_hash))
    if(citedEvidence.every(e=>stored.has(sha({id:e.id,digest:e.digest.toString('hex')}))))relation={action:'noop',reason:'evidence_already_linked',differences:[]}
   }
   const written=await writeLifecycleConclusion(c,{installationId,candidateId,runId,bundleId,candidateRevision:Number(candidate.revision),conclusion,identity,logicalKey:key,relation,target:target??null,evidence:citedEvidence,tombstoneKeys:input.tombstoneKeys})
   await refreshLifecycleProcessingReceipt(c,{installationId,parentBundleId:parent.bundle_id})
   return written
  })
 }}
}
