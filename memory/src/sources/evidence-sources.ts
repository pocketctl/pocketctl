import type {SourceCommitOptions} from './prepared-sources.js'
import {assertRetainedSourceGuards,guardRetainedEvidence} from './retained-authority.js'
import {deferredSourcePreparation} from './deferred-preparation.js'
import type pg from 'pg'
import {canonicalJsonString,SourceUnavailableError} from '@pocketctl/session-source'
import {prepareSourceReferences,prepareSourceAuthorities,type PreparedSources} from './prepared-sources.js'
import {classifyArtifact} from '../projection/artifact-classifier.js'
import {sourcePoolContext,sourceConnectionKey} from './pool-context.js'
interface Binding {episode_id:string|null;evidence_kind:string;evidence_id:string;version_id:string;source_event_id:string|null;artifact_id:string|null;resolved_event_id:string|null;origin:string|null;source_kind:string|null;body_reclaimed_at:Date|null;retention_denied:boolean;artifact_type:string|null;identity_key:string|null;path:string|null;status:string|null}
type TeamEvidenceKind='team_collaboration'|'team_delivery'|'team_semantic'
const teamKind=(kind:string|null):kind is TeamEvidenceKind=>kind==='team_collaboration'||kind==='team_delivery'||kind==='team_semantic'
const retainedTeam=(row:Pick<Binding,'origin'|'source_kind'>)=>row.origin==='team'||teamKind(row.source_kind)
export interface EvidenceMaterial {sourceKind?:TeamEvidenceKind;sourceText:string|null;overflow:boolean;origin:string|null;sourceEventId:string|null;artifactId:string|null}
export interface PreparedEvidenceSources {readonly bodyBytes?:number;material(evidenceId:string,versionId:string,sourceEventId:string|null,artifactId:string|null):EvidenceMaterial;assertCurrent(client:Pick<pg.PoolClient,'query'>,options?:SourceCommitOptions):Promise<void>}
const boundQuery=`SELECT e.episode_id::text,e.evidence_kind,e.evidence_id::text,e.version_id::text,e.source_event_id::text,e.artifact_id::text,a.source_event_id::text AS artifact_event_id,
 COALESCE(a.source_event_id,e.source_event_id)::text AS resolved_event_id,s.origin,s.source_kind,s.body_reclaimed_at,EXISTS(SELECT 1 FROM memory_source_retention_receipts receipt WHERE receipt.installation_id=s.installation_id AND(receipt.turn_id=s.turn_id OR(s.turn_id IS NULL AND receipt.session_id=s.session_id))) AS retention_denied,a.artifact_type,a.identity_key,a.path,a.status
 FROM knowledge_evidence e LEFT JOIN source_artifacts a ON a.installation_id=e.installation_id AND a.artifact_id=e.artifact_id
 LEFT JOIN source_events s ON s.installation_id=e.installation_id AND s.source_event_id=COALESCE(a.source_event_id,e.source_event_id)
 WHERE e.installation_id=$1 AND e.evidence_id=ANY($2::uuid[]) ORDER BY e.evidence_id`
const bindingStamp=(rows:Binding[])=>canonicalJsonString(rows.map(r=>({...r,body_reclaimed_at:r.body_reclaimed_at?String(r.body_reclaimed_at):null})))
function textPrefix(value:unknown):{sourceText:string|null;overflow:boolean}{
 if(typeof value!=='string')return {sourceText:null,overflow:false}
 const chars:string[]=[];for(const char of value){if(chars.length===64000)return {sourceText:chars.join(''),overflow:true};chars.push(char)}
 return {sourceText:chars.join(''),overflow:false}
}
/** Evidence/pack preparation stays outside BEGIN, including cold IO. Team
 * evidence retains its existing excerpt-only contract. */
export async function prepareEvidenceSources(pool:pg.Pool,installationId:string,evidenceIds:readonly string[]):Promise<PreparedEvidenceSources>{
 if(evidenceIds.length>4096)throw Error('source_reference_limit')
 const deferred=deferredSourcePreparation<PreparedEvidenceSources>(pool,canonicalJsonString(['evidence',installationId,[...new Set(evidenceIds)].sort()]),physical=>prepareEvidenceSources(physical,installationId,evidenceIds))
 if(deferred)return deferred
 const ids=[...new Set(evidenceIds)],rows:Binding[]=[]
 for(let n=0;n<ids.length;n+=256)rows.push(...(await pool.query<Binding>(boundQuery,[installationId,ids.slice(n,n+256)])).rows)
 rows.sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id))
 const allIds=[...new Set(rows.flatMap(r=>r.resolved_event_id?[r.resolved_event_id]:[]))]
 const mode=sourcePoolContext(pool).namespace==='memory'?(await pool.query('SELECT mode FROM shared.memory_source_modes WHERE installation_id=$1',[installationId])).rows[0]?.mode??'legacy-feed':'legacy-feed'
 const authority=mode==='legacy-feed'?null:await prepareSourceAuthorities(pool,installationId,allIds)
 const bodyIds=[...new Set(rows.filter(r=>!retainedTeam(r)&&!r.body_reclaimed_at&&!r.retention_denied&&r.resolved_event_id).map(r=>r.resolved_event_id!))]
 let bodies:PreparedSources|undefined
 if(bodyIds.length){try{bodies=await prepareSourceReferences(pool,installationId,bodyIds)}catch(error){
  // Retained authority is independent of optional raw collection rights.
  // Never hide source identity/hash conflicts or operational SQL failures.
  if(!(error instanceof SourceUnavailableError)||!['revoked','source_body_reclaimed','archive_unavailable','archive_unconfigured'].includes(error.code))throw error
 }}
 const events=new Map(bodies?.events.map(e=>[e.source_event_id,e])??[]),materials=new Map<string,EvidenceMaterial>()
 let bodyBytes=bodies?.bodyBytes??0
 for(const row of rows){
  const event=row.resolved_event_id?events.get(row.resolved_event_id):undefined
  let raw:unknown
  if(!retainedTeam(row)&&event){
   if(row.artifact_id){
    const artifact=classifyArtifact(event.event_type,event.payload)
    if(!artifact||artifact.artifact_type!==row.artifact_type||artifact.identity_key!==row.identity_key||artifact.path!==row.path||artifact.status!==row.status)throw Error('source_artifact_changed')
    raw=artifact.details.text
   }else raw=event.payload.text
  }
  const prefix=textPrefix(raw)
  bodyBytes+=Buffer.byteLength(prefix.sourceText??'')
  if(bodyBytes>32*1024*1024)throw Error('source_reference_byte_limit')
  materials.set(row.evidence_id,{...prefix,...(teamKind(row.source_kind)?{sourceKind:row.source_kind}:{}),origin:row.origin,sourceEventId:row.source_event_id,artifactId:row.artifact_id})
 }
 const initial=bindingStamp(rows)
 return {bodyBytes,material(evidenceId,versionId,sourceEventId,artifactId){
  const binding=rows.find(r=>r.evidence_id===evidenceId)
  if(!binding||binding.version_id!==versionId||binding.source_event_id!==sourceEventId||binding.artifact_id!==artifactId)throw Error('source_reference_changed')
  return materials.get(evidenceId)!
 },async assertCurrent(client,options){
  await guardRetainedEvidence(client,installationId,rows)
  if(authority)await authority.assertCurrent(client,options)
  if(bodies)await bodies.assertCurrent(client,options)
  const fresh:Binding[]=[]
  for(let n=0;n<ids.length;n+=256)fresh.push(...(await client.query<Binding>(boundQuery,[installationId,ids.slice(n,n+256)])).rows)
  fresh.sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id))
  if(bindingStamp(fresh)!==initial)throw Error('source_reference_changed')
  if(options?.forCommit)await assertRetainedSourceGuards(client)
 }}
}
const attached=new WeakMap<object,PreparedEvidenceSources>()
export const detachPreparedEvidence=(client:object)=>attached.delete(sourceConnectionKey(client))
export function attachPreparedEvidence(client:object,prepared:PreparedEvidenceSources):void{attached.set(sourceConnectionKey(client),prepared)}
export const preparedEvidenceSources=(client:object)=>attached.get(sourceConnectionKey(client))
