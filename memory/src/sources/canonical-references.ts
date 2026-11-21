import {compactSnapshotFields,snapshotProvenanceSql} from './snapshot-provenance.js'
import {planOfflinePage,type OfflineSeal,type OfflineBasis} from './offline-projection.js'
import {ProjectionTiming,observeProjectionStep,commitOutcomeUnknown,ProjectionLockBusy,recordProjectionRollback} from './projection-diagnostics.js'
import type pg from 'pg'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import {runSelectedSourceTransaction,SelectedSourceLockBusy,SelectedSourceTransactionUnavailable} from './processing-pins.js'
import {canonicalJsonString,canonicalPayloadHash,createPostgresSharedSourceReader,SourceUnavailableError,teamReaderProjectionKey,type SourceHead,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {createObservedSourceReader} from './observed-reader.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {sourceExecutionBranchFor,sourceExecutionTokenFor,guardSourceExecutionCommit,completeSourceProjection} from './source-execution.js'
import {createObservedPersonalMetadataReader} from './observed-reader.js'
import {personalMetadataEnvelope,type MetadataScopeSeal} from './source-projection-admission.js'
import {bindHistoricalOriginals} from './historical-originals.js'
import {readHistoricalIds,readHistoricalProjectionSeal,type HistoricalProjectionRoot} from './historical-projection-authority.js'
import {projectCanonicalDerivedFact,projectNewCanonicalPage,type CanonicalDerivedFact} from '../projection/source-projector.js'

interface MetadataWave {contract:'personal-metadata-wave-v1';through:string;after?:string;startVersion:SourceVersion;scopeHash:string;controlRevision:string;phase:'scanning'|'restart'}
interface MetadataPage {offline?:{plan:ReturnType<typeof planOfflinePage>;seal:OfflineSeal};frozenComplete?:boolean;wave:MetadataWave;prior:unknown;envelope:unknown;exhausted:boolean;nextAfter?:string;contextReady?:boolean}
interface HistoricalPage {
 client:pg.PoolClient
 guard:()=>Promise<void>
 complete:(version:SourceVersion)=>Promise<void>
}
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
 const reader=createObservedSourceReader(pool,options.expectedVersion?undefined:sourcePoolContext(pool).archive)
 return prepareReferencePage(pool,scope,root,reader,options)
}

async function prepareReferencePage(pool:pg.Pool,scope:SourceScope,root:SourceRoot,reader:ReturnType<typeof createPostgresSharedSourceReader>,options:{keys?:readonly string[];cursor?:string;limit?:number;expectedVersion?:SourceVersion;historicalRange?:{version:SourceVersion;nextCursor?:string}}):Promise<CanonicalReferencePage>{
 if(options.expectedVersion){
  if(!options.keys)throw Error('canonical_reference_request_invalid')
  const current=await reader.checkCurrent(scope,root,options.expectedVersion)
  if(current.state!=='current')throw new SourceUnavailableError(current.state)
 }
 const repair=options.expectedVersion
 if(repair&&(!options.keys?.length||options.keys.length>ORIGINAL_REPAIR_MAX_ROWS||new Set(options.keys).size!==options.keys.length))
  throw Error('canonical_reference_request_invalid')
 const page=options.historicalRange
  ? { ...(options.keys?.length?await reader.getHeads(scope,root,options.keys):{heads:[],version:options.historicalRange.version}),
   nextCursor:options.historicalRange.nextCursor }
  :options.keys?await reader.getHeads(scope,root,repair?options.keys.slice(0,ORIGINAL_REPAIR_PAGE_SIZE):options.keys)
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
 pages.set(token,{pool,execution:sourceExecutionTokenFor(pool,scope.installationId),scope:structuredClone(scope),root:structuredClone(root),heads,version:structuredClone(page.version),payloads,cursor:options.cursor,nextCursor,enumerated:!options.keys||!!options.historicalRange})
 return Object.freeze({token,count:heads.length,...(nextCursor?{nextCursor}:{}),hasMore:nextCursor!==undefined})
}

/** Finite enumeration bookkeeping is separate from each freshly observed
 * selected page. A changing root never resets a live wave to its first64. */
export async function preparePersonalMetadataReferencePage(pool:pg.Pool,scope:SourceScope,root:SourceRoot,seal:MetadataScopeSeal,progress:unknown,limit=64):Promise<CanonicalReferencePage>{
 requireExecution(pool,scope.installationId)
 if(root.kind!=='relay_event'||scope.ownerScopeKind!=='personal')throw Error('canonical_reference_request_invalid')
 // Bind range, scope and checkpoint to the private page token before any IO.
 // The final seal comparison must validate the exact range used for selection.
 if(seal.offline){seal=structuredClone(seal);scope=structuredClone(scope);root=structuredClone(root);progress=structuredClone(progress)}
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
 const plan=seal.offline?planOfflinePage(seal.offline,prior):undefined
 const request=plan&&seal.offline?.batch.mode==='active'?{...plan.request,limit:Math.min(64,limit)}:{limit,...(wave?{after:wave.after,...(!tailDue?{through:wave.through}:{})}:{})}
 const reader=createObservedPersonalMetadataReader(pool),view=await observeProjectionStep(pool,'select_page',()=>reader.selectPage(scope,root,request))
 if(plan&&seal.offline){
  const proof=reader.proof(view) as {inputFingerprint:string;nativeSessionFingerprint:string}
  if(proof.nativeSessionFingerprint!==plan.basis.native||plan.basis.input&&plan.basis.input!==proof.inputFingerprint
    ||view.observedVersion.storage!==plan.basis.version.storage||view.observedVersion.authorization!==plan.basis.version.authorization
    ||BigInt(view.observedVersion.content)<BigInt(plan.basis.version.content)){
   // The native graph, input boundary or retention changed. Re-enter the
   // existing full sweep with the same sealed scope and current authority.
   return preparePersonalMetadataReferencePage(pool,scope,root,{...seal,offline:undefined},progress,limit)
  }
  plan.basis.input=proof.inputFingerprint
 }
 if(tailDue)wave={...wave!,through:view.upperId,startVersion:{...view.observedVersion}}
 wave??={contract:'personal-metadata-wave-v1',through:view.upperId,startVersion:{...view.observedVersion},scopeHash,controlRevision:seal.controlRevision,phase:'scanning'}
 const heads=structuredClone([...view.heads]),bodies=heads.length?await observeProjectionStep(pool,'select_page',()=>reader.resolve(view)):[],payloads:Record<string,unknown>[]=[]
 for(const [n,body]of bodies.entries()){
  if(!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))throw Error('canonical_reference_payload_invalid')
  const payload=body.payload as Record<string,unknown>;payloads.push(payload)
  const turn=payload.turn_id??payload.source_turn_id
  if(typeof turn==='string'&&turn&&turn.length<=1024)heads[n].turnKey=turn
  if(typeof heads[n].occurredAt!=='string'||!Number.isFinite(Date.parse(heads[n].occurredAt!)))throw Error('canonical_reference_timestamp_required')
 }
 const token=Object.freeze({}),metadata:MetadataPage={...(plan&&seal.offline?{offline:{plan,seal:seal.offline}}:{}),wave,prior:prior??null,envelope:personalMetadataEnvelope(pool,scope,root,reader.proof(view),seal,'reference'),exhausted:view.exhausted,nextAfter:view.nextAfter}
 pages.set(token,{pool,execution:sourceExecutionTokenFor(pool,scope.installationId),scope:structuredClone(scope),root:structuredClone(root),heads,version:{...view.observedVersion},payloads,enumerated:true,metadata})
 return Object.freeze({token,count:heads.length,...(view.nextAfter?{nextCursor:view.nextAfter}:{}),hasMore:!view.exhausted})
}

export async function persistPersonalMetadataReferencePage(pool:pg.Pool,page:CanonicalReferencePage,stabilizationMs?:number,signal?:AbortSignal,historicalCompile=false,batchDerived=false,compactSnapshot=false){
 const p=pages.get(page.token);if(!p?.metadata)throw Error('canonical_reference_token_invalid')
 const references=await persistCanonicalReferencePage(pool,page,{project:true,checkpoint:true,stabilizationMs,signal,historicalCompile,batchDerived,compactSnapshot})
 return {references,contextReady:p.metadata.contextReady===true,frozenComplete:p.metadata.frozenComplete===true}
}

/** A new latest scan may find an already current context. It must still run
 * ordinary physical installation completion, never return on a TS receipt. */
export async function completeReadyCanonicalProjection(pool:pg.Pool,scope:SourceScope,root:SourceRoot,version:SourceVersion,options:{deferMs?:number}={}){
 requireExecution(pool,scope.installationId);const client=await observeProjectionStep(pool,'checkout',()=>pool.connect())
 const timing=new ProjectionTiming(pool,'begin')
 let completing=false,commitSent=false,discard=false
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'")
  await guardSourceExecutionCommit(client,scope.installationId)
  timing.enter('complete_watermark')
  completing=true
  const completed=await completeSourceProjection(client,scope,root,version)
  completing=false
  await guardSourceExecutionCommit(client,scope.installationId)
  timing.enter('commit');commitSent=true
  await client.query('COMMIT')
  timing.finish()
  return completed
 }catch(error){
  if(commitSent&&commitOutcomeUnknown(error)){
   discard=true
   throw timing.failure(new Error('projection_commit_outcome_unknown'),true)
  }
  try{await client.query('ROLLBACK')}catch{discard=true}
  const failure=error as {code?:string;message?:string}|null
  if(completing&&!discard&&options.deferMs!==undefined&&(failure?.code==='55P03'||failure?.code==='P0001'&&failure.message==='source_reference_changed')){
   throw timing.failure(new JobDeferredError('source_not_ready',new Date(Date.now()+options.deferMs)),false,
    failure.code==='55P03'?'lock_conflict':'authority_or_version_changed')
  }
  throw timing.failure(error,commitSent)
 }finally{client.release(discard)}
}

/** Bounded metadata-only physical transaction. It neither copies a body nor
 * rewrites an existing UUID, origin, original digest or provenance. */
type PersistOptions={compactSnapshot?:boolean;batchDerived?:boolean;historicalCompile?:boolean;project?:boolean;stabilizationMs?:number;checkpoint?:boolean;signal?:AbortSignal;repair?:{version:SourceVersion;originalIds:ReadonlyMap<string,string>};reuseOriginalsAtVersion?:SourceVersion}
export async function persistCanonicalReferencePage(pool:pg.Pool,page:CanonicalReferencePage,options:PersistOptions={}):Promise<CanonicalReference[]>{
 return persistReferencePage(pool,page,options)
}

async function persistReferencePage(pool:pg.Pool,page:CanonicalReferencePage,options:PersistOptions,historical?:HistoricalPage):Promise<CanonicalReference[]>{
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
 if(!historical)requireExecution(pool,scope.installationId)
 if(options.checkpoint&&!prepared.enumerated&&!repair)throw Error('canonical_reference_enumeration_required')
 if(options.checkpoint&&!options.project)throw Error('canonical_reference_projection_required')
 if(prepared.metadata&&(!options.project||!options.checkpoint))throw Error('canonical_reference_projection_required')
 if(!heads.length&&!options.checkpoint)return []
 let discard=false
 let activeWrite:ProjectionTiming|undefined
 const persist=async(client:pg.PoolClient,managed=false,outerDeadline?:number):Promise<CanonicalReference[]>=>{
 const timing=new ProjectionTiming(pool,'begin',{size:heads.length,historical:!!historical})
 let commitSent=false
 // Leave room for one server-side statement timeout and rollback before
 // the outer transport deadline. A queued transaction inherits time already spent.
 const deadline=outerDeadline===undefined?performance.now()+5000:outerDeadline-1100
 const query=(sql:string,args?:unknown[])=>{
  if(performance.now()>=deadline){
   if(outerDeadline!==undefined&&!activeWrite)throw new SelectedSourceTransactionUnavailable()
   throw Error('canonical_reference_budget_exceeded')
  }
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
  timing.enter('verify_version')
  if(historical)await historical.guard();else await guardSourceExecutionCommit(client,scope.installationId)
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
  if(mutex!==true)throw new ProjectionLockBusy()
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
   timing.enter('checkpoint')
   const current=(await selectedLockQuery(`SELECT source_version,next_cursor,state${prepared.metadata?.prior&&Object.hasOwn(prepared.metadata.prior as object,'offline_basis')?',offline_basis':''} FROM memory_canonical_projection_progress
    WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4 FOR UPDATE NOWAIT`,[scope.installationId,root.kind,root.key,contextKey])).rows[0]
   const lastObserved=current?.source_version?.metadataWave?.startVersion??current?.source_version
   if(typeof lastObserved?.content==='string')timing.revisionChanged=lastObserved.content!==version.content
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
  timing.enter('write_references')
  activeWrite=timing
  const existing=(await selectedLockQuery(`SELECT s.source_event_id::text,s.canonical_key,s.canonical_session_key,s.session_id,s.turn_id,s.event_type,s.content_hash,s.classification,s.mapping_state,s.origin,s.adapter_version,s.source_provenance,s.canonical_projected_at,p.canonical_key AS matched_key,
   (s.occurred_at=p.occurred_at::timestamptz OR(s.origin IN('feed','snapshot') AND s.mapping_state='verified' AND s.source_kind='relay_event'
    AND s.occurred_at=date_trunc('milliseconds',p.occurred_at::timestamptz))) AS timestamp_matches FROM source_events s
   JOIN jsonb_to_recordset($3::jsonb) AS p(canonical_key text,occurred_at text,legacy_wire_key text) ON(p.canonical_key=s.canonical_key OR(s.source_kind IN('team_collaboration','team_delivery') AND p.legacy_wire_key=s.canonical_key))
   WHERE s.installation_id=$1 AND s.source_kind=$2 ORDER BY s.source_event_id FOR UPDATE OF s NOWAIT`,
   [scope.installationId,root.kind,JSON.stringify(heads.map(h=>({canonical_key:h.canonicalKey,occurred_at:h.occurredAt,legacy_wire_key:h.kind==='team_collaboration'||h.kind==='team_delivery'?h.locator?.teamWireKey:null})))])).rows
  const byKey=new Map<string,typeof existing>()
  for(const row of existing){
   const bucket=byKey.get(row.matched_key)
   if(bucket)bucket.push(row)
   else byKey.set(row.matched_key,[row])
  }
  const matched = new Map<string, (typeof existing)[number]>()
  for(const head of heads){
   const candidates=byKey.get(head.canonicalKey)??[],matches=candidates.filter(r=>r.canonical_key===head.canonicalKey)
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
    matched.set(head.canonicalKey,old)
   }
  }

  // Match and validate every old identity before allocating any new one.
  // Only metadata crosses this bounded set operation. Keep derived facts in source order.
  const missing=heads.filter(head=>!matched.has(head.canonicalKey))
  const allocated=new Map<string,string>()
  if(missing.length){
   const sessions=[...new Set(missing.map(head=>head.sessionKey))]
   const alive=(await query(`SELECT 1 FROM memory_installations WHERE installation_id=$1 AND relay_status='active'
    AND local_status NOT IN('purging','purged','integrity_error') FOR KEY SHARE NOWAIT`,[scope.installationId])).rowCount
   if(!alive)throw Error('canonical_reference_unavailable')
   if((await query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=ANY($2::text[]) LIMIT 1',[scope.installationId,sessions])).rowCount)throw Error('canonical_reference_unavailable')
   const compact=options.compactSnapshot && prepared.metadata && !options.historicalCompile && scope.ownerScopeKind==='personal' && root.kind==='relay_event'
   const rows=missing.map(head=>{
    const snapshot=compact ? compactSnapshotFields(head) : null
    return {canonical_key:head.canonicalKey,session_id:head.sessionKey,turn_id:head.turnKey??null,
     event_type:head.eventType,occurred_at:head.occurredAt,classification:head.classification,hash:head.contentHash,
     ...(snapshot??{provenance:referenceProvenance(head,root)}),sequence:head.sourceSequence??null}
   })
   const inserted=await query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,
    source_provenance,source_kind,canonical_key,canonical_session_key,source_version,source_sequence,content_hash,hash_version,mapping_state,adapter_version,snapshot_format)
    SELECT gen_random_uuid(),$1,'canonical',$2::text||':'||p.canonical_key,p.session_id,p.turn_id,p.event_type,p.occurred_at,
     p.classification,NULL,decode(p.hash,'hex'),p.provenance,$2,p.canonical_key,p.session_id,$3::jsonb,p.sequence,
     decode(p.hash,'hex'),'canonical-json-sha256-v1','verified','canonical-ref-v1',COALESCE(p.snapshot_format,0)
    FROM jsonb_to_recordset($4::jsonb) AS p(canonical_key text,session_id text,turn_id text,event_type text,occurred_at timestamptz,
     classification jsonb,hash text,provenance jsonb,sequence bigint,snapshot_format smallint)
    ON CONFLICT DO NOTHING RETURNING source_event_id::text,canonical_key`,[scope.installationId,root.kind,JSON.stringify(version),JSON.stringify(rows)])
   if(inserted.rowCount!==missing.length)throw Error('canonical_reference_conflict')
   for(const row of inserted.rows)allocated.set(row.canonical_key,row.source_event_id)
  }
  const result:CanonicalReference[]=[],projected:string[]=[]
  // Existing canonical rows without a completion marker retain their original
  // session time-range semantics on the ordered recovery path.
  const batchDerived=options.batchDerived && prepared.metadata && !options.historicalCompile &&
    !existing.some(row=>row.origin==='canonical'&&!row.canonical_projected_at)
  const pageFacts:CanonicalDerivedFact[]=[]
  const scheduledTurns=new Set<string>()
  for(const [ordinal,head] of heads.entries()){
   const old=matched.get(head.canonicalKey)
   const sourceEventId=old?.source_event_id??allocated.get(head.canonicalKey)
   if(!sourceEventId)throw Error('canonical_reference_conflict')
   if(options.project&&!team&&(!old||old.origin==='canonical'&&!old.canonical_projected_at)){
    const fact={sourceEventId,sessionId:head.sessionKey,turnId:head.turnKey??null,eventType:head.eventType,occurredAt:head.occurredAt!,payload:payloads[ordinal]}
    if(batchDerived)pageFacts.push(fact)
    else await projectCanonicalDerivedFact({query} as Pick<pg.PoolClient,'query'>,scope.installationId,fact,
     stabilizationMs,{scheduleCompilation:!historical,historicalCompile:options.historicalCompile,scheduledTurns})
    projected.push(sourceEventId)
   }
   result.push({sourceEventId,canonicalKey:head.canonicalKey,sessionId:head.sessionKey,created:!old})
   timing.rowsProcessed++
  }
  if(batchDerived)await projectNewCanonicalPage({query} as Pick<pg.PoolClient,'query'>,scope.installationId,pageFacts,stabilizationMs)
  else if(missing.length){
   // Merge timestamp ranges after ordered facts: historical session metadata
   // compares each event against the latest event observed so far.
   await query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)
    SELECT $1,p.session_id,min(p.occurred_at),max(p.occurred_at)
    FROM unnest($2::text[],$3::timestamptz[]) AS p(session_id,occurred_at) GROUP BY p.session_id ORDER BY p.session_id
    ON CONFLICT(installation_id,session_id) DO UPDATE SET first_recorded_at=LEAST(source_sessions.first_recorded_at,EXCLUDED.first_recorded_at),
     last_recorded_at=GREATEST(source_sessions.last_recorded_at,EXCLUDED.last_recorded_at)`,
    [scope.installationId,missing.map(head=>head.sessionKey),missing.map(head=>head.occurredAt)])
  }
  if(projected.length)
   await query('UPDATE source_events SET canonical_projected_at=clock_timestamp() WHERE source_event_id=ANY($1::uuid[])',[projected])
  timing.enter('checkpoint')
  let finalVersion:unknown=version,finalCursor=prepared.nextCursor??null,finalState:string=checkpointState
  let offlineBasis:OfflineBasis|undefined
  if(prepared.metadata){
   const m=prepared.metadata
   const columns=m.offline?"*,shared.current_memory_source_distribution($2,$3,($1::jsonb->>'installationId')::uuid) AS seal":'*'
   const current=(await query(`SELECT ${columns} FROM shared.memory_relay_source_authority($1::jsonb,$2,$3)`,[JSON.stringify(scope),root.kind,root.key])).rows[0]
   const ordinary=current?.state==='current'?{content:current.content_revision,authorization:current.authorization_revision,storage:current.storage_revision}:null
   m.contextReady=m.wave.phase==='scanning'&&m.exhausted&&canonicalJsonString(ordinary)===canonicalJsonString(m.wave.startVersion)
   if(m.offline){
    const {plan,seal}=m.offline,b={...plan.basis}
    offlineBasis=b
    const live=current?.seal
    if(live?.scanId!==seal.scanId||live.controlRevision!==seal.controlRevision||live.workRevision!==seal.version.content
      ||canonicalJsonString(live.offlineBatch)!==canonicalJsonString(seal.batch)
      ||ordinary?.authorization!==b.version.authorization||ordinary.storage!==b.version.storage)
     throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
    const shadow=seal.batch.mode==='shadow'
    b.scanned+=heads.length
    if(b.strategy==='shadow'){
     const writes=new Set(projected)
     b.outside+=result.filter(ref=>writes.has(ref.sourceEventId)&&!plan.contains(ref.canonicalKey)).length
    }
    b.covered=shadow?m.contextReady&&canonicalJsonString(ordinary)===canonicalJsonString(b.version):m.exhausted&&plan.last
    if(!b.covered){if(m.exhausted)b.segment++;else b.after=m.nextAfter}
    if(!shadow){
     m.frozenComplete=b.covered
     m.contextReady=b.covered&&canonicalJsonString(ordinary)===canonicalJsonString(b.version)
     finalState=m.contextReady?'ready':'scanning'
     finalVersion=m.contextReady?ordinary:b.covered?{offlineCovered:b.scanId}:{offlineScan:b.scanId}
     finalCursor=b.covered?null:JSON.stringify([b.segment,b.after??null])
    }
   }
   if(!m.offline||m.offline.seal.batch.mode==='shadow'){
    if(m.contextReady){finalVersion=ordinary;finalCursor=null;finalState='ready'}
    else{
     // An exhausted unstable full sweep buys exactly one tail. Exhausting
     // that tail removes the cursor and imposes a full sweep from zero.
     const wave:MetadataWave={...m.wave,phase:m.exhausted?'restart':m.wave.phase,after:m.exhausted?(m.wave.phase==='scanning'?m.wave.through:undefined):m.nextAfter}
     finalVersion={metadataWave:wave};finalCursor=Buffer.from(canonicalJsonString(wave)).toString('base64url');finalState='scanning'
    }
   }
  }
  if(options.checkpoint&&!checkpointDuplicate){
   await query(`INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,next_cursor,state${offlineBasis?',offline_basis':''})
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7${offlineBasis?',$8::jsonb':''}) ON CONFLICT(installation_id,source_kind,root_key,context_key)
    DO UPDATE SET ${offlineBasis?'offline_basis=EXCLUDED.offline_basis,':''}source_version=EXCLUDED.source_version,next_cursor=EXCLUDED.next_cursor,state=EXCLUDED.state,updated_at=clock_timestamp()`,
    [scope.installationId,root.kind,root.key,contextKey,JSON.stringify(finalVersion),finalCursor,finalState,...(offlineBasis?[JSON.stringify(offlineBasis)]:[])])
  }
  if(options.checkpoint&&!team&&(prepared.metadata?prepared.metadata.contextReady:!prepared.nextCursor)){
   timing.enter('complete_watermark')
   if(historical)await historical.complete(version)
   else {
    const completed=await completeSourceProjection(client,scope,root,finalVersion)
    if((repair||reuseOriginals)&&!completed)throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
   }
  }
  timing.enter('verify_version')
  if(historical)await historical.guard();else await guardSourceExecutionCommit(client,scope.installationId)
  if(!managed){
   timing.enter('commit')
   if(performance.now()>=deadline)throw Error('canonical_reference_budget_exceeded')
   commitSent=true
   await client.query('COMMIT')
  }
  activeWrite=undefined
  timing.finish()
  return result
 }catch(error){
  if(!managed&&commitSent&&commitOutcomeUnknown(error)){
   discard=true
   throw timing.failure(new Error('projection_commit_outcome_unknown'),true)
  }
  activeWrite=undefined
  timing.failure(error,commitSent)
  if(!managed){
   try{await client.query('ROLLBACK');recordProjectionRollback(error);if(error instanceof ProjectionLockBusy)error.rollbackConfirmed=true}
   catch{discard=true}
  }
  timing.failure(error,commitSent)
   if(prepared.metadata&&(error as {code?:string}).code==='55P03'&&(error as Error).message==='source_metadata_lock_busy')throw new SelectedSourceLockBusy()
  throw error
 }
 }
 if(historical)return persist(historical.client,true)
 if(prepared.metadata)return runSelectedSourceTransaction(pool,scope.installationId,options.signal,(client,deadline)=>persist(client,true,deadline),()=>{
  if(!activeWrite)return undefined
  const error=new Error('canonical_reference_write_timeout')
  activeWrite.failure(error,false)
  return error
 })
 const client=await observeProjectionStep(pool,'checkout',()=>pool.connect())
 try{return await persist(client)}finally{client.release(discard)}
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

/** One short transaction under the existing database owner role. The caller
 * enumerates a frozen set of distribution seals before starting maintenance.
 * Ordinary workers lack this role and keep the live claim and pin requirements. */
export async function projectHistoricalPersonalPage(pool:pg.Pool,input:HistoricalProjectionRoot,options:{pageSize?:number;dryRun?:boolean}={}){
 const root:SourceRoot={kind:'relay_event',key:input.rootKey}
 const pageSize=options.pageSize??32
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>64)throw Error('historical_projection_page_limit')
 const client=await pool.connect()
 let transaction=false
 let rebound=0
 try{
  const role=(await client.query(`SELECT
   current_setting('server_version_num')::int BETWEEN 130000 AND 139999 AS pg13,
   current_user=pg_get_userbyid(n.nspowner) AND NOT r.rolcanlogin AND NOT r.rolsuper AS owner
   FROM pg_namespace n CROSS JOIN pg_roles r WHERE n.nspname='shared' AND r.rolname=current_user`)).rows[0]
  if(role?.pg13!==true||role.owner!==true)throw Error('historical_projection_admin_pg13_required')
  const seal=await readHistoricalProjectionSeal(client,input)
  const {scope}=seal,key=canonicalPayloadHash(scope).toString('hex')
  const args=[input.installationId,root.kind,root.key,key]
  const readCheckpoint=async()=> (await client.query(`SELECT source_version,next_cursor,state FROM memory.memory_canonical_projection_progress
    WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4`,args)).rows[0]
  const checkpoint=await readCheckpoint()
  let sourceSqlState:string|undefined
  // The SDK independently checks authority around both lookups. Reuse the
  // exact keyed SQL observation for head and body instead of reading it twice.
  let keyedObservation:{key:string;rows:pg.QueryResultRow[]}|undefined
  const observedArchives=new Map<string,{args:unknown[];digest:string}>()
  const query=async(sql:string,args?:unknown[])=>{
   try{
    const keyed=args&&sql==='SELECT value FROM shared.read_memory_relay_sources($1::jsonb,$2,$3::bigint,$4,$5::bigint[]) AS value'&&Array.isArray(args[4])
      ?canonicalJsonString(args):undefined
    if(keyed&&keyedObservation?.key===keyed)return {rows:structuredClone(keyedObservation.rows),rowCount:keyedObservation.rows.length}
    const result=await client.query(sql,args)
    if(keyed)keyedObservation={key:keyed,rows:structuredClone(result.rows)}
    if(args&&sql==='SELECT shared.read_memory_relay_archive($1::jsonb,$2,$3::uuid,$4) AS manifest'){
     const manifest=result.rows[0]?.manifest
     if(!manifest)throw new SourceUnavailableError('archive_unavailable')
     const key=String(args[2])+':'+String(args[3]),digest=canonicalPayloadHash(manifest).toString('hex')
     if(observedArchives.has(key)&&observedArchives.get(key)?.digest!==digest)throw new SourceUnavailableError('changed')
     observedArchives.set(key,{args,digest})
    }
    return result
   }catch(error){
    const code=(error as {code?:string}).code
    if(code&&/^[A-Z0-9]{5}$/.test(code))sourceSqlState=code
    throw error
   }
  }
  const reader=createPostgresSharedSourceReader({query,async connect(){throw Error('historical_projection_single_connection_required')}},sourcePoolContext(pool).archive)
  const observed=await reader.checkCurrent(scope,root)
  const version=observed.version
  if(observed.state!=='current'||version.content!==seal.version.content||version.authorization!==seal.version.authorization)
   throw new SourceUnavailableError(observed.state==='current'?'changed':observed.state)
  const checkpointExact=canonicalJsonString(checkpoint?.source_version??null)===canonicalJsonString(version)
  const cursor=checkpointExact&&checkpoint.state==='scanning'&&checkpoint.next_cursor?checkpoint.next_cursor:undefined
  const ready=checkpointExact&&checkpoint.state==='ready'&&checkpoint.next_cursor===null
  const raw=ready?[]:await readHistoricalIds(client,scope,root,version,cursor,pageSize)
  const keys=raw.filter(row=>row.eligible).map(row=>row.id).sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0))
  const cursorScope=canonicalPayloadHash({scope,root}).toString('hex')
  const boundary=raw.find(row=>!row.eligible)?.id??(keys.length===pageSize?keys.at(-1):undefined)
  const physicalCursor=boundary?Buffer.from(canonicalJsonString({v:1,scope:cursorScope,after:boundary,version})).toString('base64url'):undefined
  const page=ready?undefined:await prepareReferencePage(pool,scope,root,reader,{cursor,keys,historicalRange:{version,nextCursor:physicalCursor}}).catch(error=>{
   if(error instanceof SourceUnavailableError&&error.code==='source_store_unavailable'&&sourceSqlState)
    throw new SourceUnavailableError('source_store_'+sourceSqlState)
   throw error
  })
  const prepared=page&&pages.get(page.token)!
  if(prepared&&canonicalJsonString(prepared.version)!==canonicalJsonString(version))throw new SourceUnavailableError('changed')
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  transaction=true
  await client.query("SET LOCAL search_path=pg_catalog,memory,shared; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='400ms'; SET LOCAL idle_in_transaction_session_timeout='8s'; SET LOCAL synchronous_commit='on'")
  // Acquire the established native owner, grant, mode, alias, storage and
  // deletion fences before touching distribution state or derived rows.
  if((await client.query('SELECT shared.lock_memory_personal_source_commit($1,$2,$3,$4,FALSE) AS ok',[scope,root.kind,root.key,version])).rows[0]?.ok!==true)
   throw new SourceUnavailableError('changed')
  const guard=async()=>{
   if((await client.query('SELECT shared.guard_memory_control_commit($1) AS ok',[seal.controlRevision])).rows[0]?.ok!==true)
    throw Error('historical_projection_control_changed')
   const locked=await readHistoricalProjectionSeal(client,input,true)
   if(canonicalJsonString(locked.scope)!==canonicalJsonString(scope)||locked.controlRevision!==seal.controlRevision
    ||canonicalJsonString(locked.version)!==canonicalJsonString(seal.version))throw Error('historical_projection_seal_changed')
  }
  await guard()
  if(!ready&&canonicalJsonString(await readHistoricalIds(client,scope,root,version,cursor,pageSize))!==canonicalJsonString(raw))
   throw new SourceUnavailableError('changed')
  if(canonicalJsonString(await readCheckpoint()??null)!==canonicalJsonString(checkpoint??null))
   throw Error('canonical_reference_cursor_changed')
  if(seal.processedRevision===input.workRevision&&ready){
   await client.query('ROLLBACK')
   transaction=false
   return {state:'already',count:0,created:0,rebound:0,revision:input.workRevision,version,sourceDigest:null}
  }
  if(prepared?.heads.length){
   // The source version covers authoritative inclusion. Also lock the exact
   // rows whose archive locator and digest were checked by the SDK.
   const ids=prepared.heads.map(head=>head.canonicalKey)
   const locked=await client.query('SELECT id FROM public.events WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE NOWAIT',[ids])
   if(locked.rowCount!==ids.length)throw new SourceUnavailableError('changed')
  }
  for(const {args,digest} of observedArchives.values()){
   const locked=await client.query(`SELECT m.manifest_id FROM public.session_archive_manifests m
    JOIN public.session_archive_chunks c USING(manifest_id) WHERE m.manifest_id=$1 AND c.ordinal=$2
    FOR SHARE OF m,c NOWAIT`,args.slice(2))
   const current=(await client.query('SELECT shared.read_memory_relay_archive($1::jsonb,$2,$3::uuid,$4) AS manifest',args)).rows[0]?.manifest
   if(locked.rowCount!==1||!current||canonicalPayloadHash(current).toString('hex')!==digest)throw new SourceUnavailableError('changed')
  }
  const mutex=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[scope.installationId])
  if(mutex.rows[0]?.locked!==true)throw Error('canonical_reference_busy')
  if(prepared?.heads.length){
   // Skip the bounded original-mapping probe on roots without unresolved rows.
   const unresolved=(await client.query(`SELECT EXISTS(SELECT 1 FROM memory.source_events
    WHERE installation_id=$1 AND session_id=ANY($2::text[]) AND mapping_state='unproven') AS found`,
    [scope.installationId,[...new Set(prepared.heads.map(head=>head.sessionKey))]])).rows[0]?.found
   if(unresolved){
    rebound=await bindHistoricalOriginals(client,scope,version,prepared.heads,prepared.payloads)
    if(rebound){
     // Binding changes the ref metadata the SDK returns. Re-read it through
     // the same scoped authority before letting the ordinary verifier consume it.
     keyedObservation=undefined
     const fresh=await reader.getHeads(scope,root,prepared.heads.map(head=>head.canonicalKey))
     if(canonicalJsonString(fresh.version)!==canonicalJsonString(version))throw new SourceUnavailableError('changed')
     for(const [index,head] of fresh.heads.entries()){
      const prior=prepared.heads[index]
      if(head.contentHash!==prior.contentHash||head.canonicalKey!==prior.canonicalKey||head.sessionKey!==prior.sessionKey
       ||head.occurredAt!==prior.occurredAt||head.eventType!==prior.eventType)throw new SourceUnavailableError('changed')
      prepared.heads[index]={...head,...(prior.turnKey?{turnKey:prior.turnKey}:{})}
     }
    }
   }
  }
  const complete=async(exact:SourceVersion)=>{
   await guard()
   const advanced=await client.query(`UPDATE shared.memory_source_progress p
    SET processed_revision=p.dispatched_revision,updated_at=clock_timestamp()
    WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND dispatched_revision=$5 AND processed_revision<=$5
     AND mode_generation=$6 AND EXISTS(SELECT 1 FROM memory.memory_canonical_projection_progress cp
      WHERE cp.installation_id=p.installation_id AND cp.source_kind=p.source_kind AND cp.root_key=p.root_key
       AND cp.context_key=$4 AND cp.state='ready' AND cp.next_cursor IS NULL AND cp.source_version=$7::jsonb)
    RETURNING processed_revision`,[...args,input.workRevision,scope.modeGeneration,exact])
   if(advanced.rowCount!==1)throw Error('historical_projection_progress_changed')
  }
  let references:CanonicalReference[]=[]
  if(page)references=await persistReferencePage(pool,page,{project:true,checkpoint:true},{client,guard,complete})
  else await complete(version)
  if(prepared?.heads.length){
   const stored=await client.query(`SELECT source_event_id::text,canonical_key,canonical_session_key,source_sequence::text,
    encode(content_hash,'hex') AS digest,origin,payload IS NULL AS reference_only,${snapshotProvenanceSql('source_events')} AS source_provenance,mapping_state
    FROM memory.source_events WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[])`,
    [input.installationId,references.map(ref=>ref.sourceEventId)])
   const byId=new Map(stored.rows.map(row=>[row.source_event_id,row]))
   for(const [n,head] of prepared.heads.entries()){
    const ref=references[n],row=byId.get(ref.sourceEventId)
    if(!row||row.mapping_state!=='verified'||row.canonical_key!==head.canonicalKey||row.canonical_session_key!==head.sessionKey
     ||row.digest!==head.contentHash||row.source_sequence!==null&&row.source_sequence!==head.sourceSequence
     ||row.origin==='canonical'&&(!row.reference_only||canonicalJsonString(row.source_provenance)!==canonicalJsonString(head.provenance)))
     throw Error('historical_projection_reference_mismatch')
   }
  }
  const sourceDigest=prepared?canonicalPayloadHash(prepared.heads.map(head=>({
   key:head.canonicalKey,session:head.sessionKey,at:head.occurredAt,hash:head.contentHash,provenance:head.provenance,
  }))).toString('hex'):null
  await client.query(options.dryRun?'ROLLBACK':'COMMIT')
  transaction=false
  return {state:page?.hasMore?'scanning':'ready',count:references.length,created:references.filter(r=>r.created).length,rebound,
   revision:input.workRevision,version,sourceDigest}
 }finally{
  if(transaction)await client.query('ROLLBACK').catch(()=>undefined)
  client.release()
 }
}
