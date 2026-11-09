import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import pg from 'pg'
import {createHash} from 'node:crypto'
import {canonicalJsonString} from '@pocketctl/session-source'
import {TABLE_POLICY} from '../shared-source/table-policy.js'
import {assertFrozenMemorySource} from '../shared-source/maintenance.js'
import {quoteIdentifier as qi} from '../shared-db/schema-context.js'
import {beginForwardCapacityRun,type ForwardCapacityEvidence} from './capacity-admission.js'
type Expected={database:string;role:string;serverAddress:string;serverPort:string}
export interface ForwardConfig {
 source:{url:string;expected:Expected};target:{url:string;expected:Expected}
 migrationId:string;codeSha:string;maxRowBytes:number;walCheckpointBytes?:number
}
interface Column {name:string;type:string;supportedType:boolean;generated:string;generatedExpression:string|null;defaultExpressionHash:string|null;identity:string;notNull:boolean;hasDefault:boolean}
interface Shape {name:string;columns:Column[];primaryKey:string[];constraints:unknown[]}
interface Digest {rows:string;bytes:string;hash:string}
interface TablePlan {name:string;source:Shape;target:Shape;sourceDigest:Digest;targetDigest:Digest;action:'copy'|'preserve-registry'}
interface Sequence {table:string;column:string;lastValue:string;isCalled:boolean;settingsHash:string}
export interface ForwardManifest {
 schemaVersion:2;kind:'memory-forward-migration';migrationId:string;codeSha:string;sourceIdentity:string;targetIdentity:string
 sourceSchemaHash:string;targetSchemaHash:string;maxRowBytes:number;walCheckpointBytes?:number;tables:TablePlan[];sequences:Sequence[];targetSequences:Sequence[];manifestHash:string
 initialTargetSchemaHash:string;targetPreparation:{kind:'drop-obsolete-governance-index';name:'knowledge_claims_active_identity_variant_idx'}[]
 backupRequired:false;rollbackSupported:false
}
const hash=(value:unknown)=>createHash('sha256').update(canonicalJsonString(value)).digest('hex')
const qualified=(schema:string,table:string)=>qi(schema)+'.'+qi(table)
const metadataTableVersions:Readonly<Record<string,number>>={memory_canonical_projection_progress:92,memory_team_semantic_groups:94,memory_team_semantic_witnesses:94,memory_team_semantic_publications:96,memory_native_control_observations:97,memory_source_delivery_receipts:Infinity,memory_source_snapshot_receipts:Infinity}
/** Reviewed additive schema roster. Older sources do not acquire tables merely
 * because the destination supports preparatory semantic metadata. */
export function memoryForwardTableRoster(version:number):string[]{
 if(!Number.isInteger(version)||version<84||version>96)throw Error('unreviewed_memory_schema_version')
 return Object.keys(TABLE_POLICY).filter(name=>version>=(metadataTableVersions[name]??84)).sort()
}
const seedTables=new Set(['memory_retention_control','memory_delivery_withdrawal_checkpoint'])
const activeClients=new Set<pg.Client>(),closing=new WeakMap<pg.Client,Promise<void>>()
function close(client:pg.Client){
 const pending=closing.get(client);if(pending)return pending
 const promise=client.end().finally(()=>activeClients.delete(client));closing.set(client,promise);return promise
}
/** CLI cancellation closes both dedicated sockets. PostgreSQL rolls back the
 * unfinished table; already committed table checkpoints remain resumable. */
export async function cancelForwardMigrations(){await Promise.allSettled([...activeClients].map(close))}
const manifestHash=(m:ForwardManifest)=>{const {manifestHash:_,...rest}=m;return hash(rest)}
async function connect(config:ForwardConfig['source'],readOnly:boolean){
 const client=new pg.Client({connectionString:config.url,application_name:'pocketctl-memory-forward-migration',connectionTimeoutMillis:5000,
  options:`-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c timezone=UTC -c datestyle=ISO,YMD -c bytea_output=hex -c extra_float_digits=3 -c row_security=off -c default_transaction_read_only=${readOnly?'on':'off'}`})
 try{
  activeClients.add(client)
  await client.connect()
  const actual=(await client.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",d.oid::text AS oid FROM pg_database d WHERE datname=current_database()`)).rows[0]
  for(const key of ['database','role','serverAddress','serverPort'] as const)if(!config.expected[key]||actual[key]!==config.expected[key])throw Error('database_identity_mismatch')
  return {client,identity:hash(actual)}
 }catch(e){await close(client).catch(()=>{});throw e}
}
async function drained(source:pg.Client){
 await assertFrozenMemorySource(source)
}
async function targetClosed(target:pg.Client){
 const row=(await target.query('SELECT version,activation_ready FROM shared.memory_source_contract WHERE singleton')).rows[0]
 if(!row||row.version!==1||row.activation_ready)throw Error('target_source_activation_open')
 if((await target.query("SELECT 1 FROM shared.memory_source_modes WHERE mode NOT IN('legacy-feed','paused') LIMIT 1")).rowCount)throw Error('target_source_mode_open')
 if((await target.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND application_name='pocketctl-memory' LIMIT 1")).rowCount)throw Error('target_memory_not_drained')
 await assertTargetMemoryWritersFenced(target)
}
async function catalog(client:pg.Client,schema:string):Promise<Shape[]>{
 const tables=(await client.query(`SELECT c.relname AS name,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,[schema])).rows
 const version=(await client.query(`SELECT max(version)::int AS schema_version FROM ${qualified(schema,'memory_schema_migrations')}`)).rows[0].schema_version
 const roster=memoryForwardTableRoster(version)
 if(!same(tables.map(t=>t.name),roster))throw Error('unreviewed_memory_table_roster')
 const shapes:Shape[]=[]
 for(const t of tables){
  const columns=(await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,tn.nspname='pg_catalog' AS "supportedType",a.attgenerated AS generated,
   CASE WHEN a.attgenerated<>'' THEN pg_get_expr(d.adbin,d.adrelid) END AS "generatedExpression",encode(sha256(convert_to(pg_get_expr(d.adbin,d.adrelid),'UTF8')),'hex') AS "defaultExpressionHash",a.attidentity AS identity,a.attnotnull AS "notNull",a.atthasdef AS "hasDefault"
   FROM pg_attribute a JOIN pg_type typ ON typ.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=typ.typnamespace
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[t.oid])).rows as Column[]
  const primaryKey=(await client.query(`SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,pos) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1::oid AND i.indisprimary ORDER BY k.pos`,[t.oid])).rows.map(r=>r.attname)
  const constraints=(await client.query(`SELECT conname,contype,encode(sha256(convert_to(pg_get_constraintdef(oid),'UTF8')),'hex') AS "definitionHash" FROM pg_constraint WHERE conrelid=$1::oid ORDER BY conname`,[t.oid])).rows
  const generated=new Set(["to_tsvector('simple'::regconfig, document)",'COALESCE(claim_id, wiki_id, skill_id)','COALESCE(claim_version_id, wiki_version_id, skill_version_id)'])
  if(!primaryKey.length||columns.some(c=>!c.supportedType||c.generated&&!generated.has(c.generatedExpression!)))throw Error('unsupported_memory_table_shape')
  shapes.push({name:t.name,columns,primaryKey,constraints})
 }
 return shapes
}
/** New metadata tables have no old source counterpart. They must remain
 * empty throughout a legacy transfer; newer target work is never discarded. */
async function targetOnlyEmpty(target:pg.Client,source:Shape[],shapes:Shape[]){
 for(const table of shapes.filter(t=>!source.some(s=>s.name===t.name))){
  if(!Object.hasOwn(metadataTableVersions,table.name))throw Error('unreviewed_target_only_table')
  if((await target.query('SELECT 1 FROM '+qualified('memory',table.name)+' LIMIT 1')).rowCount)throw Error('target_not_pristine')
 }
}
const obsoleteIndex='knowledge_claims_active_identity_variant_idx'
async function governanceIndex(client:pg.Client,schema:string){
 const rows=(await client.query(`SELECT pg_get_indexdef(i.indexrelid) AS definition,i.indisunique,i.indisvalid,i.indisready,c.relname AS parent
  FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace n ON n.oid=idx.relnamespace JOIN pg_class c ON c.oid=i.indrelid
  WHERE n.nspname=$1 AND idx.relname=$2`,[schema,obsoleteIndex])).rows
 if(!rows.length)return false
 const row=rows[0],expected=`CREATE UNIQUE INDEX ${obsoleteIndex} ON ${schema}.knowledge_claims USING btree (installation_id, claim_type, scope_key, normalized_key, conflict_variant) WHERE (state = 'active'::text)`
 if(rows.length!==1||row.parent!=='knowledge_claims'||!row.indisunique||!row.indisvalid||!row.indisready||row.definition!==expected)throw Error('unreviewed_governance_index_definition')
 return true
}
async function schemaHash(client:pg.Client,schema:string,shapes:Shape[],omitObsoleteIndex=false){
 const functions=(await client.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,md5(pg_get_functiondef(p.oid)) AS definition,p.proowner::text,p.proacl::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN('f','p') ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,[schema])).rows
 const relations=(await client.query(`SELECT c.relname,c.relkind,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,
  CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END AS index_definition
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname`,[schema])).rows
 const triggers=(await client.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,[schema])).rows
 return hash({shapes,functions,relations:omitObsoleteIndex?relations.filter(r=>r.relname!==obsoleteIndex):relations,triggers})
}
/** Keep PostgreSQL JSON as an opaque string. JSON.parse would round native
 * bigint values embedded in row/JSON payloads before the target sees them. */
async function rows(client:pg.Client,schema:string,shape:Shape,maxBytes:number,consume?:(text:string)=>Promise<void>):Promise<Digest>{
 const columns=shape.columns.map(c=>qi(c.name)).join(','),order=shape.primaryKey.map(qi).join(',')
 const digest=createHash('sha256');let count=0n,bytes=0n
 // Keep each cursor page <=128 small cells (32KiB each) plus bounded PKs.
 // Larger rows return only their opaque original PK, then are fetched singly
 // in this same snapshot/locked table. JSON numeric values never enter JS.
 const inlineBytes=Math.min(maxBytes,32768),keyColumns=shape.primaryKey.map(c=>'r.'+qi(c)).join(',')
 await client.query(`DECLARE forward_rows NO SCROLL CURSOR FOR SELECT
  CASE WHEN octet_length(encoded.json)<=${inlineBytes} THEN encoded.json END AS json,
  CASE WHEN octet_length(encoded.json)>${inlineBytes} AND octet_length(encoded.json)<=${maxBytes}
    AND octet_length(encoded.key)<=4096 THEN encoded.key END AS key,
  octet_length(encoded.json) AS bytes
  FROM(SELECT ${columns} FROM ${qualified(schema,shape.name)} ORDER BY ${order}) r
  CROSS JOIN LATERAL(SELECT row_to_json(r)::text AS json,(SELECT row_to_json(k)::text FROM(SELECT ${keyColumns}) k) AS key OFFSET 0) encoded`)
 try{
  for(;;){
   const page=await client.query('FETCH FORWARD 128 FROM forward_rows')
   if(!page.rowCount)break
   for(const row of page.rows){
    if(row.bytes>maxBytes)throw Error('migration_row_byte_limit')
    let text=row.json as string|null
    if(text===null){
     if(typeof row.key!=='string'||Buffer.byteLength(row.key)>4096)throw Error('migration_primary_key_byte_limit')
     const selected=shape.columns.map(c=>'s.'+qi(c.name)).join(','),equal=shape.primaryKey.map(c=>'s.'+qi(c)+'=k.'+qi(c)).join(' AND ')
     const large=await client.query(`SELECT CASE WHEN octet_length(row_to_json(r)::text)<=${maxBytes} THEN row_to_json(r)::text END AS json
      FROM(SELECT ${selected} FROM ${qualified(schema,shape.name)} s CROSS JOIN json_populate_record(NULL::${qualified(schema,shape.name)},$1::json) k WHERE ${equal}) r`,[row.key])
     if(large.rowCount!==1||large.rows[0].json===null)throw Error('migration_row_byte_limit')
     text=large.rows[0].json
    }
    if(typeof text!=='string')throw Error('migration_row_byte_limit')
    const n=Buffer.byteLength(text)
    if(n>maxBytes)throw Error('migration_row_byte_limit')
    digest.update(String(n)+':').update(text);count++;bytes+=BigInt(n)
    if(consume)await consume(text)
   }
  }
 }finally{await client.query('CLOSE forward_rows')}
 return {rows:count.toString(),bytes:bytes.toString(),hash:digest.digest('hex')}
}
const same=(a:unknown,b:unknown)=>canonicalJsonString(a)===canonicalJsonString(b)
async function sequences(source:pg.Client,shapes:Shape[],schema='public'):Promise<Sequence[]>{
 const result:Sequence[]=[]
 for(const shape of shapes)for(const column of shape.columns){
  const name=(await source.query('SELECT pg_get_serial_sequence($1,$2) AS name',[qualified(schema,shape.name),column.name])).rows[0].name
  if(!name)continue
  const sequence=(await source.query('SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM '+name)).rows[0]
  const settings=(await source.query('SELECT seqstart::text,seqincrement::text,seqmin::text,seqmax::text,seqcache::text,seqcycle FROM pg_sequence WHERE seqrelid=$1::regclass',[name])).rows[0]
  result.push({table:shape.name,column:column.name,...sequence,settingsHash:hash(settings)})
 }
 return result
}
function validateConfig(config:ForwardConfig){
 if(config.walCheckpointBytes!==undefined&&(!Number.isSafeInteger(config.walCheckpointBytes)||config.walCheckpointBytes<65536||config.walCheckpointBytes>128*1024*1024))throw Error('invalid_forward_wal_checkpoint_limit')
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.migrationId)||! /^[a-f0-9]{40}$/.test(config.codeSha)||!Number.isSafeInteger(config.maxRowBytes)||config.maxRowBytes<1||config.maxRowBytes>32*1024*1024)throw Error('invalid_forward_config')
}
export async function planForwardMigration(config:ForwardConfig):Promise<ForwardManifest>{
 validateConfig(config)
 const source=await connect(config.source,true);let target:Awaited<ReturnType<typeof connect>>|undefined
 try{
  await drained(source.client);target=await connect(config.target,true)
  if(source.identity===target.identity||config.source.expected.database===config.target.expected.database&&config.source.expected.serverAddress===config.target.expected.serverAddress&&config.source.expected.serverPort===config.target.expected.serverPort)throw Error('distinct_databases_required')
  await targetClosed(target.client)
  await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await target.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const sourceShapes=await catalog(source.client,'public'),targetShapes=await catalog(target.client,'memory'),tables:TablePlan[]=[]
  await targetOnlyEmpty(target.client,sourceShapes,targetShapes)
  const sourceLegacyIndex=await governanceIndex(source.client,'public'),targetLegacyIndex=await governanceIndex(target.client,'memory')
  if(sourceLegacyIndex&&!targetLegacyIndex)throw Error('source_target_governance_index_mismatch')
  const targetPreparation:ForwardManifest['targetPreparation']=!sourceLegacyIndex&&targetLegacyIndex?[{kind:'drop-obsolete-governance-index',name:obsoleteIndex}]:[]
  for(const s of sourceShapes){
   const t=targetShapes.find(t=>t.name===s.name)!
   for(const column of s.columns)if(!t.columns.some(c=>c.name===column.name&&c.type===column.type&&c.generatedExpression===column.generatedExpression))throw Error('source_target_column_mismatch')
   if(t.columns.some(c=>!s.columns.some(old=>old.name===c.name)&&c.notNull&&!c.hasDefault))throw Error('new_column_requires_transform')
   const sourceDigest=await rows(source.client,'public',s,config.maxRowBytes),targetDigest=await rows(target.client,'memory',s,config.maxRowBytes)
   const action=s.name==='memory_schema_migrations'?'preserve-registry':'copy'
   if(action==='copy'&&targetDigest.rows!=='0'&&(!seedTables.has(s.name)||targetDigest.rows!=='1'))throw Error('target_not_pristine')
   tables.push({name:s.name,source:s,target:t,sourceDigest,targetDigest,action})
  }
  const manifest:ForwardManifest={schemaVersion:2,kind:'memory-forward-migration',migrationId:config.migrationId,codeSha:config.codeSha,sourceIdentity:source.identity,targetIdentity:target.identity,
   sourceSchemaHash:await schemaHash(source.client,'public',sourceShapes),initialTargetSchemaHash:await schemaHash(target.client,'memory',targetShapes),targetSchemaHash:await schemaHash(target.client,'memory',targetShapes,targetPreparation.length>0),targetPreparation,maxRowBytes:config.maxRowBytes,...(config.walCheckpointBytes===undefined?{}:{walCheckpointBytes:config.walCheckpointBytes}),tables,sequences:await sequences(source.client,sourceShapes),targetSequences:await sequences(target.client,targetShapes,'memory'),manifestHash:'',backupRequired:false,rollbackSupported:false}
  for(const sequence of manifest.sequences)if(!manifest.targetSequences.some(s=>s.table===sequence.table&&s.column===sequence.column&&s.settingsHash===sequence.settingsHash))throw Error('sequence_settings_require_transform')
  manifest.manifestHash=manifestHash(manifest);return manifest
 }finally{await close(source.client);if(target)await close(target.client)}
}
function validateManifest(config:ForwardConfig,plan:ForwardManifest){
 validateConfig(config)
 if(plan.walCheckpointBytes!==config.walCheckpointBytes)throw Error('forward_manifest_mismatch')
 if(plan.schemaVersion!==2||plan.kind!=='memory-forward-migration'||plan.migrationId!==config.migrationId||plan.codeSha!==config.codeSha||plan.maxRowBytes!==config.maxRowBytes||plan.backupRequired!==false||plan.rollbackSupported!==false||manifestHash(plan)!==plan.manifestHash)throw Error('forward_manifest_mismatch')
 const names=plan.tables.map(t=>t.name).sort(),roster=memoryForwardTableRoster(names.includes('memory_team_semantic_publications')?96:names.includes('memory_team_semantic_groups')?94:names.includes('memory_canonical_projection_progress')?92:84)
 if(!same(names,roster))throw Error('forward_manifest_scope_mismatch')
 if(!Array.isArray(plan.targetPreparation)||plan.targetPreparation.length>1||plan.targetPreparation.some(p=>p.kind!=='drop-obsolete-governance-index'||p.name!==obsoleteIndex)||! /^[a-f0-9]{64}$/.test(plan.initialTargetSchemaHash))throw Error('forward_target_preparation_mismatch')
}
async function foreignKeys(target:pg.Client){
 const keys=(await target.query(`SELECT child.relname AS child,parent.relname AS parent,pn.nspname AS parent_schema,c.conkey,c.confkey,c.conrelid::text,c.confrelid::text,c.confmatchtype
  FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace n ON n.oid=child.relnamespace JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace WHERE n.nspname='memory' AND c.contype='f' ORDER BY child.relname,c.conname`)).rows
 for(const key of keys){
  if(key.parent_schema!=='memory')throw Error('unreviewed_cross_namespace_fk')
  const names=async(oid:string,nums:number[])=>(await target.query('SELECT attnum,attname FROM pg_attribute WHERE attrelid=$1::oid AND attnum=ANY($2::smallint[])',[oid,nums])).rows
  const child=await names(key.conrelid,key.conkey),parent=await names(key.confrelid,key.confkey)
  const cc=key.conkey.map((n:number)=>'c.'+qi(child.find(a=>a.attnum===n)!.attname)),pc=key.confkey.map((n:number)=>'p.'+qi(parent.find(a=>a.attnum===n)!.attname))
  const nonnull=cc.map((c:string)=>c+' IS NOT NULL').join(' AND '),equal=cc.map((c:string,i:number)=>c+'='+pc[i]).join(' AND ')
  const mixed=key.confmatchtype==='f'?' OR (('+cc.map((c:string)=>c+' IS NULL').join(' OR ')+') AND ('+cc.map((c:string)=>c+' IS NOT NULL').join(' OR ')+'))':''
  if((await target.query(`SELECT 1 FROM ${qualified('memory',key.child)} c WHERE ((${nonnull}) AND NOT EXISTS(SELECT 1 FROM ${qualified('memory',key.parent)} p WHERE ${equal}))${mixed} LIMIT 1`)).rowCount)throw Error('target_foreign_key_mismatch')
 }
}
async function openRun(config:ForwardConfig,plan:ForwardManifest,write:boolean,beforeWrite:()=>void=()=>{}){
 validateManifest(config,plan)
 const source=await connect(config.source,true);let target:Awaited<ReturnType<typeof connect>>|undefined
 try{
  await drained(source.client);target=await connect(config.target,!write)
  if(source.identity!==plan.sourceIdentity||target.identity!==plan.targetIdentity)throw Error('forward_database_identity_changed')
  if(write)await target.client.query("SELECT pg_advisory_lock(hashtextextended('memory-forward-migration',0))")
  await targetClosed(target.client);await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const sourceShapes=await catalog(source.client,'public')
  if(!same(sourceShapes.map(t=>t.name).sort(),plan.tables.map(t=>t.name).sort()))throw Error('forward_manifest_scope_mismatch')
  if(await schemaHash(source.client,'public',sourceShapes)!==plan.sourceSchemaHash)throw Error('forward_schema_changed')
  if(!same(await sequences(source.client,plan.tables.map(t=>t.source)),plan.sequences))throw Error('source_sequence_changed')
  const targetShapes=await catalog(target.client,'memory'),currentTargetHash=await schemaHash(target.client,'memory',targetShapes)
  await targetOnlyEmpty(target.client,sourceShapes,targetShapes)
  if(currentTargetHash!==plan.targetSchemaHash){
   if(currentTargetHash!==plan.initialTargetSchemaHash||plan.targetPreparation.length!==1)throw Error('forward_schema_changed')
   if(!write)throw Error('target_preparation_required')
   // This one reviewed physical difference reflects an already-cut-over source;
   // no source governance control/generation is changed or inferred here.
   beforeWrite()
   await target.client.query('BEGIN')
   try{
    await targetClosed(target.client)
    await target.client.query('LOCK TABLE memory.knowledge_claims IN ACCESS EXCLUSIVE MODE NOWAIT')
    if(await governanceIndex(source.client,'public')||!await governanceIndex(target.client,'memory'))throw Error('forward_target_preparation_mismatch')
    if(await schemaHash(target.client,'memory',targetShapes)!==plan.initialTargetSchemaHash)throw Error('forward_schema_changed')
    for(const table of plan.tables){
     beforeWrite()
     if(!same(await rows(source.client,'public',table.source,config.maxRowBytes),table.sourceDigest))throw Error('source_table_changed')
     if(!same(await rows(target.client,'memory',table.target,config.maxRowBytes),table.targetDigest))throw Error('target_table_changed')
    }
    beforeWrite()
    await target.client.query('DROP INDEX memory.'+qi(obsoleteIndex))
    if(await schemaHash(target.client,'memory',targetShapes)!==plan.targetSchemaHash)throw Error('forward_schema_changed')
    beforeWrite()
    await target.client.query('COMMIT')
   }catch(error){await target.client.query('ROLLBACK');throw error}
  }
  return {source:source.client,target:target.client}
 }catch(e){await close(source.client);if(target)await close(target.client);throw e}
}
export async function applyForwardMigration(config:ForwardConfig,plan:ForwardManifest,options:{capacity?:ForwardCapacityEvidence;afterTable?:(name:string)=>void|Promise<void>}={}){
 validateManifest(config,plan)
 const capacityRun=beginForwardCapacityRun(options.capacity,plan)
 const admit=()=>capacityRun.check()
 const {source,target}=await openRun(config,plan,true,admit),stage='memory_stage_'+config.migrationId.replaceAll('-','')
 const wal={checkpoints:0,largestIntervalBytes:'0',peakPhysicalBytes:'0',initialPhysicalBytes:'0',generatedBytes:'0'}
 let checkpointLsn:string|undefined,startLsn:string|undefined
 const walBoundary=async(local=false,force=false)=>{
  if(config.walCheckpointBytes===undefined)return
  const observed=(await target.query(`SELECT pg_current_wal_insert_lsn()::text AS lsn,COALESCE(pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn),0)::text AS interval,
    (SELECT sum(size)::text FROM pg_ls_waldir()) AS physical`,[checkpointLsn??null])).rows[0]
  startLsn??=observed.lsn;checkpointLsn??=observed.lsn
  if(wal.initialPhysicalBytes==='0')wal.initialPhysicalBytes=observed.physical
  capacityRun.checkWal(wal.initialPhysicalBytes,observed.physical)
  if(BigInt(observed.physical)>BigInt(wal.peakPhysicalBytes))wal.peakPhysicalBytes=observed.physical
  if(BigInt(observed.interval)>BigInt(wal.largestIntervalBytes))wal.largestIntervalBytes=observed.interval
  if(!force&&BigInt(observed.interval)<BigInt(config.walCheckpointBytes))return
  admit()
  await target.query(`SET ${local?'LOCAL ':''}statement_timeout='60s'`)
  // CHECKPOINT also works inside the uncommitted table transaction. It does
  // not commit that table, authorize activation, or unlink physical WAL.
  try{await target.query('CHECKPOINT')}finally{await target.query(`SET ${local?'LOCAL ':''}statement_timeout='5s'`).catch(()=>{})}
  checkpointLsn=(await target.query('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0].lsn;wal.checkpoints++
 }
 try{
  await walBoundary(false,true)
  // A session lock serializes first run/resume without holding a transaction
  // across source IO. Only this dedicated migrator connection writes staging.
  admit()
  await target.query(`CREATE TABLE IF NOT EXISTS shared.memory_forward_runs(migration_id UUID PRIMARY KEY,manifest_hash TEXT NOT NULL,manifest JSONB NOT NULL,verified_at TIMESTAMPTZ);
   CREATE TABLE IF NOT EXISTS shared.memory_forward_tables(migration_id UUID NOT NULL REFERENCES shared.memory_forward_runs(migration_id),table_name TEXT NOT NULL,row_count TEXT NOT NULL,row_hash TEXT NOT NULL,PRIMARY KEY(migration_id,table_name));
   REVOKE ALL ON shared.memory_forward_runs,shared.memory_forward_tables FROM PUBLIC`)
  admit()
  await target.query('INSERT INTO shared.memory_forward_runs(migration_id,manifest_hash,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[config.migrationId,plan.manifestHash,JSON.stringify(plan)])
  if((await target.query('SELECT manifest_hash FROM shared.memory_forward_runs WHERE migration_id=$1',[config.migrationId])).rows[0].manifest_hash!==plan.manifestHash)throw Error('forward_manifest_mismatch')
  admit()
  await target.query(`CREATE SCHEMA IF NOT EXISTS ${qi(stage)};REVOKE ALL ON SCHEMA ${qi(stage)} FROM PUBLIC`)
  for(const table of plan.tables){
   admit()
   if(!same(await rows(source,'public',table.source,config.maxRowBytes),table.sourceDigest))throw Error('source_table_changed')
   admit()
   await target.query('BEGIN')
   try{
    await targetClosed(target)
    await target.query('LOCK TABLE '+qualified('memory',table.name)+' IN SHARE ROW EXCLUSIVE MODE')
    const current=await rows(target,'memory',table.target,config.maxRowBytes)
    const checkpoint=(await target.query('SELECT row_count,row_hash FROM shared.memory_forward_tables WHERE migration_id=$1 AND table_name=$2',[config.migrationId,table.name])).rows[0]
    const complete=Boolean(checkpoint)
    if(complete?(current.rows!==checkpoint.row_count||current.hash!==checkpoint.row_hash):!same(current,table.targetDigest))throw Error('target_table_changed')
    if(!complete){
     if(table.action==='copy'){
      admit()
      const cols=table.source.columns.filter(c=>!c.generated).map(c=>qi(c.name)).join(','),override=table.source.columns.some(c=>c.identity==='a')?'OVERRIDING SYSTEM VALUE':''
      // The target is closed, locked and still in this table transaction.
      // Stream directly into it instead of materializing a second indexed
      // copy. Any row/digest/COMMIT failure rolls back both data and receipt.
      // Generated columns, defaults and uniqueness still use the real target.
      await target.query("SET LOCAL session_replication_role='replica'")
      await target.query('DELETE FROM '+qualified('memory',table.name))
      let batch:string[]=[],batchBytes=2
      const flush=async()=>{
       if(!batch.length)return
       admit()
       // PostgreSQL emits each original JSON row. Concatenate those opaque
       // strings without parsing numbers through JavaScript. The row limit
       // still applies; a batch holds at most 128 rows / 8 MiB, or one row
       // up to maxRowBytes. Defaults/generated values use the real target.
       await target.query(`INSERT INTO ${qualified('memory',table.name)}(${cols}) ${override} SELECT ${cols} FROM json_populate_recordset(NULL::${qualified('memory',table.name)},$1::json)`,['['+batch.join(',')+']'])
       await walBoundary(true)
       batch=[];batchBytes=2
      }
      const actual=await rows(source,'public',table.source,config.maxRowBytes,async text=>{
       admit()
       const bytes=Buffer.byteLength(text)+1
       if(batch.length&&(batch.length>=128||batchBytes+bytes>8*1024*1024))await flush()
       batch.push(text);batchBytes+=bytes
       if(batchBytes>=8*1024*1024)await flush()
      })
      await flush()
      if(!same(actual,table.sourceDigest))throw Error('source_table_changed')
      if(!same(await rows(target,'memory',table.source,config.maxRowBytes),table.sourceDigest))throw Error('target_table_changed')
     }
     // Attest every target column, including newly initialized columns absent
     // from the legacy schema. Source-projection fidelity is checked above.
     const fullTarget=await rows(target,'memory',table.target,config.maxRowBytes)
     admit()
     await target.query('INSERT INTO shared.memory_forward_tables(migration_id,table_name,row_count,row_hash) VALUES($1,$2,$3,$4)',[config.migrationId,table.name,fullTarget.rows,fullTarget.hash])
    }
    admit()
    await target.query('COMMIT')
   }catch(e){await target.query('ROLLBACK');throw e}
   await walBoundary()
   await options.afterTable?.(table.name)
  }
  await foreignKeys(target)
  const targetSequences=await sequences(target,plan.tables.map(t=>t.target),'memory')
  for(const seq of plan.sequences){
   const name=(await target.query('SELECT pg_get_serial_sequence($1,$2) AS name',[qualified('memory',seq.table),seq.column])).rows[0].name
   if(!name)throw Error('target_sequence_missing')
   const actual=targetSequences.find(s=>s.table===seq.table&&s.column===seq.column)
   const initial=plan.targetSequences.find(s=>s.table===seq.table&&s.column===seq.column)
   if(!initial||!same(actual,initial)&&!same(actual,seq))throw Error('target_sequence_changed')
   admit()
   await target.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)',[name,seq.lastValue,seq.isCalled])
  }
  admit()
  await target.query('DROP SCHEMA '+qi(stage))
  await walBoundary(false,true)
  if(startLsn)wal.generatedBytes=(await target.query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text AS bytes',[startLsn])).rows[0].bytes
  return {walCheckpointBytes:config.walCheckpointBytes??null,wal:config.walCheckpointBytes===undefined?null:wal}
 }finally{await close(source);await close(target)}
}
export async function verifyForwardMigration(config:ForwardConfig,plan:ForwardManifest){
 const {source,target}=await openRun(config,plan,false)
 try{
  await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  if((await target.query('SELECT manifest_hash FROM shared.memory_forward_runs WHERE migration_id=$1',[config.migrationId])).rows[0]?.manifest_hash!==plan.manifestHash)throw Error('forward_manifest_mismatch')
  for(const table of plan.tables){
   if(!same(await rows(source,'public',table.source,config.maxRowBytes),table.sourceDigest))throw Error('source_table_changed')
   if(!same(await rows(target,'memory',table.source,config.maxRowBytes),table.action==='copy'?table.sourceDigest:table.targetDigest))throw Error('target_table_changed')
   const checkpoint=(await target.query('SELECT row_count,row_hash FROM shared.memory_forward_tables WHERE migration_id=$1 AND table_name=$2',[config.migrationId,table.name])).rows[0]
   const fullTarget=await rows(target,'memory',table.target,config.maxRowBytes)
   if(!checkpoint||fullTarget.rows!==checkpoint.row_count||fullTarget.hash!==checkpoint.row_hash)throw Error('target_table_changed')
  }
  await foreignKeys(target)
  const actual=await sequences(target,plan.tables.map(t=>t.target),'memory')
  const expected=plan.targetSequences.map(initial=>plan.sequences.find(s=>s.table===initial.table&&s.column===initial.column)??initial)
  if(!same(actual,expected))throw Error('target_sequence_changed')
  const sourceEvents=plan.tables.find(t=>t.name==='source_events')!
  const checkpoint=(await target.query('SELECT row_count,row_hash FROM shared.memory_forward_tables WHERE migration_id=$1 AND table_name=$2',[config.migrationId,'source_events'])).rows[0]
  return {schemaVersion:1,kind:'memory-forward-verification',manifestHash:plan.manifestHash,migrationId:plan.migrationId,sourceIdentity:plan.sourceIdentity,targetIdentity:plan.targetIdentity,
   sourceEvents:{sourceColumns:sourceEvents.source.columns.map(c=>c.name),rows:checkpoint.row_count,hash:checkpoint.row_hash},verified:true,tables:String(plan.tables.length),backupCreated:false,rollbackSupported:false,
   activationAuthorized:false,limitations:['Independent database snapshots; current Relay privacy/authority overlay and JSON dependency closure remain separate gates.']}
 }finally{await close(source);await close(target)}
}
