import {createHash} from 'node:crypto'
import type pg from 'pg'
import {assertNativeRetirementUpgradeInput} from './schema.js'
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface NativeLogicalPreparationPlan {
 schemaVersion:1;kind:'native-logical-preparation';database:string;databaseOid:string;clusterIdentityHash:string;eventTableOid:string;shapeHash:string;batchRows:number;planHash:string
}
type PreparationPhase='resume-vacuum-started'|'resume-vacuum-complete'|'update-committed'|'batch-vacuum-started'|'batch-vacuum-complete'
async function standalone(db:pg.Client){
 const row=(await db.query("SELECT r.rolsuper,(a.xact_start=a.query_start) AS standalone FROM pg_roles r JOIN pg_stat_activity a ON a.pid=pg_backend_pid() WHERE r.rolname=current_user")).rows[0]
 if(!row?.rolsuper)throw Error('native_preparation_administrator_required')
 if(!row.standalone)throw Error('native_preparation_standalone_required')
}
async function shape(db:pg.Client){
 await standalone(db)
 if((await db.query("SELECT to_regclass('public.session_aliases') IS NOT NULL OR to_regprocedure('public.native_session_authority(text,integer,text)') IS NOT NULL AS installed")).rows[0].installed)throw Error('native_preparation_existing_authority')
 await assertNativeRetirementUpgradeInput(db)
 const identity=(await db.query("SELECT current_database() AS database,d.oid::text AS database_oid,'public.events'::regclass::oid::text AS event_oid,(SELECT system_identifier::text FROM pg_control_system()) AS cluster_identity FROM pg_database d WHERE datname=current_database()")).rows[0]
 const columns=(await db.query("SELECT attname,atttypid::text,atttypmod,attnotnull,atthasdef,attidentity,attgenerated FROM pg_attribute WHERE attrelid='public.events'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows
 const logical=columns.find(c=>c.attname==='logical_source_session_id')
 if(logical&&(logical.atttypid!=='1043'||logical.atttypmod!==132||logical.attnotnull||logical.atthasdef||logical.attidentity||logical.attgenerated))throw Error('native_preparation_plan_changed')
 if(!columns.some(c=>c.attname==='id'&&c.atttypid==='20')||!columns.some(c=>c.attname==='session_id'&&c.attnotnull))throw Error('native_preparation_plan_changed')
 const indexes=(await db.query("SELECT c.relname,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.events'::regclass ORDER BY c.relname")).rows
 if((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='public.events'::regclass AND NOT tgisinternal AND tgenabled IN('O','A','R') AND(tgtype::int&16)<>0 AND cardinality(tgattr::smallint[])=0 LIMIT 1")).rowCount)throw Error('native_preparation_update_trigger_unreviewed')
 return {identity,clusterIdentityHash:digest(identity.cluster_identity),logicalPresent:!!logical,shapeHash:digest({columns:columns.filter(c=>c.attname!=='logical_source_session_id'),indexes})}
}
async function fenced(db:pg.Client){
 const v=Number((await db.query("SELECT current_setting('server_version_num') AS version")).rows[0].version),membership=v>=160000?'SET':'MEMBER'
 const capable=`EXISTS(SELECT 1 FROM pg_roles capable WHERE(capable.oid=r.oid OR pg_has_role(r.oid,capable.oid,'${membership}')) AND(capable.rolsuper OR has_table_privilege(capable.oid,'public.events','INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(capable.oid,'public.events','INSERT,UPDATE')))`
 if((await db.query(`SELECT 1 FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname<>current_user AND ${capable} LIMIT 1`)).rowCount)throw Error('native_preparation_writers_not_fenced')
 if((await db.query(`SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND a.backend_type='client backend' AND(r.rolsuper OR ${capable}) LIMIT 1`)).rowCount)throw Error('native_preparation_writers_not_fenced')
}
/** Read-only operational plan for the exact pre-native relation. Does not
 * install authority or change a source. Use a dedicated physical admin client. */
export async function planNativeLogicalPreparation(db:pg.Client,options:{batchRows?:number}={}):Promise<NativeLogicalPreparationPlan>{
 const batchRows=options.batchRows??100000
 if(!Number.isSafeInteger(batchRows)||batchRows<1||batchRows>100000)throw Error('native_preparation_batch_size_invalid')
 const s=await shape(db),plan={schemaVersion:1 as const,kind:'native-logical-preparation' as const,database:s.identity.database,databaseOid:s.identity.database_oid,clusterIdentityHash:s.clusterIdentityHash,eventTableOid:s.identity.event_oid,shapeHash:s.shapeHash,batchRows}
 return {...plan,planHash:digest(plan)}
}
/** Explicit offline forward preparation. Never called by application startup.
 * Each bounded UPDATE commits before VACUUM, so dead pages/index entries can
 * be reused by later batches instead of duplicating the entire event heap.
 * An interruption leaves the original immutable IDs already prepared. Resume
 * accepts that nullable column only; it never guesses through a contradiction.
 * The ordinary native migrator still installs its NOT NULL/authority/triggers.
 */
export async function prepareNativeLogicalSessions(db:pg.Client,plan:NativeLogicalPreparationPlan,options:{maxBatches?:number;signal?:AbortSignal;afterStage?:(progress:{phase:PreparationPhase;updatedRows:string;batches:number})=>void|Promise<void>;afterBatch?:(progress:{updatedRows:string;batches:number;tableBytes:string;indexBytes:string;walLsn:string})=>void|Promise<void>}={}){
 const {planHash,...input}=plan??{}
 if(plan?.schemaVersion!==1||plan.kind!=='native-logical-preparation'||digest(input)!==planHash||!Number.isSafeInteger(plan.batchRows)||plan.batchRows<1||plan.batchRows>100000)throw Error('native_preparation_plan_changed')
 const maxBatches=options.maxBatches??1024
 if(!Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>4096)throw Error('native_preparation_batch_limit_invalid')
 const abort=()=>{if(options.signal?.aborted)throw Error('native_preparation_aborted')}
 await standalone(db);abort()
 let locked=false,settings:{statement:string;lock:string}|undefined,updated=0n,batches=0
 try{
  locked=(await db.query("SELECT pg_try_advisory_lock(hashtextextended('native-logical-session-preparation',0)) AS locked")).rows[0].locked
  if(!locked)throw Error('native_preparation_busy')
  const old=(await db.query("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")).rows[0];settings=old
  await db.query("SELECT set_config('statement_timeout','60000',false),set_config('lock_timeout','1000',false)")
  const check=async()=>{abort();await fenced(db);const s=await shape(db);if(s.identity.database!==plan.database||s.identity.database_oid!==plan.databaseOid||s.clusterIdentityHash!==plan.clusterIdentityHash||s.identity.event_oid!==plan.eventTableOid||s.shapeHash!==plan.shapeHash)throw Error('native_preparation_plan_changed');return s}
  const initial=await check()
  if(initial.logicalPresent&&(await db.query('SELECT 1 FROM public.events WHERE logical_source_session_id IS NOT NULL AND logical_source_session_id IS DISTINCT FROM session_id LIMIT 1')).rowCount)throw Error('native_preparation_identity_conflict')
  if(!initial.logicalPresent)await db.query('ALTER TABLE public.events ADD COLUMN logical_source_session_id VARCHAR(128)')
  const stage=async(phase:PreparationPhase)=>options.afterStage?.({phase,updatedRows:updated.toString(),batches})
  const vacuum=async(resume:boolean)=>{
   abort();await stage(resume?'resume-vacuum-started':'batch-vacuum-started')
   // A committed UPDATE can survive a vacuum timeout or process exit. Reuse
   // those dead pages before adding another batch on resume. Ordinary VACUUM
   // has a separate finite I/O budget; UPDATE retains its 60-second bound.
   await db.query("SELECT set_config('statement_timeout','300000',false),set_config('lock_timeout','60000',false)")
   try{await db.query('VACUUM (ANALYZE FALSE) public.events')}
   finally{await db.query("SELECT set_config('statement_timeout','60000',false),set_config('lock_timeout','1000',false)")}
   await stage(resume?'resume-vacuum-complete':'batch-vacuum-complete')
  }
  if(initial.logicalPresent)await vacuum(true)
  let cursor:string|null=null
  for(let n=0;n<maxBatches;n++){
   await check()
   const result:{rows:string;last_id:string|null}=(await db.query(`WITH changed AS(UPDATE public.events e SET logical_source_session_id=e.session_id WHERE e.id IN(
    SELECT id FROM public.events WHERE logical_source_session_id IS NULL AND($1::bigint IS NULL OR id>$1::bigint) ORDER BY id LIMIT $2) RETURNING e.id)
    SELECT count(*)::text AS rows,max(id)::text AS last_id FROM changed`,[cursor,plan.batchRows])).rows[0]
   if(result.rows==='0')break
   updated+=BigInt(result.rows);cursor=result.last_id;batches++
   await stage('update-committed')
   // Standalone VACUUM retains the same authority and original contents. It
   // does not use FULL/rewrite, remove live rows, or create recovery material.
   await vacuum(false)
   const size=(await db.query("SELECT pg_table_size('public.events')::text AS table_bytes,pg_indexes_size('public.events')::text AS index_bytes,pg_current_wal_insert_lsn()::text AS wal_lsn")).rows[0]
   await options.afterBatch?.({updatedRows:updated.toString(),batches,tableBytes:size.table_bytes,indexBytes:size.index_bytes,walLsn:size.wal_lsn})
  }
  await check()
  if((await db.query('SELECT 1 FROM public.events WHERE logical_source_session_id IS NULL LIMIT 1')).rowCount)throw Error('native_preparation_batch_limit')
  if((await db.query('SELECT 1 FROM public.events WHERE logical_source_session_id IS DISTINCT FROM session_id LIMIT 1')).rowCount)throw Error('native_preparation_identity_conflict')
  return {kind:'native-logical-preparation-complete',planHash,updatedRows:updated.toString(),batches,remainingRows:'0',readyForNativeMigration:true,nativeAuthorityInstalled:false,backupCreated:false,sourceBodiesChanged:false}
 }finally{
  try{if(settings)await db.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",[settings.statement,settings.lock])}
  finally{if(locked)await db.query("SELECT pg_advisory_unlock(hashtextextended('native-logical-session-preparation',0))")}
 }
}
