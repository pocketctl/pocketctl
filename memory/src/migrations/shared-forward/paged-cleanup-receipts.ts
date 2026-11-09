import type pg from 'pg'
import {qi} from './source-maintenance-common.js'
import {pagedHash,validatePagedCleanupPart,type PagedCleanupHeader,type PagedCleanupPart,type PagedReceipt,type PagedCleanupRecord} from './paged-cleanup-manifest.js'
export const pagedTables={plans:'memory_forward_cleanup_v4_plans',pages:'memory_forward_cleanup_v4_pages',items:'memory_forward_cleanup_v4_items',receipts:'memory_forward_cleanup_v4_receipts'} as const
const shapes:Record<string,{columns:[string,string][];pk:string[]}>= {
 [pagedTables.plans]:{columns:[['plan_hash','text'],['header','jsonb'],['loaded_parts','bigint'],['loaded_hash','text'],['sealed','boolean']],pk:['plan_hash']},
 [pagedTables.pages]:{columns:[['plan_hash','text'],['ordinal','bigint'],['page_hash','text'],['page_state_hash','text'],['page','jsonb']],pk:['plan_hash','ordinal']},
 [pagedTables.items]:{columns:[['plan_hash','text'],['table_name','text'],['key_hash','text'],['original','jsonb'],['first_page','bigint'],['first_index','integer'],['expected_version','text'],['expected_fingerprint','text'],['absent','boolean'],['last_page','bigint']],pk:['plan_hash','table_name','key_hash']},
 [pagedTables.receipts]:{columns:[['plan_hash','text'],['ordinal','bigint'],['page_hash','text'],['previous_hash','text'],['before_hash','text'],['after_hash','text'],['receipt_hash','text'],['outputs','jsonb'],['completed_at','timestamp with time zone']],pk:['plan_hash','ordinal']},
}
export const pagedRelation=(name:keyof typeof pagedTables)=>'shared.'+qi(pagedTables[name])
/** Every administrator-created object is separately audited. Runtime roles,
 * PUBLIC, column ACLs, rules, triggers, defaults and RLS are all disallowed. */
export async function auditPagedMetadata(c:pg.Client,required=false){
 const expectedNames=Object.keys(shapes),expectedIndexes=expectedNames.map(name=>name+'_pkey')
 if((await c.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='shared' AND p.proname LIKE 'memory_forward_cleanup_v4_%'
  UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname LIKE 'memory_forward_cleanup_v4_%' AND NOT(c.relname=ANY($1::text[]) AND c.relkind='r' OR c.relname=ANY($2::text[]) AND c.relkind='i')
  UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='shared' AND (t.typname LIKE 'memory_forward_cleanup_v4_%' OR t.typname LIKE '_memory_forward_cleanup_v4_%') AND NOT(t.typname=ANY($3::text[]) AND t.typtype='b' AND t.typelem IN(SELECT c.reltype FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY($1::text[])) OR t.typtype='c' AND t.typrelid IN(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY($1::text[])))
  UNION ALL SELECT 1 FROM pg_constraint x JOIN pg_namespace n ON n.oid=x.connamespace WHERE n.nspname='shared' AND x.conname LIKE 'memory_forward_cleanup_v4_%' AND NOT(x.conname=ANY($2::text[]) AND x.contype='p' AND x.conrelid IN(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY($1::text[]))) LIMIT 1`,[expectedNames,expectedIndexes,expectedNames.map(name=>'_'+name)])).rowCount)throw Error('paged_checkpoint_unknown_object')
 const present=(await c.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname LIKE 'memory_forward_cleanup_v4_%' AND c.relkind IN('r','p','v','m','f') ORDER BY c.relname")).rows.map(r=>r.relname as string)
 if(present.some(name=>!Object.hasOwn(shapes,name)))throw Error('paged_checkpoint_unknown_object')
 if(!present.length){if(required)throw Error('paged_checkpoint_missing');return false}
 if(present.length!==Object.keys(shapes).length)throw Error('paged_checkpoint_partial_schema')
 for(const [table,shape] of Object.entries(shapes)){
  const relation='shared.'+table
  const types=(await c.query(`SELECT t.typname,t.typtype,t.typowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,t.typacl,t.typdefaultbin,t.typnotnull,
   t.typrelid=to_regclass($1) AS rowtype,t.typelem=(SELECT reltype FROM pg_class WHERE oid=to_regclass($1)) AS rowarray
   FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='shared' AND t.typname=ANY($2::text[]) ORDER BY t.typname`,[relation,[table,'_'+table]])).rows
  if(types.length!==2||types.some(t=>!t.owned||t.typacl!==null||t.typdefaultbin!==null||t.typnotnull||!(t.typname===table&&t.typtype==='c'&&t.rowtype||t.typname==='_'+table&&t.typtype==='b'&&t.rowarray)))throw Error('paged_checkpoint_type_drift')
  const state=(await c.query(`SELECT relkind,relpersistence,relreplident,reloptions,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
   NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(relacl,acldefault('r',relowner))) a WHERE a.grantee<>relowner) AS closed,
   NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND acl.grantee<>c.relowner) AS columns_closed,
   NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid) AS no_triggers,
   NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS no_rules,
   NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS no_policies,
   NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attisdropped) AS no_dropped
   FROM pg_class c WHERE oid=to_regclass($1)`,[relation])).rows[0]
  const columns=(await c.query("SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,attgenerated,attidentity,atthasdef,attcollation=(SELECT typcollation FROM pg_type WHERE oid=atttypid) AS native_collation FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum",[relation])).rows
  const constraints=(await c.query('SELECT conname,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1)',[relation])).rows
  const indexes=(await c.query('SELECT i.indisprimary,i.indisvalid,i.indisready,i.indexprs IS NULL AND i.indpred IS NULL AS plain,pg_get_indexdef(i.indexrelid) AS definition,c.reloptions,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,c.relpersistence FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=to_regclass($1)',[relation])).rows
  if(!state||state.relkind!=='r'||state.relpersistence!=='p'||state.relreplident!=='d'||pagedHash(state.reloptions)!==pagedHash(['autovacuum_enabled=false'])||!state.no_policies||!state.no_dropped||state.relrowsecurity||state.relforcerowsecurity||!state.owned||!state.closed||!state.columns_closed||!state.no_triggers||!state.no_rules||pagedHash(columns.map(a=>[a.attname,a.type]))!==pagedHash(shape.columns)||columns.some(a=>!a.attnotnull||a.attgenerated||a.attidentity||a.atthasdef||!a.native_collation)||constraints.length!==1||constraints[0].conname!==table+'_pkey'||!constraints[0].convalidated||constraints[0].condeferrable||constraints[0].condeferred||constraints[0].definition!==`PRIMARY KEY (${shape.pk.join(', ')})`||indexes.length!==1||indexes.some(i=>!i.indisprimary||!i.indisvalid||!i.indisready||!i.plain||i.reloptions!==null||!i.owned||i.relpersistence!=='p'||i.definition!==`CREATE UNIQUE INDEX ${table}_pkey ON shared.${table} USING btree (${shape.pk.join(', ')})`))throw Error('paged_checkpoint_structure_or_acl_drift')
 }
 return true
}
export async function preparePagedMetadata(c:pg.Client){
 if(!await auditPagedMetadata(c))for(const [table,shape] of Object.entries(shapes))await c.query(`CREATE TABLE shared.${qi(table)}(${shape.columns.map(([name,type])=>qi(name)+' '+type+' NOT NULL').join(',')},PRIMARY KEY(${shape.pk.map(qi).join(',')})) WITH(autovacuum_enabled=false);REVOKE ALL ON shared.${qi(table)} FROM PUBLIC`)
 await auditPagedMetadata(c,true)
}
/** Explicit apply/resume setup only. Statistics are planner hints, never part
 * of the authenticated row state. The caller gives each table a separately
 * fenced 10-second window; plan/verify never invoke this operation. */
export async function analyzePagedMetadata(c:pg.Client,table:keyof typeof pagedTables){
 await auditPagedMetadata(c,true)
 await c.query('ANALYZE '+pagedRelation(table))
}
export async function beginPagedLoad(c:pg.Client,header:PagedCleanupHeader){
 const row=(await c.query(`SELECT header FROM ${pagedRelation('plans')} WHERE plan_hash=$1`,[header.manifestHash])).rows[0]
 if(row){if(pagedHash(row.header)!==pagedHash(header))throw Error('paged_checkpoint_header_drift');return}
 await c.query(`INSERT INTO ${pagedRelation('plans')}(plan_hash,header,loaded_parts,loaded_hash,sealed) VALUES($1,$2::jsonb,0,$1,false)`,[header.manifestHash,JSON.stringify(header)])
}
export interface PagedFileWitness {ordinal:string;pageHash:string;stateHash:string;version:string}
export const pagedFileStateSeed=(header:PagedCleanupHeader)=>pagedHash(['paged-file-state-v1',header.manifestHash])
export const extendPagedFileState=(root:string,witness:PagedFileWitness)=>pagedHash([root,witness])
function fileWitness(page:PagedCleanupPart,row:{page_hash:string;page_state_hash:string;version:string},expectedStateHash:string):PagedFileWitness{
 if(row.page_hash!==pagedHash(page)||row.page_state_hash!==expectedStateHash||!/^\d+$/.test(row.version))throw Error('paged_stored_page_state_drift')
 return {ordinal:page.ordinal,pageHash:pagedHash(page),stateHash:expectedStateHash,version:row.version}
}
/** The expected root is kept in the caller, built from actual private-file
 * parts authenticated in this invocation. Metadata xmin is only a current
 * row-concurrency fence bound to that file hash/PK, never source provenance. */
async function assertPagedFileState(c:pg.Client,header:PagedCleanupHeader,expectedRoot:string){
 let after='-1',count=0n,root=pagedFileStateSeed(header)
 for(;;){
  const rows=(await c.query(`SELECT p.ordinal::text,p.xmin::text AS version,
   CASE WHEN page_hash ~ '^[a-f0-9]{64}$' THEN page_hash ELSE NULL END AS page_hash,
   CASE WHEN page_state_hash ~ '^[a-f0-9]{64}$' THEN page_state_hash ELSE NULL END AS page_state_hash
   FROM ${pagedRelation('pages')} p WHERE p.plan_hash=$1 AND p.ordinal>$2::bigint ORDER BY p.ordinal LIMIT 128`,[header.manifestHash,after])).rows
  for(const row of rows){
   if(row.ordinal!==String(count)||!row.page_hash||!row.page_state_hash)throw Error('paged_stored_page_state_drift')
   root=extendPagedFileState(root,{ordinal:row.ordinal,pageHash:row.page_hash,stateHash:row.page_state_hash,version:row.version});count++
  }
  if(!rows.length)break
  after=rows.at(-1)!.ordinal
 }
 if(String(count)!==header.partCount||root!==expectedRoot)throw Error('paged_stored_page_state_drift')
}
export async function loadPagedPart(c:pg.Client,header:PagedCleanupHeader,page:PagedCleanupPart){
 validatePagedCleanupPart(page)
 const state=(await c.query(`SELECT loaded_parts::text,loaded_hash,sealed FROM ${pagedRelation('plans')} WHERE plan_hash=$1 FOR UPDATE`,[header.manifestHash])).rows[0]
 if(!state)throw Error('paged_checkpoint_missing')
 if(BigInt(page.ordinal)<BigInt(state.loaded_parts)){
  return assertStoredPagedPart(c,header,page)
 }
 if(state.sealed||state.loaded_parts!==page.ordinal)throw Error('paged_load_prefix_drift')
 const insertedPage=(await c.query(`INSERT INTO ${pagedRelation('pages')}(plan_hash,ordinal,page_hash,page_state_hash,page) VALUES($1,$2::bigint,$3,encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex'),$4::jsonb) RETURNING page_hash,page_state_hash,xmin::text AS version`,[header.manifestHash,page.ordinal,pagedHash(page),JSON.stringify(page)])).rows[0]
 const records=JSON.stringify(page.records)
 // Authenticate both existing originals and duplicate input identities before
 // inserting anything. Distinct full keys defeat a hypothetical hash collision.
 await assertPagedRecordMembership(c,header,page.records,false)
 const inserted=await c.query(`WITH input AS MATERIALIZED(
   SELECT value,ordinality-1 AS first_index,value->>'table' AS table_name,
    encode(sha256(convert_to((value->'key')::text,'UTF8')),'hex') AS key_hash
   FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY
  ), firsts AS(SELECT DISTINCT ON(table_name,key_hash) * FROM input ORDER BY table_name,key_hash,first_index)
  INSERT INTO ${pagedRelation('items')}(plan_hash,table_name,key_hash,original,expected_version,expected_fingerprint,absent,last_page,first_page,first_index)
  SELECT $1,f.table_name,f.key_hash,f.value,COALESCE(f.value->'references'->>'row_version',''),f.value->>'fingerprint',
   NOT(f.value->'references'?'row_version'),-1,$3::bigint,f.first_index
  FROM firsts f WHERE NOT EXISTS(SELECT 1 FROM ${pagedRelation('items')} i WHERE i.plan_hash=$1 AND i.table_name=f.table_name AND i.key_hash=f.key_hash)
  RETURNING key_hash`,[header.manifestHash,records,page.ordinal])
 if(inserted.rowCount===null||inserted.rowCount>page.records.length)throw Error('paged_original_membership_drift')
 await assertPagedRecordMembership(c,header,page.records,true)
 await c.query(`UPDATE ${pagedRelation('plans')} SET loaded_parts=loaded_parts+1,loaded_hash=$2 WHERE plan_hash=$1`,[header.manifestHash,pagedHash([state.loaded_hash,page.ordinal,pagedHash(page)])])
 // INSERT expressions are computed directly from the authenticated file
 // parameter, under the exact no-trigger metadata table lock.
 return fileWitness(page,insertedPage,insertedPage.page_state_hash)
}
export async function assertStoredPagedPart(c:pg.Client,header:PagedCleanupHeader,page:PagedCleanupPart){
  const stored=(await c.query(`SELECT
   CASE WHEN page_hash ~ '^[a-f0-9]{64}$' THEN page_hash ELSE NULL END AS page_hash,
   CASE WHEN page_state_hash ~ '^[a-f0-9]{64}$' THEN page_state_hash ELSE NULL END AS page_state_hash,
   CASE WHEN octet_length(page::text)<=8388608 THEN page ELSE NULL END AS page,xmin::text AS version,
   encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex') AS expected_state_hash
   FROM ${pagedRelation('pages')} WHERE plan_hash=$1 AND ordinal=$2::bigint`,[header.manifestHash,page.ordinal,JSON.stringify(page)])).rows[0]
  if(!stored||stored.page_hash!==pagedHash(page)||pagedHash(stored.page)!==stored.page_hash)throw Error('paged_load_prefix_drift')
  await assertPagedRecordMembership(c,header,page.records,true)
  return fileWitness(page,stored,stored.expected_state_hash)
}
async function assertPagedRecordMembership(c:pg.Client,header:PagedCleanupHeader,records:readonly PagedCleanupRecord[],required:boolean){
 if(records.length>1024||Buffer.byteLength(JSON.stringify(records))>8388608)throw Error('paged_component_capacity')
 const result=await c.query(`WITH input AS MATERIALIZED(
  SELECT value,value->>'table' AS table_name,encode(sha256(convert_to((value->'key')::text,'UTF8')),'hex') AS key_hash,
   jsonb_build_array(value->'key',value->'fingerprint',value->'references') AS identity FROM jsonb_array_elements($2::jsonb)
 ), collisions AS(SELECT table_name,key_hash FROM input GROUP BY table_name,key_hash HAVING count(DISTINCT identity)>1)
 SELECT 1 FROM collisions UNION ALL
 SELECT 1 FROM input r LEFT JOIN ${pagedRelation('items')} i ON i.plan_hash=$1 AND i.table_name=r.table_name AND i.key_hash=r.key_hash
 WHERE ($3::boolean AND i.plan_hash IS NULL) OR(i.plan_hash IS NOT NULL AND(
  i.original->'key' IS DISTINCT FROM r.value->'key' OR i.original->'fingerprint' IS DISTINCT FROM r.value->'fingerprint'
  OR i.original->'references' IS DISTINCT FROM r.value->'references')) LIMIT 1`,[header.manifestHash,JSON.stringify(records),required])
 if(result.rowCount)throw Error('paged_original_membership_drift')
}
export async function sealPagedLoad(c:pg.Client,header:PagedCleanupHeader,loadedHash:string){
 const state=(await c.query(`SELECT loaded_parts::text,loaded_hash FROM ${pagedRelation('plans')} WHERE plan_hash=$1 FOR UPDATE`,[header.manifestHash])).rows[0]
 if(!state||state.loaded_parts!==header.partCount||state.loaded_hash!==loadedHash)throw Error('paged_load_prefix_drift')
 await c.query(`UPDATE ${pagedRelation('plans')} SET sealed=true WHERE plan_hash=$1`,[header.manifestHash])
}
export async function requirePagedSeal(c:pg.Client,header:PagedCleanupHeader,fileStateRoot?:string){
 await auditPagedMetadata(c,true)
 const state=(await c.query(`SELECT header,loaded_parts::text,sealed FROM ${pagedRelation('plans')} WHERE plan_hash=$1`,[header.manifestHash])).rows[0]
 if(!state?.sealed||state.loaded_parts!==header.partCount||pagedHash(state.header)!==pagedHash(header))throw Error('paged_manifest_load_not_sealed')
 if((await c.query(`SELECT 1 FROM ${pagedRelation('pages')} WHERE plan_hash=$1 AND(ordinal<0 OR ordinal>=$2::bigint) LIMIT 1`,[header.manifestHash,header.partCount])).rowCount)throw Error('paged_manifest_roster_drift')
 if(fileStateRoot!==undefined)await assertPagedFileState(c,header,fileStateRoot)
 // Without the complete file root this is only a structural load/read check;
 // no business mutation or successful final receipt may use that weaker form.
 else if((await c.query(`SELECT 1 FROM ${pagedRelation('pages')} WHERE plan_hash=$1 AND page_state_hash IS DISTINCT FROM encode(sha256(convert_to(page::text,'UTF8')),'hex') LIMIT 1`,[header.manifestHash])).rowCount)throw Error('paged_stored_page_state_drift')
 if((await c.query(`WITH originals AS MATERIALIZED(
  SELECT p.ordinal,r.ordinality-1 AS record_index,r.value AS original
  FROM ${pagedRelation('pages')} p CROSS JOIN LATERAL jsonb_array_elements(p.page->'records') WITH ORDINALITY r
  WHERE p.plan_hash=$1)
 SELECT 1 FROM ${pagedRelation('items')} i LEFT JOIN originals p ON p.ordinal=i.first_page AND p.record_index=i.first_index
 WHERE i.plan_hash=$1 AND(p.ordinal IS NULL OR i.first_index<0 OR i.first_index>=1024 OR p.original IS DISTINCT FROM i.original
  OR i.table_name IS DISTINCT FROM i.original->>'table' OR i.key_hash IS DISTINCT FROM encode(sha256(convert_to((i.original->'key')::text,'UTF8')),'hex')) LIMIT 1`,[header.manifestHash])).rowCount)throw Error('paged_manifest_roster_drift')

}
export async function pagedPrefix(c:pg.Client,header:PagedCleanupHeader){
 let after='-1',tail=header.manifestHash,n=0n
 for(;;){
  const rows=(await c.query(`SELECT r.ordinal::text,r.page_hash,r.previous_hash,r.before_hash,r.after_hash,r.receipt_hash,CASE WHEN octet_length(r.outputs::text)<=8388608 THEN r.outputs ELSE NULL END AS outputs,p.page_hash AS original_page_hash
   FROM ${pagedRelation('receipts')} r LEFT JOIN ${pagedRelation('pages')} p USING(plan_hash,ordinal) WHERE r.plan_hash=$1 AND r.ordinal>$2::bigint ORDER BY r.ordinal LIMIT 1`,[header.manifestHash,after])).rows
  for(const row of rows){const receipt={ordinal:row.ordinal,manifestHash:header.manifestHash,pageHash:row.page_hash,previousHash:row.previous_hash,beforeHash:row.before_hash,afterHash:row.after_hash,outputsHash:pagedHash(row.outputs)}
   if(!Array.isArray(row.outputs)||row.outputs.length>1024||row.ordinal!==n.toString()||row.previous_hash!==tail||row.page_hash!==row.original_page_hash||pagedHash(receipt)!==row.receipt_hash)throw Error('paged_receipt_prefix_drift');tail=row.receipt_hash;n++
  }
  if(!rows.length)break;after=rows.at(-1)!.ordinal
 }
 if(n>BigInt(header.partCount))throw Error('paged_receipt_prefix_drift')
 return {completed:n.toString(),tailHash:tail}
}
export async function writePagedReceipt(c:pg.Client,header:PagedCleanupHeader,page:PagedCleanupPart,tail:string,beforeHash:string,afterHash:string,outputs:unknown[]){
 if(outputs.length>1024||Buffer.byteLength(JSON.stringify(outputs))>8388608)throw Error('paged_receipt_output_capacity')
 const body={ordinal:page.ordinal,manifestHash:header.manifestHash,pageHash:pagedHash(page),previousHash:tail,beforeHash,afterHash,outputsHash:pagedHash(outputs)},receipt:PagedReceipt={...body,receiptHash:pagedHash(body)}
 await c.query(`INSERT INTO ${pagedRelation('receipts')}(plan_hash,ordinal,page_hash,previous_hash,before_hash,after_hash,receipt_hash,outputs,completed_at) VALUES($1,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,clock_timestamp())`,[header.manifestHash,page.ordinal,receipt.pageHash,tail,beforeHash,afterHash,receipt.receiptHash,JSON.stringify(outputs)])
}
export async function updatePagedExpectedBatch(c:pg.Client,header:PagedCleanupHeader,page:PagedCleanupPart,observed:readonly {actual:{version:string;fingerprint:string}|null}[]){
 if(observed.length!==page.records.length||page.records.length>1024)throw Error('paged_original_membership_drift')
 const updates=page.records.map((row,index)=>({table:row.table,key:row.key,version:observed[index].actual?.version??'',fingerprint:observed[index].actual?.fingerprint??row.fingerprint,absent:!observed[index].actual}))
 const result=await c.query(`WITH input AS MATERIALIZED(
  SELECT value,value->>'table' AS table_name,encode(sha256(convert_to((value->'key')::text,'UTF8')),'hex') AS key_hash
   FROM jsonb_array_elements($2::jsonb)
 ), valid AS(SELECT table_name,key_hash,min(value::text)::jsonb AS value FROM input GROUP BY table_name,key_hash HAVING count(DISTINCT value)=1)
 UPDATE ${pagedRelation('items')} i SET expected_version=v.value->>'version',expected_fingerprint=v.value->>'fingerprint',
  absent=(v.value->>'absent')::boolean,last_page=$3::bigint FROM valid v
 WHERE i.plan_hash=$1 AND i.table_name=v.table_name AND i.key_hash=v.key_hash AND i.original->'key'=v.value->'key'
 RETURNING i.table_name,i.key_hash`,[header.manifestHash,JSON.stringify(updates),page.ordinal])
 const expected=new Set(updates.map(row=>pagedHash([row.table,row.key])))
 if(result.rowCount!==expected.size)throw Error('paged_original_membership_drift')
}

export async function lockPagedMetadata(c:pg.Client){await c.query('LOCK TABLE '+Object.values(pagedTables).map(name=>'shared.'+qi(name)).join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')}
