import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,teamReaderProjectionKey,type SourceHead,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {createObservedSourceReader} from './observed-reader.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {sourceExecutionBranchFor,guardSourceExecutionCommit,completeSourceProjection} from './source-execution.js'
import {projectCanonicalDerivedFact} from '../projection/source-projector.js'

interface PreparedPage {pool:pg.Pool;scope:SourceScope;root:SourceRoot;heads:SourceHead[];version:SourceVersion;payloads:Record<string,unknown>[];cursor?:string;nextCursor?:string;enumerated:boolean}
const pages=new WeakMap<object,PreparedPage>()
export interface CanonicalReferencePage {readonly token:object;readonly count:number;readonly nextCursor?:string;readonly hasMore:boolean}
export interface CanonicalReference {sourceEventId:string;canonicalKey:string;sessionId:string;created:boolean}
function requireExecution(pool:pg.Pool,installationId:string):void{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('canonical_reference_requires_physical_pool')
 if(sourceExecutionBranchFor(pool,installationId)!=='canonical-active')throw Error('canonical_reference_execution_required')
}
/** Authoritative heads are prepared before BEGIN. The opaque token prevents
 * a caller from substituting an invented hash, identity, timestamp or scope. */
export async function prepareCanonicalReferencePage(pool:pg.Pool,scope:SourceScope,root:SourceRoot,options:{keys?:readonly string[];cursor?:string;limit?:number}={}):Promise<CanonicalReferencePage>{
 scope=structuredClone(scope);root=structuredClone(root);options=structuredClone(options)
 requireExecution(pool,scope.installationId)
 if(root.kind==='legacy_archive'||options.keys&&(options.cursor!==undefined||options.limit!==undefined))throw Error('canonical_reference_request_invalid')
 const context=sourcePoolContext(pool),reader=createObservedSourceReader(pool,context.archive)
 const page=options.keys?await reader.getHeads(scope,root,options.keys):await reader.listHeads(scope,root,{cursor:options.cursor,limit:options.limit??64})
 const heads=structuredClone(page.heads)
 // Historical personal headers may not carry a turn. Resolve those bodies
 // outside BEGIN, keep only their literal turn ID, then discard the bodies.
 const bodies=heads.length?await reader.resolveBodies(scope,root,heads,page.version):[]
 const payloads:Record<string,unknown>[]=[]
 for(const body of bodies){
   if(body.payload===null||typeof body.payload!=='object'||Array.isArray(body.payload))throw Error('canonical_reference_payload_invalid')
   const payload=body.payload as Record<string,unknown>
   payloads.push(payload)
   const raw=payload?.turn_id??payload?.source_turn_id
   if(root.kind==='relay_event'&&typeof raw==='string'&&raw.length>0&&raw.length<=1024)heads.find(h=>h.canonicalKey===body.head.canonicalKey)!.turnKey=raw
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
 pages.set(token,{pool,scope:structuredClone(scope),root:structuredClone(root),heads,version:structuredClone(page.version),payloads,cursor:options.cursor,nextCursor,enumerated:!options.keys})
 return Object.freeze({token,count:heads.length,...(nextCursor?{nextCursor}:{}),hasMore:nextCursor!==undefined})
}

/** Bounded metadata-only physical transaction. It neither copies a body nor
 * rewrites an existing UUID, origin, original digest or provenance. */
export async function persistCanonicalReferencePage(pool:pg.Pool,page:CanonicalReferencePage,options:{project?:boolean;stabilizationMs?:number;checkpoint?:boolean}={}):Promise<CanonicalReference[]>{
 const prepared=pages.get(page.token)
 if(!prepared||prepared.pool!==pool)throw Error('canonical_reference_token_invalid')
 const {scope,root,heads,version,payloads}=prepared
 const team=root.kind==='team_collaboration'||root.kind==='team_delivery'
 const checkpointState=prepared.nextCursor?'scanning':team?'raw_ready':'ready'
 const stabilizationMs=options.stabilizationMs??30000
 if(!Number.isSafeInteger(stabilizationMs)||stabilizationMs<0||stabilizationMs>86400000)throw Error('canonical_reference_request_invalid')
 requireExecution(pool,scope.installationId)
 if(options.checkpoint&&!prepared.enumerated)throw Error('canonical_reference_enumeration_required')
 if(options.checkpoint&&!options.project)throw Error('canonical_reference_projection_required')
 if(!heads.length&&!options.checkpoint)return []
 const client=await pool.connect(),deadline=performance.now()+5000
 const query=(sql:string,args?:unknown[])=>{
  if(performance.now()>=deadline)throw Error('canonical_reference_budget_exceeded')
  return client.query(sql,args)
 }
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'")
  await guardSourceExecutionCommit(client,scope.installationId)
  const fn=root.kind==='relay_event'?'lock_memory_personal_source_commit':'lock_memory_team_source_commit'
  const locked=(await query(`SELECT shared.${fn}($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked`,[JSON.stringify(scope),root.kind,root.key,JSON.stringify(version)])).rows[0]?.locked
  if(locked!==true)throw Error('canonical_reference_changed')
  const mutex=(await query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[scope.installationId])).rows[0]?.locked
  if(mutex!==true)throw Error('canonical_reference_busy')
  const contextKey=canonicalPayloadHash(scope).toString('hex')
  let checkpointDuplicate=false
  if(options.checkpoint){
   const current=(await query(`SELECT source_version,next_cursor,state FROM memory_canonical_projection_progress
    WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4 FOR UPDATE NOWAIT`,[scope.installationId,root.kind,root.key,contextKey])).rows[0]
   const same=current&&canonicalJsonString(current.source_version)===canonicalJsonString(version)
   checkpointDuplicate=!!same&&current.next_cursor===(prepared.nextCursor??null)&&current.state===checkpointState
   if(!checkpointDuplicate&&((!current||!same)?prepared.cursor!==undefined:current.state!=='scanning'||current.next_cursor!==(prepared.cursor??null)))throw Error('canonical_reference_cursor_changed')
  }
  const sessions=[...new Set(heads.map(h=>h.sessionKey))].sort()
  // Unknown historical rows must be mapped/explicitly retained by M0 first.
  // Matching text or a hash is not authority to mint a second source UUID.
  const unproven=await query(`SELECT source_event_id FROM source_events WHERE installation_id=$1
   AND(session_id=ANY($2::text[]) OR canonical_session_key=ANY($2::text[])) AND mapping_state IN('unproven','conflict') LIMIT 1`,[scope.installationId,sessions])
  if(unproven.rowCount)throw Error('canonical_reference_mapping_required')
  const existing=(await query(`SELECT s.source_event_id::text,s.canonical_key,s.canonical_session_key,s.session_id,s.turn_id,s.event_type,s.content_hash,s.classification,s.mapping_state,s.origin,s.source_provenance,s.canonical_projected_at,p.canonical_key AS matched_key,
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
  if(options.checkpoint&&!checkpointDuplicate){
   await query(`INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,next_cursor,state)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(installation_id,source_kind,root_key,context_key)
    DO UPDATE SET source_version=EXCLUDED.source_version,next_cursor=EXCLUDED.next_cursor,state=EXCLUDED.state,updated_at=clock_timestamp()`,
    [scope.installationId,root.kind,root.key,contextKey,JSON.stringify(version),prepared.nextCursor??null,checkpointState])
  }
  if(options.checkpoint&&!prepared.nextCursor&&!team)await completeSourceProjection(client,scope,root,version)
  await guardSourceExecutionCommit(client,scope.installationId)
  await query('COMMIT');return result
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
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
