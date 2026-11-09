import {prepareTeamSemanticReferences} from './team-semantic-reader.js'
import {deferredSourcePreparation} from './deferred-preparation.js'
import {createObservedSourceReader} from './observed-reader.js'
import type pg from 'pg'
import {canonicalPayloadHash,canonicalJsonString,verifyOriginalSourceHash,type SourceScope,type SourceRoot,type SourceVersion,type SourceHead} from '@pocketctl/session-source'
import {sourcePoolContext,sourceConnectionKey} from './pool-context.js'
import {sourceExecutionBranchFor} from './source-execution.js'
import {JobDeferredError} from '../jobs/types.js'
import {prepareSourceProjectionAdmission} from './source-projection-admission.js'
type Db=Pick<pg.Pool,'query'>
export interface SourceCommitOptions {forCommit?:boolean}
type SourceObservation={scope:SourceScope;root:SourceRoot;version:SourceVersion}
/** Final metadata-only barrier. Every earlier resource is acquired with a try
 * lock by the definer; a failure aborts the caller's entire transaction. */
async function lockSourceObservations(client:Pick<pg.PoolClient,'query'>,observations:readonly SourceObservation[],retained:boolean){
 // SAVEPOINT release is not a commit. The owning idempotency transaction
 // repeats its attached preparations/guards at the physical boundary.
 if(sourceConnectionKey(client)!==client)return
 for(const o of [...observations].sort((a,b)=>canonicalJsonString([a.scope.installationId,a.root]).localeCompare(canonicalJsonString([b.scope.installationId,b.root])))){
  const fn=['relay_event','legacy_archive'].includes(o.root.kind)?'lock_memory_personal_source_commit':'lock_memory_team_source_commit'
  const result=await client.query(`SELECT shared.${fn}($1::jsonb,$2,$3,$4::jsonb,$5::boolean) AS locked`,[JSON.stringify(o.scope),o.root.kind,o.root.key,JSON.stringify(o.version),retained])
  if(result.rows[0]?.locked!==true)throw Error('source_reference_changed')
 }
}
export interface PreparedEvent {
 source_event_id:string;installation_id:string;session_id:string|null;turn_id:string|null;origin:string;origin_position:string;event_type:string;occurred_at:Date
 payload_hash:Buffer;classification:Record<string,unknown>;source_provenance:Record<string,unknown>;body_reclaimed_at:Date|null;row_version:string
 payload:Record<string,unknown>;source_version?:unknown;source_kind?:string;canonical_key?:string;mapping_state?:string;content_hash?:Buffer
}
const metadata=`source_event_id::text,installation_id::text,session_id,turn_id,origin,origin_position,event_type,occurred_at,payload_hash,classification,source_provenance,body_reclaimed_at,xmin::text AS row_version,
 s.source_version,s.source_kind,s.canonical_key,s.mapping_state,s.content_hash`
const clone=(row:PreparedEvent):PreparedEvent=>({...row,payload:structuredClone(row.payload),payload_hash:Buffer.from(row.payload_hash),...(row.content_hash?{content_hash:Buffer.from(row.content_hash)}:{}),classification:structuredClone(row.classification),source_provenance:structuredClone(row.source_provenance)})
const stamp=(rows:PreparedEvent[])=>canonicalJsonString(rows.map(r=>({id:r.source_event_id,installation:r.installation_id,session:r.session_id,turn:r.turn_id,origin:r.origin,position:r.origin_position,type:r.event_type,at:new Date(r.occurred_at).toISOString(),hash:r.payload_hash.toString('hex'),contentHash:r.content_hash?.toString('hex'),classification:r.classification,provenance:r.source_provenance,reclaimed:r.body_reclaimed_at?String(r.body_reclaimed_at):null,row:r.row_version,descriptor:r.source_version,kind:r.source_kind,key:r.canonical_key,mapping:r.mapping_state})).sort((a,b)=>a.id.localeCompare(b.id)))
async function mode(db:Db,installationId:string,shared:boolean){
 if(!shared)return {mode:'legacy-feed',generation:'1'}
 return (await db.query("SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1",[installationId])).rows[0]??{mode:'legacy-feed',generation:'1'}
}
export interface PreparedSources {readonly bodyBytes?:number;readonly events:PreparedEvent[];assertCurrent(client:Pick<pg.PoolClient,'query'>,options?:SourceCommitOptions):Promise<void>}
const attached=new WeakMap<object,PreparedSources>()
export const detachPreparedSources=(client:object)=>attached.delete(sourceConnectionKey(client))
export function attachPreparedSources(client:object,prepared:PreparedSources):void {attached.set(sourceConnectionKey(client),prepared)}
export function preparedSourceEvents(client:object,installationId:string,turnId?:string):PreparedEvent[]|undefined {
 const prepared=attached.get(sourceConnectionKey(client))
 return prepared?.events.filter(e=>e.installation_id===installationId&&(turnId===undefined||e.turn_id===turnId))
}
/** Resolve bounded stable UUIDs before BEGIN. Shared modes never read the
 * compatibility payload. assertCurrent performs metadata/current-version SQL
 * only. Callers take authority/local advisory fences before locking refs; this
 * metadata check does not replace the authority commit barrier. */
export async function prepareSourceReferences(pool:pg.Pool,installationId:string,ids:readonly string[]):Promise<PreparedSources>{
 if(ids.length>4096)throw Error('source_reference_limit')
 if(new Set(ids).size!==ids.length)throw Error('source_reference_duplicate')
 const deferred=deferredSourcePreparation<PreparedSources>(pool,canonicalJsonString(['references',installationId,[...ids].sort()]),physical=>prepareSourceReferences(physical,installationId,ids))
 if(deferred)return deferred
 const context=sourcePoolContext(pool),initialMode=await mode(pool,installationId,context.namespace==='memory')
 if(initialMode.mode==='paused')throw Error('source_mode_paused')
 if(!['legacy-feed','shared-shadow','shared-active'].includes(initialMode.mode))throw Error('source_mode_invalid')
 const shared=initialMode.mode==='shared-active'||(initialMode.mode==='shared-shadow'&&sourceExecutionBranchFor(pool,installationId)!=='legacy-active'),events:PreparedEvent[]=[],observations:{scope:SourceScope;root:SourceRoot;version:SourceVersion}[]=[]
 const semanticPreparations:Awaited<ReturnType<typeof prepareTeamSemanticReferences>>[]=[]
 const admissions=new Map<string,Awaited<ReturnType<typeof prepareSourceProjectionAdmission>>>()
 let bytes=0
 for(let n=0;n<ids.length;n+=256){
  const batch=ids.slice(n,n+256)
  const rows=(await pool.query<PreparedEvent>(`SELECT ${metadata}${shared?'':',payload'} FROM source_events s WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) ORDER BY source_event_id`,[installationId,batch])).rows
  if(rows.length!==batch.length)throw Error('source_reference_missing')
  for(const row of rows)if(row.body_reclaimed_at)throw Error('source_reference_reclaimed')
  if(shared){
   if(rows.some(r=>r.mapping_state!=='verified'||!r.source_kind||!r.canonical_key))throw Error('source_reference_unproven')
   const semanticRows=rows.filter(r=>r.source_kind==='team_semantic'),rawRows=rows.filter(r=>r.source_kind!=='team_semantic')
   if(semanticRows.length){
    const preparation=await prepareTeamSemanticReferences(pool,installationId,semanticRows)
    semanticPreparations.push(preparation)
    for(const row of semanticRows)row.payload=preparation.bodies.get(row.source_event_id)!
   }
   const contexts=rawRows.length?(await pool.query('SELECT * FROM shared.memory_source_ref_context($1::uuid,$2::uuid[])',[installationId,rawRows.map(r=>r.source_event_id)])).rows:[]
   const reader=createObservedSourceReader(pool,context.archive),groups=new Map<string,{scope:SourceScope;root:SourceRoot;rows:PreparedEvent[]}>()
   for(const row of rawRows){
    const binding=contexts.find(c=>c.source_event_id===row.source_event_id)?.context
    if(!binding?.scope||!binding.root)throw Error('source_reference_scope_unavailable')
    const key=canonicalJsonString(binding),group=groups.get(key)??{...binding,rows:[]};group.rows.push(row);groups.set(key,group)
   }
   for(const group of groups.values()){
    const page=await reader.getHeads(group.scope,group.root,group.rows.map(r=>r.canonical_key!))
    if(sourceExecutionBranchFor(pool,installationId)==='canonical-active'&&group.root.kind!=='legacy_archive'){
     const key=canonicalJsonString(group.root)
     if(!admissions.has(key)){
      const admission=await prepareSourceProjectionAdmission(pool,group.scope,group.root)
      admissions.set(key,admission);observations.push(...admission.observations)
     }
     admissions.get(key)!.requireScope(group.scope)
    }
    const bodies=await reader.resolveBodies(group.scope,group.root,page.heads,page.version)
    for(let i=0;i<group.rows.length;i++){
     const row=group.rows[i],body=bodies[i]
     if(row.event_type!==body.head.eventType||!row.content_hash?.equals(Buffer.from(body.head.contentHash,'hex'))||canonicalJsonString(row.classification)!==canonicalJsonString(body.head.classification))throw Error('source_reference_hash_mismatch')
     row.payload=body.payload as Record<string,unknown>
    }
    observations.push({scope:group.scope,root:group.root,version:page.version})
   }
  }
  for(const row of rows){
   if(!row.payload||!verifyOriginalSourceHash({origin:row.origin,originPosition:row.origin_position,eventType:row.event_type,occurredAt:row.occurred_at,payload:row.payload,payloadHash:row.payload_hash}))throw Error('source_reference_hash_mismatch')
   if(shared&&row.source_kind==='relay_event'&&!canonicalPayloadHash(row.payload).equals(row.payload_hash)&&row.canonical_key!==row.origin_position)throw Error('source_reference_hash_mismatch')
   bytes+=Buffer.byteLength(canonicalJsonString(row.payload));if(bytes>32*1024*1024)throw Error('source_reference_byte_limit')
   events.push(clone(row))
  }
 }
 const initial=stamp(events),ordered=[...events].sort((a,b)=>new Date(a.occurred_at).getTime()-new Date(b.occurred_at).getTime()||a.source_event_id.localeCompare(b.source_event_id))
 return {bodyBytes:bytes,get events(){return ordered.map(clone)},async assertCurrent(client,options){
  const current=await mode(client as Db,installationId,context.namespace==='memory')
  if(current.mode!==initialMode.mode||current.generation!==initialMode.generation)throw Error('source_reference_changed')
  for(const preparation of semanticPreparations)await preparation.assertCurrent(client,options?.forCommit===true)
  for(const admission of admissions.values())await admission.assertCurrent(client as Db)
  // No archive/storage IO may occur while the caller holds a transaction.
  const reader=createObservedSourceReader(client as unknown as pg.Pool)
  for(const o of [...observations].sort((a,b)=>canonicalJsonString(a.root).localeCompare(canonicalJsonString(b.root)))){
   const state=await reader.checkCurrent(o.scope,o.root,o.version)
   if(state.state!=='current')throw Error('source_reference_changed')
  }
  const fresh:PreparedEvent[]=[]
  for(let n=0;n<ids.length;n+=256)fresh.push(...(await client.query<PreparedEvent>(`SELECT ${metadata} FROM source_events s WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) ORDER BY source_event_id FOR SHARE NOWAIT`,[installationId,ids.slice(n,n+256)])).rows)
  if(fresh.length!==events.length||stamp(fresh)!==initial)throw Error('source_reference_changed')
  if(options?.forCommit)await lockSourceObservations(client,observations,false)
 }}
}
export async function prepareTurnSources(pool:pg.Pool,installationId:string,turnId:string):Promise<PreparedSources>{
 const ids=(await pool.query('SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND turn_id=$2 ORDER BY source_event_id LIMIT 4097',[installationId,turnId])).rows.map(r=>r.source_event_id)
 return prepareSourceReferences(pool,installationId,ids)
}
/** The membership of a whole turn is part of its snapshot, including explicit
 * lifecycle repository observations. New refs cannot silently disappear from
 * an in-flight compile just because its original UUID list still exists. */
export async function prepareEpisodeSources(pool:pg.Pool,installationId:string,turnId:string):Promise<PreparedSources>{
 const query=`SELECT s.source_event_id::text FROM source_events s JOIN source_turns t ON t.installation_id=s.installation_id AND t.turn_id=$2
  WHERE s.installation_id=$1 AND(s.turn_id=$2 OR(s.turn_id IS NULL AND s.session_id=t.session_id AND s.event_type IN('session_created','session_discovered') AND s.occurred_at<=t.terminal_at))
  ORDER BY s.source_event_id LIMIT 4097`
 const ids=(await pool.query(query,[installationId,turnId])).rows.map(r=>r.source_event_id)
 const prepared=await prepareSourceReferences(pool,installationId,ids)
 return {bodyBytes:prepared.bodyBytes,get events(){return prepared.events},async assertCurrent(client,options){
  await prepared.assertCurrent(client,options)
  const current=(await client.query(query,[installationId,turnId])).rows.map(r=>r.source_event_id)
  if(canonicalJsonString(current)!==canonicalJsonString(ids))throw Error('source_reference_changed')
 }}
}
export async function prepareCurationSources(pool:pg.Pool,installationId:string,bundleId:string):Promise<PreparedSources|null>{
 const current=(await pool.query(`SELECT b.session_id,COALESCE(p.task_key,b.task_key) AS task_key FROM memory_task_bundles b
  LEFT JOIN memory_task_bundles p ON p.installation_id=b.installation_id AND p.bundle_id=b.parent_bundle_id
  WHERE b.installation_id=$1 AND b.bundle_id=$2`,[installationId,bundleId])).rows[0]
 if(!current)return null
 const catalog=(await pool.query(`SELECT p.task_key FROM memory_task_bundles b JOIN memory_task_bundles p ON p.installation_id=b.installation_id AND p.bundle_id=b.parent_bundle_id
  WHERE b.installation_id=$1 AND b.session_id=$2 AND b.bundle_kind='task' AND b.body_state='present' AND p.body_state='present' AND b.parent_revision=p.revision
  ORDER BY b.updated_at DESC,b.bundle_id LIMIT 64`,[installationId,current.session_id])).rows
 const turns=[...new Set([current,...catalog].filter(r=>typeof r.task_key==='string'&&r.task_key.startsWith('source:')).map(r=>r.task_key.slice(7)))]
 const query='SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND session_id=$2 AND turn_id=ANY($3::text[]) ORDER BY source_event_id LIMIT 4097'
 const args=[installationId,current.session_id,turns],ids=(await pool.query(query,args)).rows.map(r=>r.source_event_id)
 const prepared=await prepareSourceReferences(pool,installationId,ids)
 return {bodyBytes:prepared.bodyBytes,get events(){return prepared.events},async assertCurrent(client,options){
  await prepared.assertCurrent(client,options)
  const fresh=(await client.query(query,args)).rows.map(r=>r.source_event_id)
  if(canonicalJsonString(fresh)!==canonicalJsonString(ids))throw Error('source_reference_changed')
 }}
}
/** Retained excerpts have their own body lifecycle. This authorizes only the
 * retained material: it never returns canonical bodies or bypasses tombstones. */
export async function prepareSourceAuthorities(pool:pg.Pool,installationId:string,ids:readonly string[]):Promise<{assertCurrent(client:Pick<pg.PoolClient,'query'>,options?:SourceCommitOptions):Promise<void>}>{
 if(ids.length>4096||new Set(ids).size!==ids.length)throw Error('source_reference_limit')
 const context=sourcePoolContext(pool),initialMode=await mode(pool,installationId,context.namespace==='memory'),rows:PreparedEvent[]=[],observations:{scope:SourceScope;root:SourceRoot;version:SourceVersion}[]=[]
 if(!['shared-shadow','shared-active'].includes(initialMode.mode))throw Error('source_mode_invalid')
 const reader=createObservedSourceReader(pool),observedBindings=new Set<string>(),semanticPreparations:Awaited<ReturnType<typeof prepareTeamSemanticReferences>>[]=[]
 for(let n=0;n<ids.length;n+=256){
  const batch=ids.slice(n,n+256),metadataRows=(await pool.query<PreparedEvent>(`SELECT ${metadata} FROM source_events s WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) ORDER BY source_event_id`,[installationId,batch])).rows
  if(metadataRows.length!==batch.length)throw Error('source_reference_missing')
  const semanticRows=metadataRows.filter(r=>r.source_kind==='team_semantic'),rawRows=metadataRows.filter(r=>r.source_kind!=='team_semantic')
  if(semanticRows.length)semanticPreparations.push(await prepareTeamSemanticReferences(pool,installationId,semanticRows,true))
  const scopes=rawRows.length?(await pool.query('SELECT * FROM shared.memory_source_ref_context($1::uuid,$2::uuid[])',[installationId,rawRows.map(r=>r.source_event_id)])).rows:[]
  for(const row of rawRows){
   const bound=scopes.find(s=>s.source_event_id===row.source_event_id)?.context
   if(!bound)throw Error('source_reference_scope_unavailable')
   const bindingKey=canonicalJsonString(bound)
   if(observedBindings.has(bindingKey))continue
   const current=await reader.checkAuthority(bound.scope,bound.root)
   if(current.state!=='current')throw Error('source_reference_changed')
   observedBindings.add(bindingKey)
   observations.push({...bound,version:current.version})
  }
  rows.push(...metadataRows)
 }
 const initial=stamp(rows)
 return {async assertCurrent(client,options){
  const freshMode=await mode(client as Db,installationId,true)
  if(canonicalJsonString(initialMode)!==canonicalJsonString(freshMode))throw Error('source_reference_changed')
  for(const preparation of semanticPreparations)await preparation.assertCurrent(client,options?.forCommit===true)
  const currentReader=createObservedSourceReader(client as unknown as pg.Pool)
  for(const bound of observations)if((await currentReader.checkAuthority(bound.scope,bound.root,bound.version)).state!=='current')throw Error('source_reference_changed')
  const fresh:PreparedEvent[]=[]
  for(let n=0;n<ids.length;n+=256)fresh.push(...(await client.query<PreparedEvent>(`SELECT ${metadata} FROM source_events s WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) ORDER BY source_event_id FOR SHARE NOWAIT`,[installationId,ids.slice(n,n+256)])).rows)
  if(fresh.length!==rows.length||stamp(fresh)!==initial)throw Error('source_reference_changed')
  if(options?.forCommit)await lockSourceObservations(client,observations,true)
 }}
}

const unavailableCodes=new Set(['source_preparation_required','source_reference_limit','source_reference_duplicate','source_mode_paused','source_mode_invalid','source_reference_missing','source_reference_reclaimed','source_reference_unproven','source_reference_scope_unavailable','source_reference_hash_mismatch','source_reference_byte_limit','source_reference_changed','source_artifact_changed'])
export const preparedSourceUnavailable=(error:unknown):boolean=>error instanceof Error&&(error.name==='SourceUnavailableError'||unavailableCodes.has(error.message))
