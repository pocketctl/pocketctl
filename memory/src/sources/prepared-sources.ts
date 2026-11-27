import {DialogueExcluded,prepareDialogue} from '../episodes/turn-dialogue.js'
import {prepareExcludedLifecycleTurn,type LifecycleDigestEvent} from '../curation/prepare-lifecycle-turn.js'
import {boundedSourceQuery} from './bounded-source-query.js'
import {snapshotMemorySql,snapshotProvenanceSql} from './snapshot-provenance.js'
import {prepareTeamSemanticReferences} from './team-semantic-reader.js'
import {deferredSourcePreparation} from './deferred-preparation.js'
import {createObservedSourceReader,createObservedPersonalMetadataReader} from './observed-reader.js'
import type pg from 'pg'
import {canonicalPayloadHash,canonicalJsonString,verifyOriginalSourceHash,SourceUnavailableError,type SourceScope,type SourceRoot,type SourceVersion,type SourceHead} from '@pocketctl/session-source'
import {sourcePoolContext,sourceConnectionKey} from './pool-context.js'
import {sourceExecutionBranchFor,metadataSourceExecution,protectMetadataSourceBodies,guardSourceExecutionCommit} from './source-execution.js'
import {JobDeferredError} from '../jobs/types.js'
import {SelectedSourceLockBusy} from './processing-pins.js'
import {prepareMetadataScope,personalMetadataEnvelope} from './source-projection-admission.js'
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
const metadata=`source_event_id::text,installation_id::text,session_id,turn_id,origin,origin_position,event_type,occurred_at,payload_hash,classification,${snapshotProvenanceSql('s')} AS source_provenance,body_reclaimed_at,xmin::text AS row_version,
 s.source_version,s.source_kind,s.canonical_key,s.mapping_state,s.content_hash`
// New archive identities are resolved independently, including the commit
// reread. The archive root fence serializes archive mutation with commit.
async function referenceHeaders(db:Pick<pg.Pool,'query'>,installation:string,ids:readonly string[],shared:boolean,lock=false,historicalProjection=false){
 const archives=shared?(await db.query<PreparedEvent>('SELECT * FROM shared.memory_archive_reference_headers($1,$2::uuid[])',[installation,ids])).rows:[]
 const archived=new Set(archives.map(r=>r.source_event_id))
 const other=ids.filter(id=>!archived.has(id))
 if(!other.length)return archives
 const semantic=shared?(await db.query<PreparedEvent>(`SELECT g.semantic_ref_id AS source_event_id,g.installation_id,
  g.semantic_session_id AS session_id,g.semantic_turn_id AS turn_id,'canonical' AS origin,'team_semantic:'||g.semantic_key AS origin_position,
  g.event_type,g.occurred_at,g.semantic_payload_hash AS payload_hash,g.classification,NULL::timestamptz AS body_reclaimed_at,
  g.xmin::text||':'||p.xmin::text AS row_version,'team_semantic' AS source_kind,g.semantic_key AS canonical_key,'verified' AS mapping_state,
  g.semantic_payload_hash AS content_hash,jsonb_build_object('normalization','team-semantic-v1','businessDigest',encode(g.business_digest,'hex'),
   'originalSupportDigest',encode(p.support_digest,'hex')) AS source_version,
  jsonb_build_object('source_kind','team_semantic','source_version',1,'normalization_version','team-semantic-v1','native_kind',g.source_kind,
   'structured_identity',g.structured_identity,'receiving_installation_id',g.installation_id::text,'owner_scope_kind',g.owner_scope_kind,
   'owner_scope_id',g.owner_scope_id,'binding_id',g.binding_id,'binding_revision',g.binding_revision,
   'semantic_session_id',g.semantic_session_id,'semantic_turn_id',g.semantic_turn_id,'role',g.structured_identity->>-1,
   'business_digest',encode(g.business_digest,'hex'),'native',g.semantic_provenance->'team') AS source_provenance
  FROM memory_team_semantic_groups g JOIN memory_team_semantic_publications p ON p.installation_id=g.installation_id
    AND p.semantic_turn_id=g.semantic_turn_id AND g.semantic_ref_id IN(p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id)
  WHERE g.installation_id=$1 AND g.semantic_ref_id=ANY($2::uuid[]) AND g.registration_state='published'
   AND p.disposition IN('published','legacy_related') ORDER BY g.semantic_ref_id ${lock?'FOR SHARE OF g,p NOWAIT':''}`,[installation,other])).rows:[]
 const native=[...archives,...semantic]
 const resolved=new Set(semantic.map(r=>r.source_event_id))
 const pending=other.filter(id=>!resolved.has(id))
 if(!pending.length)return native
 if(shared&&!historicalProjection){
  const team=(await db.query<PreparedEvent>('SELECT * FROM shared.memory_team_reference_headers($1,$2::uuid[])',[installation,pending])).rows
  return [...native,...team].sort((a,b)=>a.source_event_id.localeCompare(b.source_event_id))
 }
 const rows=(await db.query<PreparedEvent>(`SELECT ${metadata}${shared||lock?'':',payload'} FROM source_events s
  WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) ${shared?"AND source_kind IS DISTINCT FROM 'legacy_archive' AND source_kind IS DISTINCT FROM 'team_semantic'":''}
  ORDER BY source_event_id ${lock?'FOR SHARE NOWAIT':''}`,[installation,pending])).rows
 return [...native,...rows].sort((a,b)=>a.source_event_id.localeCompare(b.source_event_id))
}
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
export function prepareSourceReferences(pool:pg.Pool,installationId:string,ids:readonly string[]):Promise<PreparedSources>{return prepareSourceReferencesInternal(pool,installationId,ids)}
async function prepareSourceReferencesInternal(pool:pg.Pool,installationId:string,ids:readonly string[],selectedEpisode=false):Promise<PreparedSources>{
 const originalExecution=selectedEpisode?metadataSourceExecution(pool,installationId).token:undefined
 if(selectedEpisode&&sourceConnectionKey(pool)!==pool)throw Error('source_metadata_requires_physical_pool')
 if(ids.length>4096)throw Error('source_reference_limit')
 if(new Set(ids).size!==ids.length)throw Error('source_reference_duplicate')
 const deferred=deferredSourcePreparation<PreparedSources>(pool,canonicalJsonString(['references',installationId,[...ids].sort()]),physical=>prepareSourceReferences(physical,installationId,ids))
 if(deferred)return deferred
 const context=sourcePoolContext(pool),initialMode=await mode(pool,installationId,context.namespace==='memory')
 if(initialMode.mode==='paused')throw Error('source_mode_paused')
 if(context.namespace==='memory' && initialMode.mode!=='shared-active')throw Error('source_reference_unavailable')
 const shared=initialMode.mode==='shared-active',events:PreparedEvent[]=[],observations:{scope:SourceScope;root:SourceRoot;version:SourceVersion}[]=[]
 const semanticPreparations:Awaited<ReturnType<typeof prepareTeamSemanticReferences>>[]=[]
 const metadataObservations:{scope:SourceScope;root:SourceRoot;envelope:unknown}[]=[]
 let bytes=0
 for(let n=0;n<ids.length;n+=256){
  const batch=ids.slice(n,n+256)
  const rows=await referenceHeaders(pool,installationId,batch,shared,false,selectedEpisode)
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
   const bindings=new Map(contexts.map(c=>[c.source_event_id,c.context]))
   const reader=createObservedSourceReader(pool,context.archive),groups=new Map<string,{scope:SourceScope;root:SourceRoot;rows:PreparedEvent[]}>()
   for(const row of rawRows){
    const binding=bindings.get(row.source_event_id)
    if(!binding?.scope||!binding.root)throw Error('source_reference_scope_unavailable')
    const key=canonicalJsonString(binding),group=groups.get(key)??{...binding,rows:[]};group.rows.push(row);groups.set(key,group)
   }
   for(const group of groups.values()){
    let page:{heads:readonly SourceHead[];version:SourceVersion},bodies
    const selected=selectedEpisode&&group.root.kind==='relay_event'&&group.scope.ownerScopeKind==='personal'
    if(selected){
     const seal=await prepareMetadataScope(pool,group.scope,group.root),metadataReader=createObservedPersonalMetadataReader(pool)
     let view:Awaited<ReturnType<typeof metadataReader.selectKeys>>
     try{
      view=await metadataReader.selectKeys(group.scope,group.root,group.rows.map(r=>r.canonical_key!))
      bodies=await metadataReader.resolve(view)
     }catch(error){
      // No episode output or transaction exists yet. Only the reader's typed
      // invalidation yields to fresh job preparation; denials stay failures.
      if(error instanceof SourceUnavailableError&&error.code==='changed')throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
      throw error
     }
     page={heads:view.heads,version:view.observedVersion}
     metadataObservations.push({scope:group.scope,root:group.root,envelope:personalMetadataEnvelope(pool,group.scope,group.root,metadataReader.proof(view),seal,'episode')})
    }else page=await reader.getHeads(group.scope,group.root,group.rows.map(r=>r.canonical_key!))
    if(!selected&&sourceExecutionBranchFor(pool,installationId)==='canonical-active'&&group.root.kind!=='legacy_archive'){
     // Raw Team and historical per-event handles are evidence only. Model
     // inputs require either a native dialogue or a semantic publication.
     throw Error('source_reference_unavailable')
    }
    bodies??=await reader.resolveBodies(group.scope,group.root,[...page.heads],page.version)
    for(let i=0;i<group.rows.length;i++){
     const row=group.rows[i],body=bodies[i]
     if(row.event_type!==body.head.eventType||!row.content_hash?.equals(Buffer.from(body.head.contentHash,'hex'))||canonicalJsonString(row.classification)!==canonicalJsonString(body.head.classification))throw Error('source_reference_hash_mismatch')
     row.payload=body.payload as Record<string,unknown>
    }
    if(!selected)observations.push({scope:group.scope,root:group.root,version:page.version})
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
  if(selectedEpisode&&metadataSourceExecution(pool,installationId).token!==originalExecution)throw Error('source_execution_scope_mismatch')
  await lockEpisodeSelections(client,metadataObservations)
  const current=await mode(client as Db,installationId,context.namespace==='memory')
  if(current.mode!==initialMode.mode||current.generation!==initialMode.generation)throw Error('source_reference_changed')
  for(const preparation of semanticPreparations)await preparation.assertCurrent(client,options?.forCommit===true)
  // No archive/storage IO may occur while the caller holds a transaction.
  const reader=createObservedSourceReader(client as unknown as pg.Pool)
  for(const o of [...observations].sort((a,b)=>canonicalJsonString(a.root).localeCompare(canonicalJsonString(b.root)))){
   const state=await reader.checkCurrent(o.scope,o.root,o.version)
   if(state.state!=='current')throw Error('source_reference_changed')
  }
  const fresh:PreparedEvent[]=[]
  for(let n=0;n<ids.length;n+=256)fresh.push(...await referenceHeaders(client,installationId,ids.slice(n,n+256),shared,true,selectedEpisode))
  if(fresh.length!==events.length||stamp(fresh)!==initial)throw Error('source_reference_changed')
  if(options?.forCommit)await lockSourceObservations(client,observations,false)
 }}
}
type EpisodeSelection={scope:SourceScope;root:SourceRoot;envelope:unknown}
async function lockEpisodeSelections(client:Db,observations:readonly EpisodeSelection[]){
  for(const observation of observations){
   try{
    const locked=(await client.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',
     [JSON.stringify(observation.scope),observation.root.kind,observation.root.key,JSON.stringify(observation.envelope)])).rows[0]?.locked
    if(locked!==true)throw Error('source_reference_changed')
   }catch(error){
    const code=(error as {code?:string}).code,message=(error as Error).message
    // A proven old-scan replacement is a distinct version wait, never a
    // generic FALSE/busy conversion. The old proof produces no output.
    if(code==='55P03'&&message==='source_metadata_lock_busy')throw new SelectedSourceLockBusy()
    if(code==='P0001'&&message==='source_metadata_scan_changed')throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
    throw error
   }
  }
}
export async function prepareTurnSources(pool:pg.Pool,installationId:string,turnId:string):Promise<PreparedSources>{
 const ids=(await pool.query('SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND turn_id=$2 ORDER BY source_event_id LIMIT 4097',[installationId,turnId])).rows.map(r=>r.source_event_id)
 return prepareSourceReferences(pool,installationId,ids)
}
/** The membership of a whole turn is part of its snapshot, including explicit
 * lifecycle repository observations. New refs cannot silently disappear from
 * an in-flight compile just because its original UUID list still exists. */
const episodeMembershipQuery=`WITH turn AS(SELECT installation_id,session_id,terminal_at FROM source_turns WHERE installation_id=$1 AND turn_id=$2)
  SELECT refs.source_event_id::text FROM(
   SELECT s.source_event_id FROM source_events s JOIN turn t ON t.installation_id=s.installation_id
    WHERE s.installation_id=$1 AND s.turn_id=$2
   UNION ALL
   SELECT s.source_event_id FROM source_events s JOIN turn t ON t.installation_id=s.installation_id AND t.session_id=s.session_id
    WHERE s.installation_id=$1 AND s.turn_id IS NULL AND s.event_type IN('session_created','session_discovered') AND s.occurred_at<=t.terminal_at
  )refs ORDER BY refs.source_event_id LIMIT 4097`
export async function prepareEpisodeSources(pool:pg.Pool,installationId:string,turnId:string):Promise<PreparedSources>{
 // Keep the two disjoint memberships independently indexable. Same-turn refs
 // include old aliases/other sessions and reclaimed rows; preparation must see
 // those rows to fail closed. Both branches still require the source turn.
 const query=episodeMembershipQuery
 const ids=(await pool.query(query,[installationId,turnId])).rows.map(r=>r.source_event_id)
 const prepared=await prepareSourceReferences(pool,installationId,ids)
 return {bodyBytes:prepared.bodyBytes,get events(){return prepared.events},async assertCurrent(client,options){
  await prepared.assertCurrent(client,options)
  const current=(await client.query(query,[installationId,turnId])).rows.map(r=>r.source_event_id)
  if(canonicalJsonString(current)!==canonicalJsonString(ids))throw Error('source_reference_changed')
 }}
}
export async function prepareCurationSources(pool:pg.Pool,installationId:string,bundleId:string,catalogIds?:readonly string[]):Promise<(PreparedSources & {intake?:PreparedSources})|null>{
 const current=(await pool.query(`SELECT b.session_id,COALESCE(p.task_key,b.task_key) AS task_key FROM memory_task_bundles b
  LEFT JOIN memory_task_bundles p ON p.installation_id=b.installation_id AND p.bundle_id=b.parent_bundle_id
  WHERE b.installation_id=$1 AND b.bundle_id=$2`,[installationId,bundleId])).rows[0]
 if(!current)return null
 const catalog=catalogIds?.length===0?[]:(await pool.query(`SELECT p.task_key FROM memory_task_bundles b JOIN memory_task_bundles p ON p.installation_id=b.installation_id AND p.bundle_id=b.parent_bundle_id
  WHERE b.installation_id=$1 AND b.session_id=$2 AND b.bundle_kind='task' AND b.body_state='present' AND p.body_state='present' AND b.parent_revision=p.revision
  AND ($3::uuid[] IS NULL OR b.bundle_id=ANY($3::uuid[])) ORDER BY b.updated_at DESC,b.bundle_id LIMIT 64`,[installationId,current.session_id,catalogIds??null])).rows
 if(current.task_key?.startsWith('dialogue:')){
  const turns=new Set<string>([current,...catalog].filter(r=>r.task_key?.startsWith('dialogue:')).map(r=>r.task_key.slice('dialogue:'.length)))
  const inputs:Awaited<ReturnType<typeof prepareDialogue>>[]=[]
  for(const turn of turns){
   try{inputs.push(await prepareDialogue(pool,installationId,current.session_id,turn))}
   catch(error){
    if(!(error instanceof DialogueExcluded))throw error
    if(current.task_key==='dialogue:'+turn)return null
    // Skip a withdrawn routing hint without blocking unrelated turns.
   }
  }
  return {intake:inputs[0],events:inputs.flatMap(i=>i.events),async assertCurrent(client,options){
   for(const input of inputs)await input.assertCurrent(client,options)
  }} satisfies PreparedSources & {intake?:PreparedSources}
 }
 if(sourcePoolContext(pool).namespace==='memory')throw Error('source_reference_unavailable')
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
 if(initialMode.mode!=='shared-active')throw Error('source_mode_invalid')
 const reader=createObservedSourceReader(pool),observedBindings=new Set<string>(),semanticPreparations:Awaited<ReturnType<typeof prepareTeamSemanticReferences>>[]=[]
 for(let n=0;n<ids.length;n+=256){
  const batch=ids.slice(n,n+256),metadataRows=await referenceHeaders(pool,installationId,batch,true)
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
  for(let n=0;n<ids.length;n+=256)fresh.push(...await referenceHeaders(client,installationId,ids.slice(n,n+256),true,true))
  if(fresh.length!==rows.length||stamp(fresh)!==initial)throw Error('source_reference_changed')
  if(options?.forCommit)await lockSourceObservations(client,observations,true)
 }}
}

const unavailableCodes=new Set(['source_preparation_required','source_reference_limit','source_reference_duplicate','source_mode_paused','source_mode_invalid','source_reference_missing','source_reference_reclaimed','source_reference_unproven','source_reference_scope_unavailable','source_reference_hash_mismatch','source_reference_byte_limit','source_reference_changed','source_artifact_changed'])
export const preparedSourceUnavailable=(error:unknown):boolean=>error instanceof Error&&(error.name==='SourceUnavailableError'||unavailableCodes.has(error.message))

type ExcludedEpisode = {excludedLifecycle: NonNullable<ReturnType<typeof prepareExcludedLifecycleTurn>>;assertCurrent: PreparedSources['assertCurrent']}
type EpisodeFence = {readonly sessionId:string;fenceMembership(client:pg.PoolClient):Promise<void>}
export type PreparedEpisodeProjectionSources = PreparedSources & EpisodeFence

async function prepareExcludedEpisode(pool:pg.Pool,installationId:string,sessionId:string,turnId:string,ids:string[]):Promise<ExcludedEpisode|null>{
 const rows=(await pool.query<LifecycleDigestEvent & {turn_id:string|null;canonical_key:string;row_version:string}>(`
  SELECT source_event_id::text,turn_id,canonical_key,xmin::text AS row_version,event_type,occurred_at,
   payload_hash,${snapshotProvenanceSql('s')} AS source_provenance FROM source_events s
  WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) AND session_id=$3 AND canonical_session_key=$3
   AND source_kind='relay_event' AND mapping_state='verified' AND body_reclaimed_at IS NULL AND content_hash=payload_hash
   AND canonical_key ~ '^[1-9][0-9]{0,18}$' AND (length(canonical_key)<19 OR canonical_key COLLATE "C"<='9223372036854775807')
  ORDER BY source_event_id`,[installationId,ids,sessionId])).rows
 if(rows.length!==ids.length)return null
 const turnEvents=rows.filter(row=>row.turn_id===turnId)
 if(!turnEvents.length)return null
 const excludedLifecycle=prepareExcludedLifecycleTurn({installationId,sessionId,turnId,events:turnEvents})
 if(!excludedLifecycle)return null

 // All selected references have the same canonical session. Bind its current
 // personal scope once, then witness each row version and key in that scope.
 const binding=(await pool.query('SELECT context FROM shared.memory_source_ref_context($1::uuid,$2::uuid[])',[installationId,[ids[0]]])).rows[0]?.context
 if(binding?.scope?.ownerScopeKind!=='personal'||binding.root?.kind!=='relay_event')return null
 const {scope,root}=binding
 const seal=await prepareMetadataScope(pool,scope,root)
 const observations:EpisodeSelection[]=[]
 for(let i=0;i<rows.length;i+=256){
  const batch=rows.slice(i,i+256).sort((a,b)=>BigInt(a.canonical_key)<BigInt(b.canonical_key)?-1:1)
  await protectMetadataSourceBodies(pool,scope,root)
  let view
  try{
   view=(await boundedSourceQuery(pool,'SELECT value FROM shared.read_memory_relay_sources($1::jsonb,$2,NULL,$3,$4::bigint[]) AS value',
    [scope,root.key,batch.length,['-4',...batch.map(row=>row.canonical_key)]])).rows[0]?.value
  }catch(error){
   // Older contracts reject the header-only selector. Use full preparation.
   const code=(error as {code?:string}).code,message=(error as Error).message
   if(code==='P0001'){
    if(message==='invalid_source_metadata_request')return null
    if(message==='source_changed')throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
    if(message==='source_revoked'||message==='source_deleted')throw new SourceUnavailableError(message.slice(7))
    if(message==='source_metadata_proof_unavailable'||message==='source_input_start_unproven')throw new SourceUnavailableError(message)
   }
   if(code==='57014'||message==='source_query_deadline_exceeded')throw new SourceUnavailableError('source_store_timeout')
   if(code==='55P03'||code==='40001'||code==='40P01')throw new SourceUnavailableError('source_store_busy')
   throw error
  }
  if(view?.contract!=='personal-metadata-observation-v1'||view.rows?.length!==batch.length)return null
  for(const [index,row] of batch.entries()){
   const observed=view.rows[index]
   if(observed.id!==row.canonical_key||observed.ref?.id!==row.source_event_id||observed.ref?.rowVersion!==row.row_version||
    observed.contentHash!==row.payload_hash.toString('hex'))return null
  }
  observations.push({scope,root,envelope:personalMetadataEnvelope(pool,scope,root,{
   observedVersion:view.version,inputFingerprint:view.inputFingerprint,nativeSessionFingerprint:view.nativeSessionFingerprint,rows:view.rows,cold:[],
  },seal,'episode')})
 }
 return {excludedLifecycle,assertCurrent:client=>lockEpisodeSelections(client,observations)}
}
/** Internal deterministic compile entry. Public prepareEpisodeSources and all
 * generic model/API/evidence preparations remain whole-current and strict. */
export function prepareEpisodeProjectionSources(pool:pg.Pool,installationId:string,turnId:string):Promise<PreparedEpisodeProjectionSources|null>
export function prepareEpisodeProjectionSources(pool:pg.Pool,installationId:string,turnId:string,checkExclusion:boolean):Promise<((PreparedSources|ExcludedEpisode)&EpisodeFence)|null>
export async function prepareEpisodeProjectionSources(pool:pg.Pool,installationId:string,turnId:string,checkExclusion=false):Promise<((PreparedSources|ExcludedEpisode)&EpisodeFence)|null>{
 const execution=metadataSourceExecution(pool,installationId)
 const turnQuery=`SELECT to_jsonb(t)||jsonb_build_object('row_version',t.xmin::text) AS snapshot FROM source_turns t WHERE installation_id=$1 AND turn_id=$2`
 const turn=(await pool.query(turnQuery,[installationId,turnId])).rows[0]?.snapshot
 if(!turn?.terminal_at)throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
 const ids=(await pool.query(episodeMembershipQuery,[installationId,turnId])).rows.map(r=>r.source_event_id)
 if(!ids.length)return null
 // A plausible positive member routes directly to full preparation. This
 // conservative test only chooses a reader. It never grants admission.
 const checkHeaders=checkExclusion&&ids.length<=4096
 const candidates=(await pool.query(`SELECT bool_or(source_kind IS DISTINCT FROM 'relay_event') AS other_kind
   ${checkHeaders?`, bool_or(s.turn_id=$3 AND ${snapshotMemorySql('s')} @> '{"lineage_complete":true,"skill_state":"non_skill"}'::jsonb) AS possible_member`:''}
   FROM source_events s WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[])`,
  checkHeaders?[installationId,ids,turnId]:[installationId,ids])).rows[0]
 if(candidates.other_kind)return null
 const excluded=checkHeaders&&!candidates.possible_member?await prepareExcludedEpisode(pool,installationId,turn.session_id,turnId,ids):null
 const prepared=excluded??await prepareSourceReferencesInternal(pool,installationId,ids,true)
 const sameTurn=async(client:Pick<pg.PoolClient,'query'>)=>{
  if(metadataSourceExecution(pool,installationId).token!==execution.token)throw Error('source_execution_scope_mismatch')
  const current=(await client.query(turnQuery,[installationId,turnId])).rows[0]?.snapshot
  const members=(await client.query(episodeMembershipQuery,[installationId,turnId])).rows.map(r=>r.source_event_id)
  if(canonicalJsonString(current)!==canonicalJsonString(turn)||canonicalJsonString(members)!==canonicalJsonString(ids))throw Error('source_reference_changed')
 }
 const fence:EpisodeFence={sessionId:turn.session_id,async fenceMembership(client){
  await guardSourceExecutionCommit(client,installationId)
  // Native locks precede local derived locks. Subsequent assertions always
  // revalidate; there is no savepoint/transaction-ID selected-fence cache.
  await prepared.assertCurrent(client)
  try{
   if(!(await client.query('SELECT 1 FROM memory_installations WHERE installation_id=$1 FOR UPDATE NOWAIT',[installationId])).rowCount)throw Error('source_reference_changed')
  }catch(error){if((error as {code?:string}).code==='55P03')throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000));throw error}
  const locks=(await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0)) AS session,
   pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS installation`,[installationId,turn.session_id])).rows[0]
  if(!locks?.session||!locks.installation)throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
  try{await client.query('SELECT 1 FROM source_turns WHERE installation_id=$1 AND turn_id=$2 FOR SHARE NOWAIT',[installationId,turnId])}
  catch(error){if((error as {code?:string}).code==='55P03')throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000));throw error}
  await sameTurn(client)
 }}
 const assertCurrent:PreparedSources['assertCurrent']=async(client,options)=>{await prepared.assertCurrent(client,options);await sameTurn(client)}
 if('excludedLifecycle' in prepared)return {...fence,excludedLifecycle:prepared.excludedLifecycle,assertCurrent}
 return {...fence,bodyBytes:prepared.bodyBytes,get events(){return prepared.events},assertCurrent}
}
