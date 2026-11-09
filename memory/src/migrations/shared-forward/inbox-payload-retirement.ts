import type pg from 'pg'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {qi} from './source-maintenance-common.js'
import {matchRetainedInboxEnvelope} from '../shared-source/retained-inbox-envelope.js'
import {prepareSourceReferences,type PreparedSources} from '../../sources/prepared-sources.js'
import {sourcePoolContext} from '../../sources/pool-context.js'
type Db=pg.Client
export interface InboxRetirementInput {
 installationId:string;modeGeneration:string;configVersion:string;principalUserId:string;runtimeRole:string
 expectedDatabase:{name:string;oid:string;systemIdentifier:string};feedIds:readonly string[]
}
const digest=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const positive=(v:string)=>/^[1-9][0-9]*$/.test(v)
const pageByteLimit=32*1024*1024
export function assertRetirementIdleConnection(db:Db){
 if(typeof db.getTransactionStatus!=='function'||db.getTransactionStatus()!=='I'||(db as Db&{readyForQuery?:boolean}).readyForQuery!==true)throw Error('inbox_retirement_idle_connection_required')
}
const versionInput=(rows:Record<string,any>[])=>JSON.stringify(rows.map(r=>({feed_id:r.feed_id,inbox_xmin:r.inbox_xmin,source_xmin:r.source_xmin})))
const joinSource=`LEFT JOIN memory.source_events s ON s.installation_id=i.installation_id AND s.origin='feed' AND s.origin_position=i.feed_id::text`
// Only sizes and MVCC identities cross the wire before the complete page budget
// is accepted. The later body query is constrained to those exact versions.
const sizesSql=`SELECT i.feed_id::text,i.xmin::text AS inbox_xmin,s.xmin::text AS source_xmin,octet_length(s.payload_hash) AS source_hash_bytes,
 (octet_length(to_jsonb(i)::text)::bigint+octet_length(jsonb_build_object(
 'canonical_key',s.canonical_key,'canonical_session_key',s.canonical_session_key,
 'adapter_version',s.adapter_version,'mapping_state',s.mapping_state,'source_kind',s.source_kind)::text)::bigint+4096)::text AS work_bytes
 FROM memory.memory_feed_inbox i ${joinSource}
 WHERE i.installation_id=$1 AND i.feed_id=ANY($2::bigint[]) ORDER BY i.feed_id`

const headers=['installation_id','feed_id','envelope_version','topic','source_kind','source_id','session_id','turn_id','event_type','recorded_at','payload_hash','projection_state','error_code','received_at','projected_at']
const header=(r:Record<string,any>)=>digest(Object.fromEntries(headers.map(k=>[k,r[k] instanceof Date?r[k].toISOString():Buffer.isBuffer(r[k])?r[k].toString('hex'):r[k]])))
const rowsSql=`SELECT i.*,i.feed_id::text AS feed_id,i.xmin::text AS inbox_xmin,encode(i.payload_hash,'hex') AS envelope_hash,
 s.source_event_id::text,s.xmin::text AS source_xmin,encode(s.payload_hash,'hex') AS original_hash,
 s.payload IS NOT NULL AS source_body_present,s.payload=i.data AS body_equal,s.classification=i.classification AS classification_equal,
 s.body_reclaimed_at AS source_reclaimed,s.mapping_state,s.source_kind AS bound_kind,s.adapter_version,s.canonical_key,s.canonical_session_key,
 (s.session_id IS NOT DISTINCT FROM i.session_id AND s.turn_id IS NOT DISTINCT FROM i.turn_id AND s.event_type=i.event_type AND s.occurred_at=i.recorded_at) AS identity_equal
 FROM memory.memory_feed_inbox i ${joinSource}
 WHERE i.installation_id=$1 AND i.feed_id=ANY($2::bigint[])
 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS v(feed_id bigint,inbox_xmin text,source_xmin text)
 WHERE v.feed_id=i.feed_id AND v.inbox_xmin=i.xmin::text AND v.source_xmin IS NOT DISTINCT FROM s.xmin::text)
 ORDER BY i.feed_id`
interface Proof {db:Db;input:InboxRetirementInput;rows:Record<string,any>[];prepared?:PreparedSources;proofHash:string;normalizedRows:number}
const pages=new WeakMap<object,Proof>()
export async function assertInboxRetirementScope(db:Db,input:InboxRetirementInput,lock=false){
 const identity=(await db.query(`SELECT current_database() AS database_name,d.oid::text AS database_oid,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,r.rolsuper
  FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`)).rows[0]
 if(sourcePoolContext(db).namespace!=='memory'||!identity?.rolsuper||identity.database_name!==input.expectedDatabase.name||identity.database_oid!==input.expectedDatabase.oid||identity.system_identifier!==input.expectedDatabase.systemIdentifier)throw Error('inbox_retirement_identity_mismatch')
 await assertTargetMemoryWritersFenced(db)
 const role=(await db.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
  has_table_privilege(oid,'memory.source_events','SELECT') AS source_read,has_table_privilege(oid,'public.events','SELECT,INSERT,UPDATE,DELETE') AS canonical_privilege
  FROM pg_roles WHERE rolname=$1`,[input.runtimeRole])).rows[0]
 if(!role||role.rolcanlogin||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls||!role.source_read||role.canonical_privilege)throw Error('inbox_retirement_runtime_role_invalid')
 const scope=(await db.query(`SELECT m.mode,m.generation::text,i.config_version::text,i.owner_user_id::text,i.owner_scope_kind,i.status,p.status AS provider_status,
  c.activation_ready,COALESCE((to_jsonb(c)->>'legacy_transport_retired')::boolean,FALSE) AS retired
  FROM shared.memory_source_modes m JOIN public.extension_installations i USING(installation_id)
  JOIN public.extension_providers p ON p.provider_id=i.provider_id CROSS JOIN shared.memory_source_contract c
  WHERE m.installation_id=$1 AND i.provider_id='pocketctl-memory' AND c.singleton${lock?' FOR SHARE OF m,i,p,c NOWAIT':''}`,[input.installationId])).rows[0]
 if(!scope||!scope.activation_ready||scope.retired||scope.mode!=='shared-active'||scope.generation!==input.modeGeneration||scope.config_version!==input.configVersion
  ||scope.owner_user_id!==input.principalUserId||scope.owner_scope_kind!=='personal'||scope.status!=='active'||scope.provider_status!=='enabled')throw Error('inbox_retirement_scope_changed')
}
async function asRuntime<T>(db:Db,role:string,body:()=>Promise<T>):Promise<T>{
 await db.query('SET ROLE '+qi(role))
 let failed=false
 try{return await body()}catch(error){failed=true;throw error}finally{try{await db.query('RESET ROLE')}catch(error){if(!failed)throw error}}
}
/** Target-only duplicate retirement. It proves the delivery-to-original typed
 * relationship; never upgrades unknown provenance or claims Relay equivalence
 * for an original body that remains in place. Bodies never leave this token. */
export async function prepareInboxPayloadRetirement(db:Db,value:InboxRetirementInput){
 assertRetirementIdleConnection(db)
 const input=structuredClone(value)
 if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.installationId)||![input.modeGeneration,input.configVersion,input.principalUserId,input.expectedDatabase?.oid,input.expectedDatabase?.systemIdentifier].every(positive)
  ||!/^[a-z_][a-z0-9_]{0,62}$/.test(input.runtimeRole)||!Array.isArray(input.feedIds)||!input.feedIds.length||input.feedIds.length>128
  ||input.feedIds.some(id=>!positive(id))||new Set(input.feedIds).size!==input.feedIds.length)throw Error('inbox_retirement_input_invalid')
 await assertInboxRetirementScope(db,input)
 const sizes=(await db.query(sizesSql,[input.installationId,input.feedIds])).rows
 if(sizes.length!==input.feedIds.length)throw Error('inbox_retirement_delivery_unhandled')
 if(sizes.some(r=>r.source_hash_bytes!==null&&r.source_hash_bytes!==32))throw Error('inbox_retirement_source_unproven')
 if(sizes.reduce((total,r)=>total+BigInt(r.work_bytes),0n)>BigInt(pageByteLimit))throw Error('inbox_retirement_page_byte_limit')
 const rows=(await db.query(rowsSql,[input.installationId,input.feedIds,versionInput(sizes)])).rows
 if(Buffer.byteLength(JSON.stringify(rows))>pageByteLimit)throw Error('inbox_retirement_page_byte_limit')
 if(rows.length!==input.feedIds.length)throw Error('inbox_retirement_delivery_unhandled')
 const ack=(await db.query('SELECT last_ack_feed_id::text FROM memory.memory_inbox_checkpoints WHERE installation_id=$1',[input.installationId])).rows[0]?.last_ack_feed_id
 let normalizedRows=0
 for(const row of rows){
  if(!ack||BigInt(row.feed_id)>BigInt(ack)||row.projection_state!=='projected'||row.error_code!==null||row.body_reclaimed_at)throw Error('inbox_retirement_delivery_unhandled')
  if(!matchRetainedInboxEnvelope({...row,inbox_body_reclaimed:false},row.data,row.classification))throw Error('inbox_retirement_envelope_unproven')
  if(!row.source_event_id||row.source_reclaimed||!row.identity_equal||!row.classification_equal||digest(row.data)!==row.original_hash)throw Error('inbox_retirement_source_unproven')
  if(row.source_body_present){if(!row.body_equal)throw Error('inbox_retirement_source_unproven');normalizedRows++}
  else if(row.mapping_state!=='verified'||row.bound_kind!=='relay_event'||row.adapter_version!=='original-ref-v1'||row.source_id!=='event:'+row.canonical_key||row.canonical_session_key!==row.session_id)throw Error('inbox_retirement_source_unproven')
 }
 const canonical=rows.filter(r=>!r.source_body_present)
 const prepared=canonical.length?await asRuntime(db,input.runtimeRole,()=>prepareSourceReferences(db as unknown as pg.Pool,input.installationId,canonical.map(r=>r.source_event_id))):undefined
 if(prepared){const events=prepared.events;for(const row of canonical){const e=events.find(e=>e.source_event_id===row.source_event_id);if(!e||digest(e.payload)!==digest(row.data))throw Error('inbox_retirement_current_body_mismatch')}}
 await assertInboxRetirementScope(db,input)
 const proofHash=digest({input,rows:rows.map(r=>({feedId:r.feed_id,sourceId:r.source_event_id,inbox:r.inbox_xmin,source:r.source_xmin,header:header(r),body:r.original_hash})),controlledReaderRows:canonical.length})
 const token=Object.freeze({});pages.set(token,{db,input,rows,prepared,proofHash,normalizedRows})
 return Object.freeze({token,kind:'proved-inbox-duplicate-retirement',rows:rows.length,normalizedRows,controlledReaderRows:canonical.length,proofHash})
}
export async function applyInboxPayloadRetirement(db:Db,page:{token:object;proofHash?:string},options:{signal?:AbortSignal;transactionTimeoutMs?:number}={}){
 assertRetirementIdleConnection(db)
 const p=pages.get(page?.token)
 if(!p||p.db!==db||p.proofHash!==page.proofHash)throw Error('inbox_retirement_token_invalid')
 const timeoutMs=options.transactionTimeoutMs??10000
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('inbox_retirement_window_invalid')
 if(options.signal?.aborted)throw Error('inbox_retirement_aborted')
 let changed=0,expired=false,aborted=false
 const cancel=()=>{aborted=true;void db.end().catch(()=>{})},timer=setTimeout(()=>{expired=true;void db.end().catch(()=>{})},timeoutMs)
 options.signal?.addEventListener('abort',cancel,{once:true})
 try{
  await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await assertInboxRetirementScope(db,p.input,true)
  if(p.prepared)await asRuntime(db,p.input.runtimeRole,()=>p.prepared!.assertCurrent(db,{forCommit:true}))
  // Source SHARE locks prevent retention from removing the only original
  // while the Inbox duplicate is cleared. No archive IO occurs in this TX.
  const ids=p.rows.map(r=>r.source_event_id)
  const sources=(await db.query('SELECT source_event_id::text,xmin::text AS source_xmin FROM memory.source_events WHERE installation_id=$1 AND source_event_id=ANY($2::uuid[]) ORDER BY source_event_id FOR SHARE NOWAIT',[p.input.installationId,ids])).rows
  if(sources.length!==ids.length||p.rows.some(r=>!sources.some(s=>s.source_event_id===r.source_event_id&&s.source_xmin===r.source_xmin)))throw Error('inbox_retirement_changed')
  const fresh=(await db.query(rowsSql+' FOR UPDATE OF i NOWAIT',[p.input.installationId,p.input.feedIds,versionInput(p.rows)])).rows
  if(fresh.length!==p.rows.length||fresh.some(r=>{const old=p.rows.find(x=>x.feed_id===r.feed_id);return !old||r.inbox_xmin!==old.inbox_xmin||header(r)!==header(old)||r.body_reclaimed_at||digest(r.data)!==r.original_hash||!r.identity_equal||!r.classification_equal||r.source_reclaimed||r.source_body_present&&!r.body_equal}))throw Error('inbox_retirement_changed')
  const ack=(await db.query('SELECT last_ack_feed_id::text FROM memory.memory_inbox_checkpoints WHERE installation_id=$1 FOR SHARE NOWAIT',[p.input.installationId])).rows[0]?.last_ack_feed_id
  if(!ack||fresh.some(r=>BigInt(r.feed_id)>BigInt(ack)))throw Error('inbox_retirement_delivery_unhandled')
  const expected=p.rows.map(row=>({feed_id:row.feed_id,row_version:row.inbox_xmin,envelope_hash:row.envelope_hash,data:row.data,classification:row.classification}))
  const expectedJson=JSON.stringify(expected)
  if(Buffer.byteLength(expectedJson)>pageByteLimit)throw Error('inbox_retirement_page_byte_limit')
  const result=await db.query(`WITH expected AS(SELECT * FROM jsonb_to_recordset($2::jsonb)
    AS e(feed_id bigint,row_version text,envelope_hash text,data jsonb,classification jsonb))
   UPDATE memory.memory_feed_inbox i SET data='{}',classification='{}',body_reclaimed_at=clock_timestamp() FROM expected e
   WHERE i.installation_id=$1 AND i.feed_id=e.feed_id AND i.xmin::text=e.row_version AND i.body_reclaimed_at IS NULL
    AND encode(i.payload_hash,'hex')=e.envelope_hash AND i.data=e.data AND i.classification=e.classification`,[p.input.installationId,expectedJson])
  changed=result.rowCount??0;if(changed!==p.rows.length)throw Error('inbox_retirement_changed')
  await assertTargetMemoryWritersFenced(db);await db.query('COMMIT');pages.delete(page.token)
  return {kind:'inbox-duplicate-body-retirement',proofHash:p.proofHash,changed,normalizedRows:p.normalizedRows,controlledReaderRows:p.rows.length-p.normalizedRows,sourceIdsPreserved:true,provenanceRewritten:false,rawBodiesSaved:false}
 }catch(e){await db.query('ROLLBACK').catch(()=>{});if(expired)throw Error('inbox_retirement_window_expired');if(aborted)throw Error('inbox_retirement_aborted');throw e}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel)}
}
