import type pg from 'pg'
import {
 canonicalJsonString,canonicalPayloadHash,canonicalSourceClassification,createPostgresSharedSourceReader,
 type SourceRoot,type SourceScope,type SourceVersion,
} from '@pocketctl/session-source'
import {originalIngressEventHash,readIngressKeyIndex} from '../shared-source/ingress-key.js'
import {matchRetainedInboxEnvelopeHeader} from '../shared-source/retained-inbox-envelope.js'
import {relaySourceUsageDeniedSql} from '../shared-db/reader-contract.js'
import {JOB_PRIORITIES} from '../../jobs/types.js'
import {ORIGINAL_REPAIR_MAX_ROWS,ORIGINAL_REPAIR_PAGE_SIZE} from '../../sources/canonical-references.js'

export interface CurrentOriginalReferenceBinding {
 database:string
 migratorRole:string
 runtimeRole:string
 scope:SourceScope
 root:SourceRoot
 version:SourceVersion
 ingressIndexHash:string
 expectedEvidence?:{count:number;feed:number;ingress:number;digest:string}
 originals:{sourceEventId:string;canonicalKey:string;sourceRowVersion:string;nativeRowVersion:string}[]
 /** A bounded mapping-only step. Installation completion remains a separate Worker operation. */
 page?:{after:string|null;hasMore:boolean}
 projectionRecovery?:{scanId:string;terminalJobId:string}
}

export interface CurrentOriginalBindingBoundary {
 state:'transaction-started'|'prepared'|'commit-outcome-unknown'|'committed'
 transactionId:string
 backendPid:number
 page?:{after:string|null;through:string;hasMore:boolean;proofDigest:string}
}

export class CurrentOriginalBindingCommitUnknown extends Error {
 constructor(cause:unknown){
  super('current_original_binding_commit_unknown',{cause})
  this.name='CurrentOriginalBindingCommitUnknown'
 }
}

export class CurrentOriginalBindingTransactionUnknown extends Error {
 constructor(cause:unknown){
  super('current_original_binding_transaction_unknown',{cause})
  this.name='CurrentOriginalBindingTransactionUnknown'
 }
}

export class CurrentOriginalBindingCommittedReceiptFailed extends Error {
 constructor(cause:unknown){
  super('current_original_binding_committed_receipt_failed',{cause})
  this.name='CurrentOriginalBindingCommittedReceiptFailed'
 }
}

const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const key=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n
const same=(a:unknown,b:unknown)=>canonicalJsonString(a)===canonicalJsonString(b)
const immutableColumns=['source_kind','canonical_key','canonical_session_key','source_version','content_hash','hash_version','mapping_state','adapter_version']

/** Bind current originals after physical transport retirement. The operator
 * supplies a dedicated connection and durably acknowledges each boundary. */
export async function bindCurrentOriginalReferences(db:pg.Client,input:CurrentOriginalReferenceBinding,
 acknowledge:(boundary:CurrentOriginalBindingBoundary)=>Promise<{durable:boolean;sha256:string}>){
 const {database,migratorRole,runtimeRole,scope,root,version,ingressIndexHash,expectedEvidence,originals,page,projectionRecovery}=structuredClone(input)
 const ids=originals.map(item=>item.sourceEventId),keys=originals.map(item=>item.canonicalKey)
 if(!uuid.test(scope.installationId)||scope.ownerScopeKind!=='personal'||root.kind!=='relay_event'||!root.key.startsWith(scope.principalUserId+':')
  ||!/^[a-f0-9]{64}$/.test(ingressIndexHash)||originals.length<1||originals.length>ORIGINAL_REPAIR_MAX_ROWS||typeof acknowledge!=='function'
  ||expectedEvidence&&(expectedEvidence.count!==originals.length||expectedEvidence.feed+expectedEvidence.ingress!==expectedEvidence.count
   ||!Number.isSafeInteger(expectedEvidence.feed)||expectedEvidence.feed<0||!Number.isSafeInteger(expectedEvidence.ingress)||expectedEvidence.ingress<0
   ||!/^[a-f0-9]{64}$/.test(expectedEvidence.digest))
  ||projectionRecovery&&(!uuid.test(projectionRecovery.scanId)||!uuid.test(projectionRecovery.terminalJobId))
  ||page&&(projectionRecovery!==undefined&&page.hasMore||typeof page.hasMore!=='boolean'||originals.length>ORIGINAL_REPAIR_PAGE_SIZE
   ||page.after!==null&&(typeof page.after!=='string'||!key(page.after)))
  ||new Set(ids).size!==ids.length||new Set(keys).size!==keys.length
  ||originals.some(item=>!uuid.test(item.sourceEventId)||!key(item.canonicalKey)||!/^\d{1,10}$/.test(item.sourceRowVersion)||!/^\d{1,10}$/.test(item.nativeRowVersion)))throw Error('current_original_binding_input')
 if('release' in db||db.getTransactionStatus()!=='I')throw Error('current_original_binding_connection_not_idle')
 let began=false,commitStarted=false,committed=false
 const require=(condition:unknown,code:string)=>{if(!condition)throw Error(code)}
 const immutable=async()=>(await db.query(`SELECT encode(sha256(convert_to(jsonb_agg(to_jsonb(s)-$2::text[]
  ORDER BY s.source_event_id)::text,'UTF8')),'hex') AS digest FROM memory.source_events s WHERE s.source_event_id=ANY($1::uuid[])`,[ids,immutableColumns])).rows[0].digest
 try{
  began=true
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL synchronous_commit='on'; SET LOCAL timezone='UTC'; SET LOCAL jit=off")
  const identity=(await db.query(`SELECT current_database() AS database,current_user AS role,r.rolcanlogin,r.rolsuper,
   r.oid=(SELECT relowner FROM pg_class WHERE oid='memory.source_events'::regclass) AS owns_sources,
   EXISTS(SELECT 1 FROM pg_roles writer WHERE writer.rolname=$1 AND writer.rolcanlogin AND NOT writer.rolsuper
    AND NOT pg_has_role(writer.oid,r.oid,'MEMBER') AND has_table_privilege(writer.oid,'memory.source_events','UPDATE')) AS runtime_isolated,
   (SELECT legacy_transport_retired FROM shared.memory_source_contract) AS retired,
   NOT EXISTS(SELECT 1 FROM unnest(ARRAY['memory_feed_inbox','memory_snapshot_events','memory_snapshot_runs','memory_inbox_checkpoints']) name
    WHERE to_regclass('memory.'||name) IS NOT NULL) AS transport_absent
   FROM pg_roles r WHERE r.rolname=current_user`,[runtimeRole])).rows[0]
  require(identity?.database===database&&identity?.role===migratorRole&&identity.rolcanlogin===false&&identity.rolsuper===false
   &&identity.owns_sources&&identity.runtime_isolated&&identity.retired&&identity.transport_absent,'current_original_binding_database')
  const drain=async()=>{
   await db.query('SELECT pg_stat_clear_snapshot()')
   const state=(await db.query(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity
    WHERE datname=current_database() AND usename=$1) AS disconnected,
    NOT EXISTS(SELECT 1 FROM shared.memory_source_provider_attempts WHERE state='inflight') AS provider_drained`,[runtimeRole])).rows[0]
   require(state?.disconnected&&state.provider_drained,'current_original_binding_runtime_not_drained')
  }
  await drain()
  const tx=(await db.query(`SELECT pg_backend_pid() AS pid,txid_current()::text AS tx,
   current_setting('synchronous_commit') AS commit_setting,current_setting('fsync') AS fsync,
   current_setting('session_replication_role') AS replication_role`)).rows[0]
  require(tx?.pid===(db as pg.Client&{processID?:number}).processID&&typeof tx.tx==='string'&&/^\d+$/.test(tx.tx)&&tx.commit_setting==='on'&&tx.fsync==='on'
   &&tx.replication_role==='origin'&&db.getTransactionStatus()==='T','current_original_binding_physical_transaction')
  let pageReceipt:CurrentOriginalBindingBoundary['page']
  const boundary=async(state:CurrentOriginalBindingBoundary['state'])=>{
   const record={state,transactionId:tx.tx,backendPid:tx.pid,...(pageReceipt?{page:pageReceipt}:{})},hash=canonicalPayloadHash(record).toString('hex')
   const receipt=await acknowledge(record)
   require(receipt?.durable===true&&receipt.sha256===hash,'current_original_binding_boundary')
  }
  const deadline=performance.now()+12000
  await boundary('transaction-started')
  const fence=(await db.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',[scope,root.kind,root.key,version])).rows[0]
  require(fence?.locked===true,'current_original_binding_authority')
  const mutex=(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[scope.installationId])).rows[0]
  require(mutex?.locked===true,'current_original_binding_busy')
  require((await readIngressKeyIndex(db))?.definitionHash===ingressIndexHash,'current_original_binding_ingress_index')
  const reader=createPostgresSharedSourceReader({
   query:db.query.bind(db),
   async connect(){throw Error('current_original_binding_single_connection_required')},
  })
  const session=(await db.query('SELECT public.native_session_authority($1,$2::int,NULL) AS authority',
   [root.key.slice(scope.principalUserId.length+1),scope.principalUserId])).rows[0]?.authority
  require(session?.state==='current'&&Array.isArray(session.sessionIds),'current_original_binding_authority')
  const native=(await db.query(`SELECT id::text,xmin::text AS row_version,session_id,logical_source_session_id,event_type,event_hash,
   source_header_version,source_classification,created_at::text AS exact_time,date_trunc('milliseconds',created_at)::text AS millis_time
   FROM public.events WHERE id=ANY($1::bigint[]) AND user_id=$2::int AND session_id=$3
    AND logical_source_session_id=ANY($4::text[]) AND NOT owner_retired AND body_storage='hot'
   ORDER BY id FOR SHARE NOWAIT`,[keys,scope.principalUserId,session.sessionId,session.sessionIds])).rows
  const rows=(await db.query(`SELECT source_event_id::text,xmin::text AS row_version,origin,origin_position,canonical_event_key,session_id,turn_id,event_type,
   occurred_at::text AS exact_time,payload_hash,classification,source_provenance
   FROM memory.source_events WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) AND origin='feed'
    AND body_reclaimed_at IS NULL AND mapping_state='unproven' AND source_kind IS NULL AND canonical_key IS NULL AND canonical_session_key IS NULL
    AND source_sequence IS NULL AND source_version IS NULL AND content_hash IS NULL AND hash_version IS NULL AND adapter_version IS NULL
    AND pg_column_size(classification)<=32768 AND pg_column_size(source_provenance)<=32768
   ORDER BY source_event_id FOR UPDATE NOWAIT`,[scope.installationId,ids])).rows
  require(native.length===keys.length&&rows.length===ids.length,'current_original_binding_row_missing')
  const feedIds=rows.map(row=>row.origin_position).filter(key)
  const receipts=(await db.query(`SELECT feed_id::text,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,
   recorded_at,recorded_at::text AS exact_time,encode(payload_hash,'hex') AS envelope_hash,projection_state,error_code,
   encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') AS revision
   FROM memory.memory_source_delivery_facts f WHERE installation_id=$1 AND feed_id=ANY($2::bigint[]) ORDER BY feed_id FOR SHARE NOWAIT`,
  [scope.installationId,feedIds])).rows
  const byOriginal=new Map(rows.map(row=>[row.source_event_id,row]))
  const byNative=new Map(native.map(row=>[row.id,row]))
  const byReceipt=new Map(receipts.map(row=>[row.feed_id,row]))
  const witness=new Map(originals.map(item=>[item.canonicalKey,item]))
  const proofKinds={feed:0,ingress:0},proofs=[]
  for(const item of originals){
   const row=byOriginal.get(item.sourceEventId),nativeRow=byNative.get(item.canonicalKey)
   require(row?.row_version===item.sourceRowVersion&&nativeRow?.row_version===item.nativeRowVersion
    &&row.session_id===nativeRow.logical_source_session_id&&row.event_type===nativeRow.event_type
    &&(row.exact_time===nativeRow.exact_time||row.exact_time===nativeRow.millis_time),
    'current_original_binding_subject')
   const receipt=byReceipt.get(row.origin_position)
   if(receipt){
    require(receipt.source_id==='event:'+item.canonicalKey&&receipt.session_id===row.session_id&&receipt.turn_id===row.turn_id&&receipt.event_type===row.event_type
     &&receipt.exact_time===row.exact_time&&receipt.projection_state==='projected'&&receipt.error_code===null,
     'current_original_binding_receipt')
   }else{
    const literal=typeof row.canonical_event_key==='string'&&row.canonical_event_key.startsWith('event_id:')?row.canonical_event_key.slice(9):undefined
    const ingress=originalIngressEventHash({...row,payload:{event_id:literal}})
    require(ingress&&ingress===nativeRow.event_hash&&nativeRow.session_id===row.session_id,'current_original_binding_ingress')
   }
  }
  // Match the ordinary reader's unkeyed eligibility with an ID-only result.
  // Retention may inspect historical turn fields inside PostgreSQL.
  const sortedKeys=[...keys].sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0))
  const eligible=async(after:string|null,limit:number)=>(await db.query(`SELECT e.id::text AS id FROM (
    SELECT id FROM public.events WHERE session_id=$2 AND ($4::bigint IS NULL OR id>$4::bigint) ORDER BY id OFFSET 0) ordered
    CROSS JOIN LATERAL(SELECT * FROM public.events WHERE id=ordered.id OFFSET 0)e
    LEFT JOIN memory.source_events r ON r.installation_id=($1::jsonb->>'installationId')::uuid
     AND r.source_kind='relay_event' AND r.canonical_key=e.id::text AND r.mapping_state='verified'
    WHERE e.session_id=$2 AND e.user_id=$3::int AND NOT e.owner_retired AND ($4::bigint IS NULL OR e.id>$4::bigint)
     AND public.native_event_authority(e.id,$3::int)->>'state'='current'
     AND shared.memory_relay_input_admitted($1::jsonb,e.id,FALSE) AND e.effect_status IN('none','completed')
     AND NOT(${relaySourceUsageDeniedSql('e','r','$1::jsonb')})
    ORDER BY ordered.id LIMIT $5`,[scope,session.sessionId,scope.principalUserId,after,limit])).rows.map(row=>row.id)
  const through=sortedKeys.at(-1)!
  const assertPage=async(page:NonNullable<CurrentOriginalReferenceBinding['page']>)=>{
   const observed=await eligible(page.after,sortedKeys.length+1)
   require(same(observed.slice(0,sortedKeys.length),sortedKeys)
    &&(observed.length>sortedKeys.length)===page.hasMore,'current_original_binding_roster')
  }
  if(page){
   await assertPage(page)
  }else{
   let after:string|null=null
   for(let offset=0;offset<=sortedKeys.length;offset+=ORIGINAL_REPAIR_PAGE_SIZE){
    const expected=sortedKeys.slice(offset,offset+ORIGINAL_REPAIR_PAGE_SIZE)
    require(same(await eligible(after,Math.min(expected.length+1,ORIGINAL_REPAIR_PAGE_SIZE)),expected),'current_original_binding_roster')
    if(expected.length<ORIGINAL_REPAIR_PAGE_SIZE)break
    after=expected.at(-1)!
   }
  }
  const readBoundHeads=async()=>{
   const heads=[]
   for(let offset=0;offset<keys.length;offset+=ORIGINAL_REPAIR_PAGE_SIZE){
    const part=keys.slice(offset,offset+ORIGINAL_REPAIR_PAGE_SIZE),page=await reader.getHeads(scope,root,part)
    require(same(page.version,version)&&same(page.heads.map(head=>head.canonicalKey),part)
     &&page.heads.every(head=>head.storage==='hot'&&head.provenance.state==='unknown'),'current_original_binding_roster')
    heads.push(...page.heads)
   }
   return heads
  }
  const heads=await readBoundHeads()
  for(let offset=0;offset<heads.length;offset+=16){
   require(performance.now()<deadline,'current_original_binding_deadline')
   const batch=heads.slice(offset,offset+16)
   const oldIds=batch.map(head=>witness.get(head.canonicalKey)!.sourceEventId)
   const originalBodies=(await db.query(`SELECT source_event_id::text,payload FROM memory.source_events
    WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) AND body_reclaimed_at IS NULL AND octet_length(payload::text)<=65536`,
   [scope.installationId,oldIds])).rows
   require(originalBodies.length===oldIds.length,'current_original_binding_body')
   const originalsById=new Map(originalBodies.map(row=>[row.source_event_id,row.payload]))
   const bodies=await reader.resolveBodies(scope,root,batch,version)
   for(const {head,payload:value} of bodies){
    const item=witness.get(head.canonicalKey)!,row=byOriginal.get(item.sourceEventId),nativeRow=byNative.get(item.canonicalKey)
    const original=originalsById.get(item.sourceEventId),payload=value as Record<string,unknown>
    require(payload&&(payload.turn_id??payload.source_turn_id??null)===row.turn_id,'current_original_binding_subject')
    require(original&&Buffer.isBuffer(row.payload_hash)&&canonicalPayloadHash(original).equals(row.payload_hash)
     &&row.payload_hash.toString('hex')===head.contentHash&&same(original,payload)
     &&same(row.classification,canonicalSourceClassification({source_kind:'canonical_event',session_id:row.session_id,source_seq:'',payload}))
     &&(nativeRow.source_header_version!==1||same(row.classification,nativeRow.source_classification))
     &&row.source_provenance&&typeof row.source_provenance==='object'&&!Array.isArray(row.source_provenance)
     &&!['memory','team','accepted_delivery'].some(field=>Object.hasOwn(row.source_provenance,field))
     &&!Object.hasOwn(row.classification,'memory_source'),'current_original_binding_body')
    const receipt=byReceipt.get(row.origin_position)
    if(receipt){
     require(matchRetainedInboxEnvelopeHeader(receipt,payload,row.classification),'current_original_binding_receipt')
     proofKinds.feed++
    }else{
     const ingress=originalIngressEventHash({...row,payload:original})
     require(ingress&&ingress===nativeRow.event_hash&&payload.event_id===original.event_id,'current_original_binding_ingress')
     proofKinds.ingress++
    }
    proofs.push({kind:receipt?'feed':'ingress',sourceEventId:item.sourceEventId,originalXmin:item.sourceRowVersion,nativeXmin:item.nativeRowVersion,
     canonicalId:item.canonicalKey,originalHash:row.payload_hash.toString('hex'),canonicalHash:head.contentHash,
     classificationHash:canonicalPayloadHash(row.classification).toString('hex'),provenanceHash:canonicalPayloadHash(row.source_provenance).toString('hex'),
     ingressHash:nativeRow.event_hash,receiptRevision:receipt?.revision??null})
   }
  }
  require(proofKinds.feed+proofKinds.ingress===keys.length,'current_original_binding_incomplete')
  proofs.sort((a,b)=>a.sourceEventId<b.sourceEventId?-1:a.sourceEventId>b.sourceEventId?1:0)
  const digest=canonicalPayloadHash({scope,root,sourceVersion:version,indexDefinitionSha256:ingressIndexHash,
   ...(page?{page:{after:page.after,through,hasMore:page.hasMore}}:{}),proofRows:proofs}).toString('hex')
  require(!expectedEvidence||expectedEvidence.digest===digest&&expectedEvidence.feed===proofKinds.feed&&expectedEvidence.ingress===proofKinds.ingress,
   'current_original_binding_evidence')
  const before=await immutable()
  const changes=heads.map(head=>({source_event_id:witness.get(head.canonicalKey)!.sourceEventId,canonical_key:head.canonicalKey,content_hash:head.contentHash}))
  const result=await db.query(`UPDATE memory.source_events s SET source_kind='relay_event',canonical_key=r.canonical_key,canonical_session_key=s.session_id,
   source_version=$3::jsonb,content_hash=decode(r.content_hash,'hex'),hash_version='canonical-json-sha256-v1',mapping_state='verified',adapter_version='original-ref-v1'
   FROM jsonb_to_recordset($2::jsonb) r(source_event_id uuid,canonical_key text,content_hash text)
   WHERE s.installation_id=$1 AND s.source_event_id=r.source_event_id AND s.mapping_state='unproven' AND s.body_reclaimed_at IS NULL`,
  [scope.installationId,JSON.stringify(changes),version])
  require(result.rowCount===ids.length&&before===await immutable(),'current_original_binding_immutable_row')
  const rebound=await readBoundHeads()
  require(same(rebound.map(h=>[h.canonicalKey,h.contentHash,h.provenance.state]),
   heads.map(h=>[h.canonicalKey,h.contentHash,h.provenance.state])),'current_original_binding_post_read')
  if(page){
   await assertPage(page)
   pageReceipt={after:page.after,through,hasMore:page.hasMore,proofDigest:digest}
  }
  if(projectionRecovery){
   if(page){
    const clear=(await db.query(`SELECT NOT EXISTS(SELECT 1 FROM memory.source_events
     WHERE installation_id=$1 AND session_id=ANY($2::text[]) AND mapping_state IN('unproven','conflict'))
     AND NOT EXISTS(SELECT 1 FROM memory.source_events
     WHERE installation_id=$1 AND canonical_session_key=ANY($2::text[]) AND mapping_state IN('unproven','conflict')) AS clear`,
    [scope.installationId,session.sessionIds])).rows[0]?.clear
    require(clear===true,'current_original_binding_earlier_pages_required')
   }
   const queued=await db.query(`INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
    SELECT gen_random_uuid(),t.installation_id,'project_shared_source','original-binding:'||j.job_id::text,$7,
     j.payload||jsonb_build_object('reference_repair_version',$6::jsonb)||CASE WHEN $10::boolean
      THEN jsonb_build_object('reference_repair_paged',TRUE)
      ELSE jsonb_build_object('reference_repair_original_ids',$8::uuid[],'reference_repair_canonical_ids',$9::text[]) END
    FROM shared.memory_source_distributions d
    JOIN shared.memory_source_work w USING(source_kind,root_key)
    JOIN shared.memory_source_progress p ON p.source_kind=d.source_kind AND p.root_key=d.root_key AND p.installation_id=$3
    JOIN shared.memory_source_distribution_targets t ON t.scan_id=d.scan_id AND t.installation_id=p.installation_id
    JOIN shared.memory_source_modes m ON m.installation_id=t.installation_id
    JOIN memory.memory_jobs j ON j.job_id=$2 AND j.installation_id=t.installation_id
    JOIN memory.memory_dead_letters l ON l.job_id=j.job_id AND l.installation_id=j.installation_id
    WHERE d.scan_id=$1 AND d.source_kind='relay_event' AND d.root_key=$4 AND d.state='sealed' AND d.dispatch_complete
     AND d.work_revision=w.revision AND w.processed_revision=w.revision AND w.dead_at IS NULL
     AND p.dispatched_revision=d.work_revision AND p.processed_revision<d.work_revision AND p.mode_generation=m.generation
     AND m.mode='shared-active' AND m.generation::text=t.source_scope->>'modeGeneration'
     AND t.state='current' AND t.target_mode='shared-active' AND t.source_scope=$5::jsonb
     AND t.source_version->>'content'=$6::jsonb->>'content' AND t.source_version->>'authorization'=$6::jsonb->>'authorization'
     AND (SELECT count(*) FROM shared.memory_source_distribution_targets own WHERE own.scan_id=d.scan_id AND own.installation_id=t.installation_id)=1
     AND j.state='dead' AND j.job_type='project_shared_source' AND j.completed_at IS NOT NULL
     AND l.job_type=j.job_type AND l.attempts=j.attempts AND l.error_code=j.last_error_code
     AND j.idempotency_key='shared-source:'||d.scan_id::text||':'||encode(sha256(convert_to(t.cursor_key,'UTF8')),'hex')
     AND j.payload=jsonb_build_object('scope',t.source_scope,'root',jsonb_build_object('kind',d.source_kind,'key',d.root_key),
      'distribution_scan',d.scan_id::text,'target_cursor',t.cursor_key)
     AND shared.guard_memory_control_commit(d.control_revision)
    FOR SHARE OF d,p,t,j,l NOWAIT
    ON CONFLICT DO NOTHING RETURNING job_id`,
   [projectionRecovery.scanId,projectionRecovery.terminalJobId,scope.installationId,root.key,scope,version,JOB_PRIORITIES.project_shared_source,ids,keys,!!page])
   require(queued.rowCount===1,'current_original_binding_projection_recovery')
  }
  await boundary('prepared')
  await boundary('commit-outcome-unknown')
  await drain()
  require((await db.query('SELECT txid_current()::text AS tx')).rows[0]?.tx===tx.tx
   &&db.getTransactionStatus()==='T'&&performance.now()<deadline,'current_original_binding_physical_transaction')
  commitStarted=true
  require((await db.query('COMMIT')).command==='COMMIT'&&db.getTransactionStatus()==='I','current_original_binding_commit_unknown')
  committed=true
  await boundary('committed')
  return {changed:ids.length,proofKinds,digest,immutableRowsPreserved:true}
 }catch(error){
  if(committed)throw new CurrentOriginalBindingCommittedReceiptFailed(error)
  if(commitStarted)throw new CurrentOriginalBindingCommitUnknown(error)
  if(began){
   try{require((await db.query('ROLLBACK')).command==='ROLLBACK'&&db.getTransactionStatus()==='I','current_original_binding_rollback')}
   catch(rollback){throw new CurrentOriginalBindingTransactionUnknown(new AggregateError([error,rollback]))}
  }
  throw error
 }
}
