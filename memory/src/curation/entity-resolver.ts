import type pg from 'pg'
import {randomUUID} from 'node:crypto'
import type {CurationWriteResult} from './writer.js'

interface EntityName {entity_id:string;name:string;alias:string|null}
export type SubjectResolution={kind:'existing';entityId:string}|{kind:'new'}|{kind:'unresolved'}
const CATALOG_LIMIT=1000
const normalize=(text:string)=>text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,' ')
function containsName(text:string,name:string):boolean{
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 return new RegExp(`(?:^|[^\\p{L}\\p{N}\\p{M}_])${escaped}(?=$|[^\\p{L}\\p{N}\\p{M}_])`,'u').test(text)
}
/** A source-literal naming conflict is uncertainty, never permission to merge.
 * Only an already registered alias can establish that two names are one entity. */
export function resolveSubjectFromCatalog(subject:string,subjectEvidence:readonly string[],rows:readonly EntityName[]):SubjectResolution{
 if(rows.length>CATALOG_LIMIT)return{kind:'unresolved'}
 const proposed=normalize(subject),sources=subjectEvidence.map(normalize)
 if(!proposed)return{kind:'unresolved'}
 const names=rows.flatMap(row=>[row.name,row.alias].filter((name):name is string=>!!name).map(name=>({entityId:row.entity_id,name:normalize(name)})))
 const exact=new Set(names.filter(entry=>entry.name===proposed).map(entry=>entry.entityId))
 if(exact.size>1)return{kind:'unresolved'}
 const entityId=[...exact][0]
 const conflict=names.some(entry=>entry.entityId!==entityId&&entry.name!==proposed&&
  (containsName(entry.name,proposed)||containsName(proposed,entry.name))&&sources.some(source=>containsName(source,entry.name)))
 if(conflict)return{kind:'unresolved'}
 return entityId?{kind:'existing',entityId}:{kind:'new'}
}
/** Caller holds the installation/source/policy fences. Never silently truncate
 * the catalog: overflow cannot establish that no competing name exists. */
export async function resolveLifecycleSubject(client:Pick<pg.PoolClient,'query'>,input:{installationId:string;spaceId:string;subject:string;subjectEvidence:readonly string[]}):Promise<SubjectResolution>{
 const rows=(await client.query<EntityName>(`SELECT e.entity_id,e.name,a.alias FROM memory_entities e
  LEFT JOIN memory_entity_aliases a USING(installation_id,space_id,entity_id)
  WHERE e.installation_id=$1 AND e.space_id=$2 ORDER BY e.entity_id,a.alias LIMIT $3`,[input.installationId,input.spaceId,CATALOG_LIMIT+1])).rows
 return resolveSubjectFromCatalog(input.subject,input.subjectEvidence,rows)
}
/** No resolved entity or logical key exists. Record only nullable audit fields
 * and use the existing bounded semantic retry, keeping source retention pending. */
export async function deferUnresolvedSubject(client:Pick<pg.PoolClient,'query'>,input:{installationId:string;candidateId:string;runId:string;bundleId:string;candidateRevision:number}):Promise<CurationWriteResult>{
 const {installationId,candidateId,runId,bundleId}=input,decisionId=randomUUID()
 await client.query(`INSERT INTO memory_curation_decisions(installation_id,decision_id,run_id,candidate_id,action,idempotency_key,reason_code,state)
  VALUES($1,$2,$3,$4,'defer',$5,'identity_unresolved','skipped')`,[installationId,decisionId,runId,candidateId,`candidate:${candidateId}:${input.candidateRevision}`])
 const deferred=(await client.query(`UPDATE memory_task_bundles SET state='deferred_semantic',reason_code='identity_unresolved',
  semantic_deadline=COALESCE(semantic_deadline,clock_timestamp()+interval '7 days'),
  next_evaluate_at=COALESCE(semantic_deadline,clock_timestamp()+interval '7 days')
  WHERE installation_id=$1 AND bundle_id=$2 RETURNING semantic_deadline`,[installationId,bundleId])).rows[0]
 await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload,available_at)
  VALUES(gen_random_uuid(),$1,'curate_conclusions',$2,86,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
 [installationId,`curate-deadline:${candidateId}`,JSON.stringify({candidate_id:candidateId,bundle_id:bundleId,run_id:runId}),deferred.semantic_deadline])
 return{action:'defer',reason:'identity_unresolved',claimId:null,versionId:null,decisionId}
}
