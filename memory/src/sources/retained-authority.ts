import type {SourceCommitOptions} from './prepared-sources.js'
import type pg from 'pg'
import {sourcePoolContext,sourceConnectionKey} from './pool-context.js'
import {prepareSourceAuthorities} from './prepared-sources.js'
import {governedRetainedEvidence} from './governed-retained-evidence.js'

export interface RetainedEvidenceBinding {source_event_id:string|null;artifact_id:string|null;episode_id?:string|null;evidence_kind?:string;evidence_id?:string;version_id?:string}
type Db=Pick<pg.PoolClient,'query'>
type SourceMode={mode:string;generation:string}
type LockedCapsule={evidence_id:string;version_id:string;retention_basis:string}
interface RetainedEvidenceOptions {
 expectedMode?:SourceMode
 /** Already read in the caller's locking snapshot on this transaction. */
 locked?:{mode:SourceMode;capsules:readonly LockedCapsule[]}
}
interface Guard {assertCurrent(client:Db,options?:SourceCommitOptions):Promise<void>}
interface ConsumerGuards {installationId:string;mode:string;generation:string;ids:Set<string>;governedIds:Set<string>;guards:Guard[]}
const attached=new WeakMap<object,Map<string,ConsumerGuards>>()
export const detachRetainedSourceGuards=(client:object)=>attached.delete(sourceConnectionKey(client))
export const currentRetainedSourceMode=async(client:Db,installationId:string):Promise<SourceMode>=>(await client.query(
 'SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[installationId],
)).rows[0]??{mode:'legacy-feed',generation:'1'}

const uuidPattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'

/** Human capsules carry independent retention authority. Machine capsules
 * instead cite the exact original member of a committed curation decision.
 * The returned UUIDs still need the current native source commit fence. */
async function machineExcerptSources(client:Db,installationId:string,evidence:readonly RetainedEvidenceBinding[],locked?:readonly LockedCapsule[]):Promise<string[]>{
 const excerpts=evidence.filter(row=>row.evidence_kind==='accepted_excerpt')
 if(!excerpts.length)return []
 if(excerpts.some(row=>!row.evidence_id||!row.version_id))throw Error('source_reference_unproven')
 const expected=new Map(excerpts.map(row=>[row.evidence_id,row.version_id]))
 const capsules=locked??(await client.query<LockedCapsule>(`
  SELECT e.evidence_id::text,e.version_id::text,cap.retention_basis
  FROM knowledge_evidence e JOIN knowledge_evidence_capsules cap USING(installation_id,capsule_id,version_id)
  WHERE e.installation_id=$1 AND e.evidence_id=ANY($2::uuid[]) AND e.evidence_kind='accepted_excerpt'
  ORDER BY e.evidence_id FOR SHARE OF e,cap NOWAIT`,[installationId,[...expected.keys()]])).rows
 if(capsules.length!==expected.size||capsules.some(row=>expected.get(row.evidence_id)!==row.version_id
  ||!['user_accepted','automation_conclusion'].includes(row.retention_basis)))throw Error('source_reference_changed')
 const automated=capsules.filter(row=>row.retention_basis==='automation_conclusion').map(row=>row.evidence_id)
 if(!automated.length)return []
 const proved=(await client.query(`
  WITH locators AS (
   SELECT e.evidence_id,e.installation_id,e.version_id,e.locator->>'source_digest' AS digest,
    CASE WHEN e.locator->>'source_event_id'~$3 THEN (e.locator->>'source_event_id')::uuid END AS source_event_id,
    CASE WHEN e.locator->>'bundle_id'~$3 THEN (e.locator->>'bundle_id')::uuid END AS bundle_id
   FROM knowledge_evidence e
   WHERE e.installation_id=$1 AND e.evidence_id=ANY($2::uuid[]) AND e.locator->>'source_kind'='task_bundle'
    AND e.source_event_id IS NULL AND e.episode_id IS NULL AND e.artifact_id IS NULL
    AND e.excerpt_hash=sha256(convert_to(e.excerpt,'UTF8'))
  )
  SELECT l.source_event_id::text
  FROM locators l
  JOIN knowledge_versions v USING(installation_id,version_id)
  JOIN memory_task_bundle_sources member USING(installation_id,bundle_id,source_event_id)
  JOIN memory_task_bundles b USING(installation_id,bundle_id)
  JOIN source_events s USING(installation_id,source_event_id)
  JOIN LATERAL (
   SELECT 1 FROM memory_curation_runs r JOIN memory_curation_decisions d USING(installation_id,run_id)
   WHERE r.installation_id=l.installation_id AND r.bundle_id=l.bundle_id AND r.mode='enabled' AND r.state='completed'
    AND d.version_id=l.version_id AND d.claim_id=v.claim_id AND d.state='committed'
    AND d.action IN('create','create_variant','replace','link_evidence','merge')
    AND d.evidence_refs @> jsonb_build_array(jsonb_build_object('source_event_id',l.source_event_id,'digest',l.digest))
   LIMIT 1 FOR SHARE OF r,d NOWAIT
  ) decision ON TRUE
  WHERE v.authority IN('machine_concluded','automation_accepted') AND b.bundle_kind='task' AND b.session_id=s.session_id
    AND member.source_digest=s.payload_hash AND l.digest=encode(s.payload_hash,'hex')
  ORDER BY l.evidence_id FOR SHARE OF v,member,b,s NOWAIT`,[installationId,automated,uuidPattern])).rows
 if(proved.length!==automated.length)throw Error('source_reference_changed')
 return proved.map(row=>row.source_event_id)
}

/** Retained-excerpt authority, including bounded saved reviewed snapshots. No raw body, archive or
 * model IO is permitted here, including when called within a transaction.
 * The caller repeats assertRetainedSourceGuards at its final positive boundary.
 * This supplements current grant/lifecycle checks; full root commit locking is
 * a separate contract. Observations are private to the acquired connection. */
export async function guardRetainedEvidence(client:Db,installationId:string,evidence:readonly RetainedEvidenceBinding[],options:RetainedEvidenceOptions={}):Promise<void>{
 if(sourcePoolContext(client).namespace!=='memory')return
 if(evidence.length>4096)throw Error('source_reference_limit')
 const installations=attached.get(sourceConnectionKey(client))??new Map<string,ConsumerGuards>()
 let state=installations.get(installationId)
 const {expectedMode,locked}=options
 const mode=locked?.mode??await currentRetainedSourceMode(client,installationId)
 if(!['legacy-feed','shared-shadow','shared-active'].includes(mode.mode)
  ||expectedMode&&(mode.mode!==expectedMode.mode||mode.generation!==expectedMode.generation))throw Error('source_reference_changed')
 if(state&&(state.mode!==mode.mode||state.generation!==mode.generation))throw Error('source_reference_changed')
 if(!state){
  if(installations.size>=16)throw Error('source_reference_limit')
  state={installationId,...mode,ids:new Set<string>(),governedIds:new Set<string>(),guards:[]};installations.set(installationId,state);attached.set(sourceConnectionKey(client),installations)
 }
 const ids=new Set(evidence.flatMap(row=>row.source_event_id?[row.source_event_id]:[]))
 const machineSources=await machineExcerptSources(client,installationId,evidence,locked?.capsules)
 if(machineSources.length&&mode.mode==='legacy-feed')throw Error('source_reference_unproven')
 for(const id of machineSources)ids.add(id)
 const artifactSet=new Set(evidence.flatMap(row=>row.artifact_id?[row.artifact_id]:[]))
 const governed=await governedRetainedEvidence(client,installationId,evidence)
 const newlyGoverned=[...governed].filter(id=>!state.governedIds.has(id))
 if(newlyGoverned.length){
  if(state.guards.length>=256||[...installations.values()].reduce((sum,entry)=>sum+entry.governedIds.size,0)+newlyGoverned.length>4096)throw Error('source_reference_limit')
  const selected=new Set(newlyGoverned),bindings=evidence.filter(row=>row.evidence_id&&selected.has(row.evidence_id)).map(row=>({...row}))
  state.guards.push({async assertCurrent(db){const fresh=await governedRetainedEvidence(db,installationId,bindings);if(fresh.size!==selected.size)throw Error('source_reference_changed')}})
  for(const id of selected)state.governedIds.add(id)
 }
 const episodeIds=[...new Set(evidence.flatMap(row=>!row.source_event_id&&!row.artifact_id&&row.evidence_kind!=='accepted_excerpt'&&row.episode_id&&!(row.evidence_id&&governed.has(row.evidence_id))?[row.episode_id]:[]))].sort()
 if(episodeIds.length){
  const episodes=(await client.query(`WITH selected AS(SELECT episode_id,evidence_manifest FROM work_episodes
    WHERE installation_id=$1 AND episode_id=ANY($2::uuid[]) ORDER BY episode_id FOR SHARE),bounded AS(
    SELECT *,sum(octet_length(evidence_manifest::text)) OVER(ORDER BY episode_id) AS manifest_bytes FROM selected)
    SELECT episode_id::text,CASE WHEN manifest_bytes<=8388608 THEN evidence_manifest ELSE NULL END AS evidence_manifest
    FROM bounded ORDER BY episode_id`,[installationId,episodeIds])).rows
  if(episodes.length!==episodeIds.length)throw Error('source_reference_missing')
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for(const row of episodes){
   if(!row.evidence_manifest||typeof row.evidence_manifest!=='object'||Array.isArray(row.evidence_manifest))throw Error('source_reference_unproven')
   let proved=false
   for(const entry of Object.values(row.evidence_manifest) as any[]){
    if(!entry||typeof entry!=='object'||entry.omitted===true)continue
    for(const [key,set] of [['source_event_id',ids],['artifact_id',artifactSet]] as const){
     if(entry[key]!==undefined){if(typeof entry[key]!=='string'||!uuid.test(entry[key]))throw Error('source_reference_unproven');set.add(entry[key]);proved=true}
    }
    if(ids.size+artifactSet.size>4096)throw Error('source_reference_limit')
   }
   if(!proved)throw Error('source_reference_unproven')
  }
 }
 const artifactIds=[...artifactSet].sort()
 if(artifactIds.length){
  const artifacts=(await client.query('SELECT artifact_id::text,source_event_id::text FROM source_artifacts WHERE installation_id=$1 AND artifact_id=ANY($2::uuid[]) ORDER BY artifact_id FOR SHARE',[installationId,artifactIds])).rows
  if(artifacts.length!==artifactIds.length||artifacts.some(row=>!row.source_event_id))throw Error('source_reference_missing')
  for(const row of artifacts)ids.add(row.source_event_id)
 }
 if([...installations.values()].reduce((sum,entry)=>sum+entry.ids.size,0)+[...ids].filter(id=>!state!.ids.has(id)).length>4096)throw Error('source_reference_limit')
 const added=[...ids].filter(id=>!state.ids.has(id)).sort()
 if(added.length&&mode.mode!=='legacy-feed'){
  // prepareSourceAuthorities uses only controlled current facts and UUID
  // metadata. It does not resolve bodies or require raw collection rights.
  const guard=await prepareSourceAuthorities(client as pg.Pool,installationId,added)
  await guard.assertCurrent(client)
  state.guards.push(guard)
 }
 for(const id of added)state.ids.add(id)
}
export async function assertRetainedSourceGuards(client:Db):Promise<void>{
 const states=attached.get(sourceConnectionKey(client))
 if(!states)return
 for(const state of [...states.values()].sort((a,b)=>a.installationId.localeCompare(b.installationId))){
  const mode=await currentRetainedSourceMode(client,state.installationId)
  if(mode.mode!==state.mode||mode.generation!==state.generation)throw Error('source_reference_changed')
  for(const guard of state.guards)await guard.assertCurrent(client,{forCommit:true})
 }
}

// In-memory only: federated DTO assembly must carry every per-scope source
// observation, including conflicts/episodes not selected into the merged RRF.
const readWitnesses=new WeakMap<object,ConsumerGuards[]>()
export function rememberRetainedSourceRead(client:object,value:unknown):void{
 if(!value||typeof value!=='object')return
 const states=attached.get(sourceConnectionKey(client))
 readWitnesses.set(value,[...(states?.values()??[])].map(state=>({...state,ids:new Set(state.ids),governedIds:new Set(state.governedIds),guards:[...state.guards]})))
}
export function adoptRetainedSourceRead(client:object,value:object):void{
 const saved=readWitnesses.get(value)
 if(!saved)throw Error('source_reference_changed')
 const states=attached.get(sourceConnectionKey(client))??new Map<string,ConsumerGuards>()
 for(const state of saved){
  const existing=states.get(state.installationId)
  if(existing&&(existing.mode!==state.mode||existing.generation!==state.generation))throw Error('source_reference_changed')
  states.set(state.installationId,{...state,ids:new Set([...(existing?.ids??[]),...state.ids]),governedIds:new Set([...(existing?.governedIds??[]),...state.governedIds]),guards:[...new Set([...(existing?.guards??[]),...state.guards])]})
 }
 if(states.size>16||[...states.values()].reduce((n,state)=>n+state.ids.size+state.governedIds.size,0)>4096)throw Error('source_reference_limit')
 attached.set(sourceConnectionKey(client),states)
}

/** Bounded local derived-row validation carried with an in-memory read proof.
 * The check must use metadata SQL/NOWAIT only, with no writes or network IO. */
export async function registerRetainedReadCheck(client:Db,installationId:string,check:(db:Db)=>Promise<void>):Promise<void>{
 if(sourcePoolContext(client).namespace!=='memory')return
 if(!attached.get(sourceConnectionKey(client))?.has(installationId))await guardRetainedEvidence(client,installationId,[])
 const state=attached.get(sourceConnectionKey(client))!.get(installationId)!
 if(state.guards.length>=256)throw Error('source_reference_limit')
 state.guards.push({assertCurrent:check})
}
