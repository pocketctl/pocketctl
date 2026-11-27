import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {checkpointDigest as hash,type WindowWitness} from './call-checkpoints.js'
import type {ExtractionResult} from './dialogue-extraction.js'
import {loadTaskCatalog,taskTopicDescriptor} from './task-catalog.js'
import type {ConclusionEvidence} from './conclusion-validator.js'
import type {CurationPolicy} from './policy.js'

type Task=Extract<ExtractionResult,{ok:true}>['tasks'][number]
interface ItemPublication {
 installationId:string;bundleId:string;itemKey:string;task:Task;contributors:WindowWitness[]
 bundle:{session_id:string;watermark:string;dialogue_members?:{id:string}[]}
 reservation:{runId:string;revision:number;digest:Buffer;policyHash:string;modelHash:string;evidence:ConclusionEvidence[]}
 policy:CurationPolicy
}

/** The caller has fenced the current input and owner. This transaction publishes a single
 * independent group, or commits its binding gap. Prior committed groups are idempotent. */
export async function publishCurationItem(c:pg.PoolClient,input:ItemPublication):Promise<boolean>{
 const {installationId,bundleId,itemKey,task,contributors,bundle,reservation,policy}=input
 const calls=contributors.map(w=>w.callId)
 if((await c.query("SELECT 1 FROM memory_curation_items WHERE installation_id=$1 AND run_id=$2 AND item_key=$3 AND state='published'",[installationId,reservation.runId,itemKey])).rowCount)return true
 const space=(await c.query("SELECT name,domain,destinations,state,revision FROM memory_spaces WHERE installation_id=$1 AND space_id=$2 FOR SHARE",[installationId,task.space_id])).rows[0]
 const selected=task.task_id?await loadTaskCatalog(c,installationId,bundle.session_id,new Set([task.task_id])):[]
 const previous=selected[0]
 const observeGap=async()=>{
  const observation=task.task_id?(await c.query('SELECT revision FROM memory_task_bundles WHERE installation_id=$1 AND bundle_id=$2',[installationId,task.task_id])).rows[0]:null
  await c.query(`INSERT INTO memory_curation_items(installation_id,run_id,item_key,window_calls,task_id,space_id,state,observed_revision,observed_space_state,observed_space_revision)
   VALUES($1,$2,$3,$4,$5,$6,'binding_pending',$7,$8,$9) ON CONFLICT(installation_id,run_id,item_key)
   DO UPDATE SET observed_revision=EXCLUDED.observed_revision,observed_space_state=EXCLUDED.observed_space_state,observed_space_revision=EXCLUDED.observed_space_revision,updated_at=clock_timestamp()`,
   [installationId,reservation.runId,itemKey,calls,task.task_id,task.space_id,observation?.revision??null,space?.state??null,space?.revision??null])
  return false
 }
 if(!space||space.state!=='active'||contributors.some(w=>w.bindings.spaces[task.space_id!]!==hash([space.name,space.domain,space.destinations])))return observeGap()
 if(task.task_id&&(!previous||previous.space_id!==task.space_id||contributors.some(w=>w.bindings.tasks[task.task_id!]!==previous.bindingDigest)))return observeGap()
 const childId=task.task_id??randomUUID(),childDigest=Buffer.from(hash({source:reservation.digest.toString('hex'),spans:task.spans,space:task.space_id}),'hex')
 const child=(await c.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,session_id,task_key,space_id,source_digest,watermark,bundle_kind,parent_bundle_id,parent_revision,spans,state,topic_descriptor)
  VALUES($1,$2,$3,$4,$5,$6,$7,'task',$8,$9,$10::jsonb,'completed',$11)
  ON CONFLICT(installation_id,bundle_id) DO UPDATE SET revision=memory_task_bundles.revision+1,source_digest=EXCLUDED.source_digest,parent_bundle_id=EXCLUDED.parent_bundle_id,parent_revision=EXCLUDED.parent_revision,spans=EXCLUDED.spans,topic_descriptor=EXCLUDED.topic_descriptor,state='completed',updated_at=clock_timestamp()
  WHERE memory_task_bundles.session_id=EXCLUDED.session_id AND memory_task_bundles.space_id=EXCLUDED.space_id AND memory_task_bundles.body_state='present' AND memory_task_bundles.revision=$12 RETURNING revision`,
  [installationId,childId,bundle.session_id,`task:${childId}`,task.space_id,childDigest,bundle.watermark,bundleId,reservation.revision,JSON.stringify(task.spans),taskTopicDescriptor(task.spans,reservation.evidence),previous?.revision??0])).rows[0]
 if(!child)return observeGap()
 if(bundle.dialogue_members){
  const selected=new Set(task.spans.map(s=>s.event_id))
  const members=bundle.dialogue_members.filter((m:{id:string})=>selected.has(m.id))
  await c.query('UPDATE memory_task_bundles SET dialogue_members=$3 WHERE installation_id=$1 AND bundle_id=$2',[installationId,childId,JSON.stringify(members)])
 }else{
  await c.query('DELETE FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2',[installationId,childId])
  await c.query(`INSERT INTO memory_task_bundle_sources SELECT installation_id,$3,source_event_id,source_digest,source_sequence FROM memory_task_bundle_sources WHERE installation_id=$1 AND bundle_id=$2 AND source_event_id=ANY($4::uuid[])`,[installationId,bundleId,childId,[...new Set(task.spans.map(s=>s.event_id))]])
 }
 const childRun=(await c.query(`INSERT INTO memory_curation_runs(installation_id,bundle_id,bundle_revision,source_digest,policy_revision,policy_hash,model_config_hash,mode,state,authorization_epoch,parent_run_id,completed_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10,clock_timestamp()) RETURNING run_id::text`,[installationId,childId,child.revision,childDigest,policy.revision,reservation.policyHash,reservation.modelHash,policy.mode,policy.authorizationEpoch,reservation.runId])).rows[0].run_id
 for(const [ordinal,conclusion]of task.conclusions.entries()){
  const candidate=(await c.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision)
   VALUES(gen_random_uuid(),$1,$2,'work_method',$3,$4::jsonb,$5,'task',$6,1,clock_timestamp(),$7,'task_bundle',$8,$9,$10) RETURNING candidate_id::text`,
   [installationId,ordinal,conclusion.statement,JSON.stringify(conclusion),hash(conclusion),task.space_id,policy.mode==='enabled'?'validated':'shadow',childId,childRun,child.revision])).rows[0]
  if(policy.mode==='enabled')await c.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload) VALUES(gen_random_uuid(),$1,'curate_conclusions',$2,86,$3::jsonb) ON CONFLICT DO NOTHING`,[installationId,`curate:${candidate.candidate_id}`,JSON.stringify({candidate_id:candidate.candidate_id,bundle_id:childId,run_id:childRun})])
 }
 await c.query(`INSERT INTO memory_curation_items(installation_id,run_id,item_key,window_calls,task_id,space_id,state,child_run_id)
  VALUES($1,$2,$3,$4,$5,$6,'published',$7) ON CONFLICT(installation_id,run_id,item_key) DO UPDATE
   SET state='published',child_run_id=EXCLUDED.child_run_id,updated_at=clock_timestamp()`,
   [installationId,reservation.runId,itemKey,calls,task.task_id,task.space_id,childRun])
 return true
}
