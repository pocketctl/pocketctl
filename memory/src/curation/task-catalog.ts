import type pg from 'pg'
import {createHash} from 'node:crypto'
import {canonicalPacketJson} from '../episodes/packet.js'
import {sanitizeText} from '../episodes/content-policy.js'
import {loadCurrentLifecycleSources} from './task-repository.js'
import type {TaskPartition} from './task-bundler.js'

export interface TaskCatalogEntry {id:string;space_id:string;topic:string;revision:number}
/** A routing hint, never evidence for a new conclusion. No model summary or
 * stored knowledge enters this descriptor; all text comes from admitted spans. */
export function taskTopicDescriptor(spans:TaskPartition['spans'],sources:readonly{id:string;text:string}[]):string {
 return spans.map(span=>sources.find(source=>source.id===span.event_id)?.text.slice(span.start,span.end)??'').join('\n').slice(0,512)
}
/** Caller holds this session's purge fence. Recheck source admission on every
 * read: a persisted hint is not permission to reuse withdrawn/excluded text. */
export async function loadTaskCatalog(c:Pick<pg.PoolClient,'query'>,installationId:string,sessionId:string):Promise<TaskCatalogEntry[]> {
 const rows=(await c.query(`SELECT b.bundle_id::text,b.space_id::text,b.revision,b.parent_revision,b.spans,b.source_digest,b.topic_descriptor,p.bundle_id::text AS parent_id,p.revision AS current_parent_revision,p.session_id,p.task_key,p.source_digest AS parent_digest
  FROM memory_task_bundles b JOIN memory_task_bundles p ON p.installation_id=b.installation_id AND p.bundle_id=b.parent_bundle_id
  JOIN memory_spaces s ON s.installation_id=b.installation_id AND s.space_id=b.space_id AND s.state='active'
  WHERE b.installation_id=$1 AND b.session_id=$2 AND b.bundle_kind='task' AND b.body_state='present' AND p.body_state='present' AND b.parent_revision=p.revision
  AND NOT EXISTS(SELECT 1 FROM memory_candidates candidate WHERE candidate.installation_id=b.installation_id AND candidate.bundle_id=b.bundle_id AND candidate.bundle_revision=b.revision
   AND NOT EXISTS(SELECT 1 FROM memory_curation_decisions d WHERE d.installation_id=candidate.installation_id AND d.candidate_id=candidate.candidate_id AND d.state IN('committed','skipped') AND d.action<>'defer'))
  ORDER BY b.updated_at DESC,b.bundle_id LIMIT 64`,[installationId,sessionId])).rows
 const result:TaskCatalogEntry[]=[]
 for(const row of rows){
  try{
   const source=await loadCurrentLifecycleSources(c,installationId,{bundle_id:row.parent_id,session_id:row.session_id,task_key:row.task_key,source_digest:row.parent_digest})
   const spans=row.spans as TaskPartition['spans']
   const sources=source.admitted.map(event=>({id:event.source_event_id,text:sanitizeText(typeof event.payload.text==='string'?event.payload.text:'',4000).text}))
   if(!spans.length||spans.some(span=>{const item=sources.find(s=>s.id===span.event_id);return !item||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>item.text.length}))continue
   const digest=createHash('sha256').update(canonicalPacketJson({source:row.parent_digest.toString('hex'),spans,space:row.space_id})).digest()
   const topic=taskTopicDescriptor(spans,sources)
   if(!row.source_digest.equals(digest)||!topic||topic!==row.topic_descriptor)continue
   result.push({id:row.bundle_id,space_id:row.space_id,topic,revision:Number(row.revision)})
  }catch(error){if(!(error instanceof Error)||!['curation_source_changed','curation_source_unavailable'].includes(error.message))throw error}
 }
 return result
}
