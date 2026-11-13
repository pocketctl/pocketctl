import type pg from 'pg'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import {runSelectedSourceTransaction,SelectedSourceLockBusy} from './processing-pins.js'
import {canonicalJsonString,canonicalPayloadHash,SourceUnavailableError,teamReaderProjectionKey,type SourceHead,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {createObservedSourceReader} from './observed-reader.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {sourceExecutionBranchFor,sourceExecutionTokenFor,guardSourceExecutionCommit,completeSourceProjection} from './source-execution.js'
import {createObservedPersonalMetadataReader} from './observed-reader.js'
import {personalMetadataEnvelope,type MetadataScopeSeal} from './source-projection-admission.js'
import {projectCanonicalDerivedFact} from '../projection/source-projector.js'

interface MetadataWave {contract:'personal-metadata-wave-v1';through:string;after?:string;startVersion:SourceVersion;scopeHash:string;controlRevision:string;phase:'scanning'|'restart'}
interface MetadataPage {wave:MetadataWave;prior:unknown;envelope:unknown;exhausted:boolean;nextAfter?:string;contextReady?:boolean}
interface PreparedPage {pool:pg.Pool;execution:object|undefined;scope:SourceScope;root:SourceRoot;heads:SourceHead[];version:SourceVersion;payloads:Record<string,unknown>[];cursor?:string;nextCursor?:string;enumerated:boolean;metadata?:MetadataPage}
const pages=new WeakMap<object,PreparedPage>()
export interface CanonicalReferencePage {readonly token:object;readonly count:number;readonly nextCursor?:string;readonly hasMore:boolean}
export interface CanonicalReference {sourceEventId:string;canonicalKey:string;sessionId:string;created:boolean}
// Bound one recovery transaction while keeping SDK and SQL page limits intact.
export const ORIGINAL_REPAIR_MAX_ROWS=1024
export const ORIGINAL_REPAIR_PAGE_SIZE=64

function requireExecution(pool:pg.Pool,installationId:string):void{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('canonical_reference_requires_physical_pool')
 if(sourceExecutionBranchFor(pool,installationId)!=='canonical-active')throw Error('canonical_reference_execution_required')
}
/** Authoritative heads are prepared before BEGIN. The opaque token prevents
 * a caller from substituting an invented hash, identity, timestamp or scope. */
export async function prepareCanonicalReferencePage(pool:pg.Pool,scope:SourceScope,root:SourceRoot,options:{keys?:readonly string[];cursor?:string;limit?:number;expectedVersion?:SourceVersion}={}):Promise<CanonicalReferencePage>{
 scope=structuredClone(scope);root=structuredClone(root);options=structuredClone(options)
 requireExecution(pool,scope.installationId)
 if(root.kind==='legacy_archive'||options.keys&&(options.cursor!==undefined||options.limit!==undefined))throw Error('canonical_reference_request_invalid')
 const context=sourcePoolContext(pool),reader=createObservedSourceReader(pool,options.expectedVersion?undefined:context.archive)
 if(options.expectedVersion){
  if(!options.keys)throw Error('canonical_reference_request_invalid')
  const current=await reader.checkCurrent(scope,root,options.expectedVersion)
  if(current.state!=='current')throw new SourceUnavailableError(current.state)
 }
 const repair=options.expectedVersion
 if(repair&&(!options.keys?.length||options.keys.length>ORIGINAL_REPAIR_MAX_ROWS||new Set(options.keys).size!==options.keys.length))
  throw Error('canonical_reference_request_invalid')
 const page=options.keys?await reader.getHeads(scope,root,repair?options.keys.slice(0,ORIGINAL_REPAIR_PAGE_SIZE):options.keys)
  :await reader.listHeads(scope,root,{cursor:options.cursor,limit:options.limit??64})
 const heads:SourceHead[]=[],payloads:Record<string,unknown>[]=[]
 const readPage=async(current:{heads:SourceHead[];version:SourceVersion})=>{
  if(repair&&canonicalJsonString(current.version)!==canonicalJsonString(repair))throw new SourceUnavailableError('changed')
  if(repair&&current.heads.some(head=>head.storage!=='hot'))throw new JobTerminalError('source_context_set_changed')
  const selected=structuredClone(current.heads)
  const bodies=selected.length?await reader.resolveBodies(scope,root,selected,current.version):[]
  for(const body of bodies){
   if(body.payload===null||typeof body.payload!=='object'||Array.isArray(body.payload))throw Error('canonical_reference_payload_invalid')
   const payload=body.payload as Record<string,unknown>
   if(!repair)payloads.push(payload)
   const turn=payload.turn_id??payload.source_turn_id
   if(root.kind==='relay_event'&&typeof turn==='string'&&turn.length>0&&turn.length<=1024)
    selected.find(head=>head.canonicalKey===body.head.canonicalKey)!.turnKey=turn
  }
  heads.push(...selected)
 }
 await readPage(page)
 if(repair&&options.keys){
  for(let offset=ORIGINAL_REPAIR_PAGE_SIZE;offset<options.keys.length;offset+=ORIGINAL_REPAIR_PAGE_SIZE)
   await readPage(await reader.getHeads(scope,root,options.keys.slice(offset,offset+ORIGINAL_REPAIR_PAGE_SIZE)))
 }
 if(root.kind==='team_collaboration'||root.kind==='team_delivery')for(const head of heads){
  const key=head.locator?.teamProjectionKey
  if(typeof key!=='string'||!/^team_projection_[a-f0-9]{64}$/.test(key))throw Error('canonical_reference_provenance_invalid')
  head.canonicalKey=key
 }
 let bytes=0
 for(const head of heads){
  if(typeof head.occurredAt!=='string'||!Number.isFinite(Date.parse(head.occurredAt)))throw Error('canonical_reference_timestamp_required')
  const length=Buffer.byteLength(canonicalJsonString(head));bytes+=length
  if(length>32768||bytes>1024*1024)throw Error('canonical_reference_metadata_limit')
 }
 const token=Object.freeze({})
 const nextCursor='nextCursor'in page&&typeof page.nextCursor==='string'?page.nextCursor:undefined
 pages.set(token,{pool,execution:sourceExecutionTokenFor(pool,scope.installationId),scope:structuredClone(scope),root:structuredClone(root),heads,version:structuredClone(page.version),payloads,cursor:options.cursor,nextCursor,enumerated:!options.keys})
 return Object.freeze({token,count:heads.length,...(nextCursor?{nextCursor}:{}),hasMore:nextCursor!==undefined})
}

/** Finite enumeration bookkeeping is separate from each freshly observed
 * selected page. A changing root never resets a live wave to its first64. */
export async function preparePersonalMetadataReferencePage(pool:pg.Pool,scope:SourceScope,root:SourceRoot,seal:MetadataScopeSeal,progress:unknown,limit=64):Promise<CanonicalReferencePage>{
 requireExecution(pool,scope.installationId)
 if(root.kind!=='relay_event'||scope.ownerScopeKind!=='personal')throw Error('canonical_reference_request_invalid')
 const prior=progress as {source_version?:unknown;next_cursor?:string|null;state?:string}|undefined
 const candidate=(prior?.source_version as {metadataWave?:MetadataWave}|undefined)?.metadataWave
 const scopeHash=canonicalPayloadHash(scope).toString('hex')
 let wave:MetadataWave|undefined
 if(candidate){
  if(Object.keys(candidate).some(k=>!['contract','through','after','startVersion','scopeHash','controlRevision','phase'].includes(k))
   ||Buffer.byteLength(canonicalJsonString(candidate))>8192||candidate.contract!=='personal-metadata-wave-v1'||typeof candidate.through!=='string'||!/^(0|[1-9]\d{0,18})$/.test(candidate.through)||BigInt(candidate.through)>9223372036854775807n
   ||candidate.after!==undefined&&(typeof candidate.after!=='string'||!/^(0|[1-9]\d{0,18})$/.test(candidate.after)||BigInt(candidate.after)>BigInt(candidate.through))
   ||!['scanning','restart'].includes(candidate.phase)||!candidate.startVersion||Object.keys(candidate.startVersion).sort().join(',')!=='authorization,content,storage'
   ||!['content','authorization','storage'].every(k=>/^\d{1,19}$/.test((candidate.startVersion as any)[k])&&BigInt((candidate.startVersion as any)[k])<=9223372036854775807n)
   ||!/^[a-f0-9]{64}$/.test(candidate.scopeHash)||!/^[1-9]\d{0,18}$/.test(candidate.controlRevision)||BigInt(candidate.controlRevision)>9223372036854775807n)throw Error('canonical_reference_wave_invalid')
  if(candidate.scopeHash===scopeHash&&candidate.controlRevision===seal.controlRevision&&(candidate.phase==='scanning'||candidate.after!==undefined))wave=structuredClone(candidate)
 }
 // Restart with after=through is the single tail-due witness. Its first
 // observation freezes a new bound; subsequent tail pages retain that bound.
 const tailDue=wave?.phase==='restart'&&wave.after!==undefined&&BigInt(wave.after)===BigInt(wave.through)
 const reader=createObservedPersonalMetadataReader(pool),view=await reader.selectPage(scope,root,{limit,...(wave?{after:wave.after,...(!tailDue?{through:wave.through}:{})}:{})})
 if(tailDue)wave={...wave!,through:view.upperId,startVersion:{...view.observedVersion}}
 wave??={contract:'personal-metadata-wave-v1',through:view.upperId,startVersion:{...view.observedVersion},scopeHash,controlRevision:seal.controlRevision,phase:'scanning'}
 const heads=structuredClone([...view.heads]),bodies=heads.length?await reader.resolve(view):[],payloads:Record<string,unknown>[]=[]
 for(const [n,body]of bodies.entries()){
  if(!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))throw Error('canonical_reference_payload_invalid')
  const payload=body.payload as Record<string,unknown>;payloads.push(payload)
  const turn=payload.turn_id??payload.source_turn_id
  if(typeof turn==='string'&&turn&&turn.length<=1024)heads[n].turnKey=turn
  if(typeof heads[n].occurredAt!=='string'||!Number.isFinite(Date.parse(heads[n].occurredAt!)))throw Error('canonical_reference_timestamp_required')
 }
 const token=Object.freeze({}),metadata:MetadataPage={wave,prior:prior??null,envelope:personalMetadataEnvelope(pool,scope,root,reader.proof(view),seal,'reference'),exhausted:view.exhausted,nextAfter:view.nextAfter}
 pages.set(token,{pool,execution:sourceExecutionTokenFor(pool,scope.installationId),scope:structuredClone(scope),root:structuredClone(root),heads,version:{...view.observedVersion},payloads,enumerated:true,metadata})
 return Object.freeze({token,count:heads.length,...(view.nextAfter?{nextCursor:view.nextAfter}:{}),hasMore:!view.exhausted})
}

export async function persistPersonalMetadataReferencePage(pool:pg.Pool,page:CanonicalReferencePage,stabilizationMs?:number,signal?:AbortSignal){
 const p=pages.get(page.token);if(!p?.metadata)throw Error('canonical_reference_token_invalid')
 const references=await persistCanonicalReferencePage(pool,page,{project:true,checkpoint:true,stabilizationMs,signal})
 return {references,contextReady:p.metadata.contextReady===true}
}

/** A new latest scan may find an already current context. It must still run
 * ordinary physical installation completion, never return on a TS receipt. */
export async function completeReadyCanonicalProjection(pool:pg.Pool,scope:SourceScope,root:SourceRoot,version:SourceVersion,options:{deferMs?:number}={}){
 requireExecution(pool,scope.installationId);const client=await pool.connect()
 let completing=false
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'")
  await guardSourceExecutionCommit(client,scope.installationId)
  completing=true
  const completed=await completeSourceProjection(client,scope,root,version)
  completing=false
  await guardSourceExecutionCommit(client,scope.installationId);await client.query('COMMIT')
  return completed
 }catch(error){
  await client.query('ROLLBACK')
  const failure=error as {code?:string;message?:string}|null
  if(completing&&options.deferMs!==undefined&&(failure?.code==='55P03'||failure?.code==='P0001'&&failure.message==='source_reference_changed')){
   throw new JobDeferredError('source_not_ready',new Date(Date.now()+options.deferMs))
  }
  throw error
 }finally{client.release()}
}

/** Bounded metadata-only physical transaction. It neither copies a body nor
 * rewrites an existing UUID, origin, original digest or provenance. */
export async function persistCanonicalReferencePage(pool:pg.Pool,page:CanonicalReferencePage,options:{project?:boolean;stabilizationMs?:number;checkpoint?:boolean;signal?:AbortSignal;repair?:{version:SourceVersion;originalIds:ReadonlyMap<string,string>};reuseOriginalsAtVersion?:SourceVersion}={}):Promise<CanonicalReference[]>{
 const prepared=pages.get(page.token)
 if(!prepared||prepared.pool!==pool)throw Error('canonical_reference_token_invalid')
 if(prepared.execution!==sourceExecutionTokenFor(pool,prepared.scope.installationId))throw Error('canonical_reference_execution_changed')
 const {scope,root,heads,version,payloads}=prepared
 const repair=options.repair
 const reuseOriginals=options.reuseOriginalsAtVersion
 if(reuseOriginals&&(repair||root.kind!=='relay_event'||scope.ownerScopeKind!=='personal'||!options.checkpoint||!prepared.enumerated||prepared.metadata
  ||version.content!==reuseOriginals.content||version.authorization!==reuseOriginals.authorization))throw new JobTerminalError('source_context_set_changed')
 if(repair&&(root.kind!=='relay_event'||scope.ownerScopeKind!=='personal'||!options.checkpoint||prepared.metadata
  ||heads.length!==repair.originalIds.size||version.content!==repair.version.content||version.authorization!==repair.version.authorization))
  throw new JobTerminalError('source_context_set_changed')
 const team=root.kind==='team_collaboration'||root.kind==='team_delivery'
 const checkpointState=prepared.nextCursor?'scanning':team?'raw_ready':'ready'
 const stabilizationMs=options.stabilizationMs??30000
 if(!Number.isSafeInteger(stabilizationMs)||stabilizationMs<0||stabilizationMs>86400000)throw Error('canonical_reference_request_invalid')
 requireExecution(pool,scope.installationId)
 if(options.checkpoint&&!prepared.enumerated&&!repair)throw Error('canonical_reference_enumeration_required')
 if(options.checkpoint&&!options.project)throw Error('canonical_reference_projection_required')
 if(prepared.metadata&&(!options.project||!options.checkpoint))throw Error('canonical_reference_projection_required')
 if(!heads.length&&!options.checkpoint)return []
 const persist=async(client:pg.PoolClient,managed=false):Promise<CanonicalReference[]>=>{
 const deadline=performance.now()+5000
 const query=(sql:string,args?:unknown[])=>{
  if(performance.now()>=deadline)throw Error('canonical_reference_budget_exceeded')
  return client.query(sql,args)
 }
 const selectedLockQuery=async(sql:string,args?:unknown[])=>{
  try{return await query(sql,args)}catch(error){
   if(prepared.metadata&&(error as {code?:string}).code==='55P03')throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
   throw error
  }
 }
 try{
  if(!managed){await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'")}
  await guardSourceExecutionCommit(client,scope.installationId)
  const fn=root.kind==='relay_event'?'lock_memory_personal_source_commit':'lock_memory_team_source_commit'
  const personalProjection=root.kind==='relay_event'&&options.checkpoint
  // Empty-page bookkeeping uses the full-root version and cannot allocate.
  const expected=prepared.metadata&&heads.length?prepared.metadata.envelope:personalProjection&&heads.length&&!repair
   ?{contract:'personal-reference-projection-v1',observedVersion:version,canonicalIds:heads.map(head=>head.canonicalKey)}:version
  const locked=(await query(`SELECT shared.${fn}($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked`,[JSON.stringify(scope),root.kind,root.key,JSON.stringify(expected)])).rows[0]?.locked
  if(locked!==true){
   if(repair||reuseOriginals)throw new SourceUnavailableError('changed')
   throw Error('canonical_reference_changed')
  }
  const mutex=(await query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[scope.installationId])).rows[0]?.locked
  if(mutex!==true)throw Error('canonical_reference_busy')
  if(repair){
   // Only a complete roster may create a ready checkpoint. The existing
   // unkeyed authority supplies IDs inside SQL, with a separate empty tail.
   // The client receives one boolean and only reads bodies by frozen key.
   const keys=[...repair.originalIds.keys()].sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0))
   let after:string|null=null
   for(let offset=0;offset<keys.length;offset+=ORIGINAL_REPAIR_PAGE_SIZE){
    const part=keys.slice(offset,offset+ORIGINAL_REPAIR_PAGE_SIZE)
    const complete=(await query(`SELECT ARRAY(SELECT value->>'id' FROM shared.read_memory_relay_sources($1::jsonb,$2,$3::bigint,$4,NULL) value
     ORDER BY (value->>'id')::bigint)=$5::text[] AS complete`,[scope,root.key,after,part.length,part])).rows[0]?.complete
    if(complete!==true)throw new JobTerminalError('source_context_set_changed')
    const selectedFence={contract:'personal-reference-projection-v1',observedVersion:version,canonicalIds:part}
    if((await query(`SELECT shared.${fn}($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked`,
     [scope,root.kind,root.key,selectedFence])).rows[0]?.locked!==true)throw new SourceUnavailableError('changed')
    after=part.at(-1)!
   }
   if((await query(`SELECT EXISTS(SELECT 1 FROM shared.read_memory_relay_sources($1::jsonb,$2,$3::bigint,1,NULL)) AS has_more`,
    [scope,root.key,after])).rows[0]?.has_more!==false)throw new JobTerminalError('source_context_set_changed')
  }
  const contextKey=canonicalPayloadHash(scope).toString('hex')
  let checkpointDuplicate=false
  if(options.checkpoint){
   const current=(await selectedLockQuery(`SELECT source_version,next_cursor,state FROM memory_canonical_projection_progress
    WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4 FOR UPDATE NOWAIT`,[scope.installationId,root.kind,root.key,contextKey])).rows[0]
   if(prepared.metadata){
    if(canonicalJsonString(current??null)!==canonicalJsonString(prepared.metadata.prior))throw Error('canonical_reference_cursor_changed')
   }
   const same=current&&canonicalJsonString(current.source_version)===canonicalJsonString(version)
   // Metadata derives its final finite-wave state only after the current
   // authority read below. An old ready vector can require a new scanning
   // checkpoint, even when it equals this page's selected version.
   checkpointDuplicate=!prepared.metadata&&!!same&&current.next_cursor===(prepared.nextCursor??null)&&current.state===checkpointState
   if(!prepared.metadata&&!checkpointDuplicate&&((!current||!same)?prepared.cursor!==undefined:current.state!=='scanning'||current.next_cursor!==(prepared.cursor??null)))throw Error('canonical_reference_cursor_changed')
  }
  if(!personalProjection){
   const sessions=[...new Set(heads.map(h=>h.sessionKey))].sort()
   // Retain the existing subject fence for Team and non-checkpointed callers.
   const unproven=await query(`SELECT source_event_id FROM(
    (SELECT source_event_id FROM source_events WHERE installation_id=$1
     AND session_id=ANY($2::text[]) AND mapping_state IN('unproven','conflict') LIMIT 1)
    UNION ALL
    (SELECT source_event_id FROM source_events WHERE installation_id=$1
     AND canonical_session_key=ANY($2::text[]) AND mapping_state IN('unproven','conflict') LIMIT 1)
   ) AS unproven LIMIT 1`,[scope.installationId,sessions])
   if(unproven.rowCount)throw Error('canonical_reference_mapping_required')
  }
  const existing=(await selectedLockQuery(`SELECT s.source_event_id::text,s.canonical_key,s.canonical_session_key,s.session_id,s.turn_id,s.event_type,s.content_hash,s.classification,s.mapping_state,s.origin,s.adapter_version,s.source_provenance,s.canonical_projected_at,p.canonical_key AS matched_key,
   (s.occurred_at=p.occurred_at::timestamptz OR(s.origin IN('feed','snapshot') AND s.mapping_state='verified' AND s.source_kind='relay_event'
    AND s.occurred_at=date_trunc('milliseconds',p.occurred_at::timestamptz))) AS timestamp_matches FROM source_events s
   JOIN jsonb_to_recordset($3::jsonb) AS p(canonical_key text,occurred_at text,legacy_wire_key text) ON(p.canonical_key=s.canonical_key OR(s.source_kind IN('team_collaboration','team_delivery') AND p.legacy_wire_key=s.canonical_key))
   WHERE s.installation_id=$1 AND s.source_kind=$2 ORDER BY s.source_event_id FOR UPDATE OF s NOWAIT`,
   [scope.installationId,root.kind,JSON.stringify(heads.map(h=>({canonical_key:h.canonicalKey,occurred_at:h.occurredAt,legacy_wire_key:h.kind==='team_collaboration'||h.kind==='team_delivery'?h.locator?.teamWireKey:null})))])).rows
  const result:CanonicalReference[]=[]
  for(const [ordinal,head]of heads.entries()){
   const candidates=existing.filter(r=>r.matched_key===head.canonicalKey),matches=candidates.filter(r=>r.canonical_key===head.canonicalKey)
   if(root.kind==='team_collaboration'||root.kind==='team_delivery')for(const candidate of candidates.filter(r=>r.canonical_key!==head.canonicalKey)){
    const proof=candidate.source_provenance?.team??candidate.source_provenance
    let key:string
    try{key=teamReaderProjectionKey(String(head.locator?.teamWireKey),proof)}catch{throw Error('canonical_reference_mapping_required')}
    // A known older permission projection is a distinct reference. An exact
    // legacy alias reuses its UUID only with the complete original proof.
    if(key===head.canonicalKey){
     if(canonicalJsonString(proof)!==canonicalJsonString(referenceProvenance(head,root)))throw Error('canonical_reference_conflict')
     matches.push(candidate)
    }
   }
   if(matches.length>1)throw Error('canonical_reference_conflict')
   const old=matches[0]
   // An original binding repair can acknowledge proven old references. It
   // cannot allocate a canonical UUID or schedule derived work for this page.
   if(repair&&(!old||old.origin!=='feed'||old.adapter_version!=='original-ref-v1'||repair.originalIds.get(head.canonicalKey)!==old.source_event_id))
    throw new JobTerminalError('source_context_set_changed')
   if(reuseOriginals&&(!old||old.origin!=='feed'||old.adapter_version!=='original-ref-v1'||head.storage!=='hot'))
    throw new JobTerminalError('source_context_set_changed')
   if(old){
    if((root.kind==='team_collaboration'||root.kind==='team_delivery')&&canonicalJsonString(old.source_provenance?.team??old.source_provenance)!==canonicalJsonString(referenceProvenance(head,root)))throw Error('canonical_reference_conflict')
    if(old.mapping_state!=='verified'||old.canonical_session_key!==head.sessionKey||old.session_id!==head.sessionKey||(old.turn_id??null)!==(head.turnKey??null)||old.event_type!==head.eventType||!old.timestamp_matches
     ||!Buffer.isBuffer(old.content_hash)||old.content_hash.toString('hex')!==head.contentHash||canonicalJsonString(old.classification)!==canonicalJsonString(head.classification))throw Error('canonical_reference_conflict')
    if(options.project&&!team&&old.origin==='canonical'&&!old.canonical_projected_at){
     await projectCanonicalDerivedFact({query} as Pick<pg.PoolClient,'query'>,scope.installationId,{sourceEventId:old.source_event_id,sessionId:old.session_id,turnId:head.turnKey??null,eventType:head.eventType,occurredAt:head.occurredAt!,payload:payloads[ordinal]},stabilizationMs)
     await query('UPDATE source_events SET canonical_projected_at=clock_timestamp() WHERE source_event_id=$1',[old.source_event_id])
    }
    result.push({sourceEventId:old.source_event_id,canonicalKey:head.canonicalKey,sessionId:old.session_id,created:false});continue
   }
   const alive=(await query(`SELECT 1 FROM memory_installations WHERE installation_id=$1 AND relay_status='active'
    AND local_status NOT IN('purging','purged','integrity_error') FOR KEY SHARE NOWAIT`,[scope.installationId])).rowCount
   if(!alive)throw Error('canonical_reference_unavailable')
   if((await query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[scope.installationId,head.sessionKey])).rowCount)throw Error('canonical_reference_unavailable')
   await query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,$3::timestamptz,$3::timestamptz)
    ON CONFLICT(installation_id,session_id) DO UPDATE SET first_recorded_at=LEAST(source_sessions.first_recorded_at,EXCLUDED.first_recorded_at),last_recorded_at=GREATEST(source_sessions.last_recorded_at,EXCLUDED.last_recorded_at)`,[scope.installationId,head.sessionKey,head.occurredAt])
   const turn=head.turnKey??null
   const inserted=await query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,
    source_provenance,source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version)
    VALUES(gen_random_uuid(),$1,'canonical',$2,$3,$4,$5,$6::timestamptz,$7::jsonb,NULL,$8,$9::jsonb,$10,$11,$3,$12::jsonb,$13::bigint,$8,'canonical-json-sha256-v1','verified','canonical-ref-v1')
    ON CONFLICT DO NOTHING RETURNING source_event_id::text`,[scope.installationId,root.kind+':'+head.canonicalKey,head.sessionKey,turn,head.eventType,head.occurredAt,
     JSON.stringify(head.classification),Buffer.from(head.contentHash,'hex'),JSON.stringify(referenceProvenance(head,root)),root.kind,head.canonicalKey,JSON.stringify(version),head.sourceSequence??null])
   if(!inserted.rows[0])throw Error('canonical_reference_conflict')
   if(options.project&&!team){
    await projectCanonicalDerivedFact({query} as Pick<pg.PoolClient,'query'>,scope.installationId,{sourceEventId:inserted.rows[0].source_event_id,sessionId:head.sessionKey,turnId:head.turnKey??null,eventType:head.eventType,occurredAt:head.occurredAt!,payload:payloads[ordinal]},stabilizationMs)
    await query('UPDATE source_events SET canonical_projected_at=clock_timestamp() WHERE source_event_id=$1',[inserted.rows[0].source_event_id])
   }
   result.push({sourceEventId:inserted.rows[0].source_event_id,canonicalKey:head.canonicalKey,sessionId:head.sessionKey,created:true})
  }
  let finalVersion:unknown=version,finalCursor=prepared.nextCursor??null,finalState:string=checkpointState
  if(prepared.metadata){
   const m=prepared.metadata,current=(await query('SELECT * FROM shared.memory_relay_source_authority($1::jsonb,$2,$3)',[JSON.stringify(scope),root.kind,root.key])).rows[0]
   const ordinary=current?.state==='current'?{content:current.content_revision,authorization:current.authorization_revision,storage:current.storage_revision}:null
   m.contextReady=m.wave.phase==='scanning'&&m.exhausted&&canonicalJsonString(ordinary)===canonicalJsonString(m.wave.startVersion)
   if(m.contextReady){finalVersion=ordinary;finalCursor=null;finalState='ready'}
   else{
    // An exhausted unstable full sweep buys exactly one tail. Exhausting
    // that tail removes the cursor and imposes a full sweep from zero.
    const wave:MetadataWave={...m.wave,phase:m.exhausted?'restart':m.wave.phase,after:m.exhausted?(m.wave.phase==='scanning'?m.wave.through:undefined):m.nextAfter}
    finalVersion={metadataWave:wave};finalCursor=Buffer.from(canonicalJsonString(wave)).toString('base64url');finalState='scanning'
   }
  }
  if(options.checkpoint&&!checkpointDuplicate){
   await query(`INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,next_cursor,state)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(installation_id,source_kind,root_key,context_key)
    DO UPDATE SET source_version=EXCLUDED.source_version,next_cursor=EXCLUDED.next_cursor,state=EXCLUDED.state,updated_at=clock_timestamp()`,
    [scope.installationId,root.kind,root.key,contextKey,JSON.stringify(finalVersion),finalCursor,finalState])
  }
  if(options.checkpoint&&!team&&(prepared.metadata?prepared.metadata.contextReady:!prepared.nextCursor)){
   const completed=await completeSourceProjection(client,scope,root,finalVersion)
   if((repair||reuseOriginals)&&!completed)throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
  }
  await guardSourceExecutionCommit(client,scope.installationId)
  if(!managed)await query('COMMIT');return result
 }catch(error){
  if(!managed)await client.query('ROLLBACK').catch(()=>undefined)
   if(prepared.metadata&&(error as {code?:string}).code==='55P03'&&(error as Error).message==='source_metadata_lock_busy')throw new SelectedSourceLockBusy()
  throw error
 }
 }
 if(prepared.metadata)return runSelectedSourceTransaction(pool,scope.installationId,options.signal,client=>persist(client,true))
 const client=await pool.connect()
 try{return await persist(client)}finally{client.release()}
}

/** The reader wraps Team provenance; persisted references keep the existing
 * flat adapter contract used by episode lineage and global withdrawal fences. */
function referenceProvenance(head:SourceHead,root:SourceRoot):unknown{
 if(root.kind!=='team_collaboration'&&root.kind!=='team_delivery')return head.provenance
 const proof=head.provenance
 const team=proof.team
 if(proof.state!=='known'||!team||typeof team!=='object'||Array.isArray(team))throw Error('canonical_reference_provenance_invalid')
 const flat=team as Record<string,unknown>
 if(flat.source_kind!=='team_session'||flat.source_version!==(root.kind==='team_delivery'?2:1))throw Error('canonical_reference_provenance_invalid')
 return flat
}
