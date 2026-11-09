import {assertPagedContextCoverage,assertPagedFrozenExtractions} from './paged-cleanup-operational.js'
import {assertPagedAccounting} from './paged-cleanup-accounting.js'
import {assertNativeOutputState} from './paged-cleanup-native-outputs.js'
import {independentlyAcceptedEvidenceOwnershipSql} from '../../claims/accepted-evidence-policy.js'
import {assertPagedNativeOriginals} from './paged-cleanup-source.js'
import type pg from 'pg'
import {qi} from './source-maintenance-common.js'
import {pagedHash,type PagedCleanupRecord,type PagedCleanupPart,type PagedCleanupHeader} from './paged-cleanup-manifest.js'
import {pagedRelation} from './paged-cleanup-receipts.js'
import type {PagedCatalog,PagedTable} from './paged-cleanup-catalog.js'
import type {PagedRoot} from './paged-cleanup-authority.js'
import {exactReferenceChannels} from './forward-exact-source.js'
import {SOURCE_REFERENCE_FIELDS,UNREVIEWED_SESSION_ARRAY_KEYS,referenceChannelSql} from './source-reference-contract.js'
export const referenceContractHash=()=>pagedHash({channels:exactReferenceChannels(),fields:SOURCE_REFERENCE_FIELDS,unknownArrays:UNREVIEWED_SESSION_ARRAY_KEYS,version:'paged-v4-original-key-joins-typed-source-v1'})
export function tableShape(catalog:PagedCatalog,table:string){const shape=catalog.tables.find(t=>t.table===table);if(!shape)throw Error('paged_table_unreviewed');return shape}
export function keyProjection(shape:PagedTable,alias='t'){return `jsonb_build_object(${shape.pk.flatMap(k=>["'"+k+"'",alias+'.'+qi(k)+'::text']).join(',')})`}
function refsProjection(shape:PagedTable,alias='t',version='t.xmin::text'){return `jsonb_build_object(${[...new Set([...shape.pk,...shape.references])].filter(k=>k!=='normalized_key').flatMap(k=>["'"+k+"'",alias+'.'+qi(k)+'::text']).join(',')})||jsonb_build_object('row_version',${version})`}
export async function selectPagedRows(c:pg.Client,shape:PagedTable,predicate:string,params:unknown[],cursor:Record<string,string|null>|null=null,limit=128):Promise<PagedCleanupRecord[]>{
 if(limit<1||limit>1024)throw Error('paged_row_limit')
 const bindings=[...params,cursor?JSON.stringify(cursor):null],position=bindings.length
 const after=`AND($${position}::jsonb IS NULL OR ROW(${shape.pk.map(k=>'t.'+qi(k)).join(',')})>ROW(${shape.pk.map(k=>'page_cursor.'+qi(k)).join(',')}))`
 const identityColumns=[...new Set([...shape.pk,...shape.references])]
 const identityGuard=identityColumns.length>32?'false':identityColumns.map(column=>{
  const value='t.'+qi(column)+'::text'
  return `CASE WHEN ${value} IS NULL THEN true WHEN char_length(${value})>1024 THEN false
   WHEN char_length(${value})<=512 THEN true
   ELSE char_length(${value})+char_length(regexp_replace(${value},U&'[\\0001-\\FFFF]+','','g'))<=1024 END`
 }).join(' AND ')
 const rows=(await c.query(`WITH selected AS MATERIALIZED(
  SELECT t AS original,t.xmin::text AS row_version,row_number() OVER(ORDER BY ${shape.pk.map(k=>'t.'+qi(k)).join(',')}) AS page_order,
   (${identityGuard}) AS identity_bounded
  FROM memory.${qi(shape.table)} t CROSS JOIN LATERAL jsonb_populate_record(NULL::memory.${qi(shape.table)},$${position}::jsonb) page_cursor
  WHERE (${predicate}) ${after} ORDER BY ${shape.pk.map(k=>'t.'+qi(k)).join(',')} LIMIT ${limit}
 ), candidates AS MATERIALIZED(
  SELECT page_order,identity_bounded,
   CASE WHEN identity_bounded THEN ${keyProjection(shape,'(t.original)')} ELSE NULL END AS key,
   CASE WHEN identity_bounded THEN ${refsProjection(shape,'(t.original)','t.row_version')} ELSE NULL END AS references,
   CASE WHEN identity_bounded THEN encode(sha256(convert_to(to_jsonb(t.original)::text,'UTF8')),'hex') ELSE NULL END AS fingerprint,
   CASE WHEN identity_bounded THEN octet_length(to_jsonb(t.original)::text)::text ELSE '0' END AS bytes
  FROM selected t
 ), budget AS(SELECT COALESCE(sum(octet_length(to_jsonb(candidates)::text)),0)<=8388608 AS read_bounded FROM candidates)
 SELECT CASE WHEN read_bounded THEN key ELSE NULL END AS key,
  CASE WHEN read_bounded THEN candidates.references ELSE NULL END AS references,
  fingerprint,bytes,identity_bounded,read_bounded FROM candidates CROSS JOIN budget ORDER BY page_order`,bindings)).rows
 return rows.map(({read_bounded,identity_bounded,...row})=>{
  if(!read_bounded)throw Error('paged_component_capacity')
  if(!identity_bounded)throw Error('paged_manifest_identity')
  return {table:shape.table,...row,disposition:'preserve'}
 })
}
/** Metadata-only sizing precedes any source body read. Keep a deterministic
 * keyset prefix; a single row must fit the unchanged work budget itself. */
export function pagedBytePrefix(rows:PagedCleanupRecord[],maxBytes=8388608n,reserve:(row:PagedCleanupRecord)=>bigint=()=>0n){
 const prefix:PagedCleanupRecord[]=[]
 let bytes=0n
 for(const row of rows){
  const next=bytes+BigInt(row.bytes)+reserve(row)
  if(next>maxBytes){if(!prefix.length)throw Error('paged_component_capacity');break}
  prefix.push(row);bytes=next
 }
 return prefix
}
export function itemMatch(shape:PagedTable,alias='t',key='i.original->\'key\''){
 const normal=shape.pk.map(k=>`${alias}.${qi(k)} IS NOT DISTINCT FROM k.${qi(k)}`).join(' AND ')
 if(shape.table==='memory_jobs')return `(CASE WHEN (${key})?'job_id' THEN (${normal}) ELSE ${alias}.installation_id=k.installation_id AND ${alias}.job_type=k.job_type AND ${alias}.idempotency_key=k.idempotency_key END)`
 return normal
}
export async function observePagedRow(c:pg.Client,catalog:PagedCatalog,row:PagedCleanupRecord){
 const shape=tableShape(catalog,row.table),keys=Object.keys(row.key).sort(),expected=row.table==='memory_jobs'&&!keys.includes('job_id')?['idempotency_key','installation_id','job_type']:shape.pk
 if(pagedHash(keys)!==pagedHash([...expected].sort()))throw Error('paged_exact_key_shape')
 const result=await c.query(`SELECT t.xmin::text AS version,${keyProjection(shape)} AS key,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,octet_length(to_jsonb(t)::text)::text AS bytes FROM jsonb_populate_record(NULL::memory.${qi(row.table)},$1::jsonb) k JOIN memory.${qi(row.table)} t ON ${itemMatch(shape,'t','$1::jsonb')}`,[JSON.stringify(row.key)])
 if(result.rows.length>1)throw Error('paged_exact_key_not_unique')
 return result.rows[0] as {version:string;key:Record<string,string|null>;fingerprint:string;bytes:string}|undefined
}
export async function observePagedPart(c:pg.Client,catalog:PagedCatalog,page:PagedCleanupPart){
 const result:Awaited<ReturnType<typeof observePagedRow>>[]=Array(page.records.length)
 for(const table of [...new Set(page.records.map(r=>r.table))]){
  const shape=tableShape(catalog,table),selected=page.records.flatMap((r,index)=>r.table===table?[{index,key:r.key}]:[])
  for(const row of selected){const expected=table==='memory_jobs'&&!Object.hasOwn(row.key,'job_id')?['idempotency_key','installation_id','job_type']:shape.pk;if(pagedHash(Object.keys(row.key).sort())!==pagedHash([...expected].sort()))throw Error('paged_exact_key_shape')}
  const rows=(await c.query(`SELECT (r.value->>'index')::int AS ordinal,CASE WHEN t.xmin IS NULL THEN NULL ELSE jsonb_build_object('version',t.xmin::text,'key',${keyProjection(shape)},'fingerprint',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'bytes',octet_length(to_jsonb(t)::text)::text) END AS actual
   FROM jsonb_array_elements($1::jsonb) r CROSS JOIN LATERAL jsonb_populate_record(NULL::memory.${qi(table)},r.value->'key') k
   LEFT JOIN memory.${qi(table)} t ON ${itemMatch(shape,'t',"r.value->'key'")} ORDER BY ordinal LIMIT 1025`,[JSON.stringify(selected)])).rows
  if(rows.length!==selected.length||new Set(rows.map(r=>r.ordinal)).size!==rows.length)throw Error('paged_exact_key_not_unique')
  for(const row of rows)result[row.ordinal]=row.actual??undefined
 }
 return page.records.map((row,index)=>({table:row.table,key:row.key,actual:result[index]??null}))
}
export async function assertPagedOriginalState(c:pg.Client,catalog:PagedCatalog,header:PagedCleanupHeader){
 await assertPagedNativeOriginals(c,header)
 await assertPagedFrozenExtractions(c,header)
 await assertPagedAccounting(c,header)
 await assertNativeOutputState(c,header.manifestHash)
 // Expand each receipt once. The exact original identity, state and prefix
 // comparison is unchanged; no per-row re-decoding of an entire JSON page.
 if((await c.query(`WITH output_states AS MATERIALIZED(
  SELECT r.ordinal,o->>'table' AS table_name,o->'key' AS key,COALESCE(o->'actual'->>'version','') AS version,
   o->'actual'='null'::jsonb AS absent,o->'actual'->>'fingerprint' AS fingerprint
  FROM ${pagedRelation('receipts')} r CROSS JOIN LATERAL jsonb_array_elements(r.outputs) o WHERE r.plan_hash=$1)
 SELECT 1 FROM ${pagedRelation('items')} i WHERE i.plan_hash=$1 AND i.last_page=-1
  AND(i.expected_version IS DISTINCT FROM COALESCE(i.original->'references'->>'row_version','')
   OR i.expected_fingerprint IS DISTINCT FROM i.original->>'fingerprint' OR i.absent IS DISTINCT FROM (NOT(i.original->'references'?'row_version')))
 UNION ALL
 SELECT 1 FROM ${pagedRelation('items')} i LEFT JOIN output_states o ON o.ordinal=i.last_page AND o.table_name=i.table_name
  AND o.key=i.original->'key' AND o.version=i.expected_version AND o.absent=i.absent AND(i.absent OR o.fingerprint=i.expected_fingerprint)
 WHERE i.plan_hash=$1 AND i.last_page>=0 AND o.ordinal IS NULL LIMIT 1`,[header.manifestHash])).rowCount)throw Error('paged_expected_prefix_drift')

 const tables=(await c.query(`SELECT DISTINCT table_name FROM ${pagedRelation('items')} WHERE plan_hash=$1 ORDER BY table_name`,[header.manifestHash])).rows.map(r=>r.table_name as string)
 for(const table of tables){
  const shape=tableShape(catalog,table)
  if((await c.query(`SELECT 1 FROM ${pagedRelation('items')} i CROSS JOIN LATERAL jsonb_populate_record(NULL::memory.${qi(table)},i.original->'key') k LEFT JOIN memory.${qi(table)} t ON ${itemMatch(shape)} WHERE i.plan_hash=$1 AND i.table_name=$2 AND((i.absent AND t.xmin IS NOT NULL) OR(NOT i.absent AND t.xmin::text IS DISTINCT FROM i.expected_version)) LIMIT 1`,[header.manifestHash,table])).rowCount)throw Error('paged_original_row_drift:'+table)
 }
}
export async function assertPagedEdges(c:pg.Client,catalog:PagedCatalog,header:PagedCleanupHeader,roots:readonly PagedRoot[],locked=false){
 const relevant=(await c.query(`SELECT DISTINCT table_name FROM ${pagedRelation('items')} WHERE plan_hash=$1`,[header.manifestHash])).rows.map(r=>r.table_name as string),parents=new Set(relevant)
 if(locked)await c.query('LOCK TABLE '+catalog.tables.map(t=>'memory.'+qi(t.table)).sort().join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')
 for(const edge of catalog.edges){
  if(!parents.has(edge.parent))continue
  const child=tableShape(catalog,edge.child),parent=tableShape(catalog,edge.parent)
  const key=`encode(sha256(convert_to((${keyProjection(child,'t')})::text,'UTF8')),'hex')`
  if((await c.query(`SELECT 1 FROM ${pagedRelation('items')} frozen CROSS JOIN LATERAL jsonb_populate_record(NULL::memory.${qi(parent.table)},(frozen.original->'references')||(frozen.original->'key')) p JOIN memory.${qi(child.table)} t ON ${edge.childColumns.map((k,i)=>'t.'+qi(k)+'=p.'+qi(edge.parentColumns[i])).join(' AND ')}
   WHERE frozen.plan_hash=$1 AND frozen.table_name=$2 AND (frozen.original->>'disposition'='preserve' AND frozen.original->>'retainReason'='independent_accepted') IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM ${pagedRelation('items')} admitted WHERE admitted.plan_hash=$1 AND admitted.table_name=$3 AND admitted.key_hash=${key}) LIMIT 1`,[header.manifestHash,parent.table,child.table])).rowCount)throw Error('paged_original_fk_edge_drift:'+child.table)
 }
 // New root rows must not hide behind a deleted original parent.
 for(const table of catalog.tables.filter(t=>t.columns.includes('installation_id')&&t.columns.includes('session_id'))){
  const key=`encode(sha256(convert_to((${keyProjection(table)})::text,'UTF8')),'hex')`
  if((await c.query(`SELECT 1 FROM memory.${qi(table.table)} t JOIN jsonb_to_recordset($2::jsonb) r("installationId" uuid,"sessionId" text) ON t.installation_id=r."installationId" AND t.session_id=r."sessionId" WHERE NOT EXISTS(SELECT 1 FROM ${pagedRelation('items')} i WHERE i.plan_hash=$1 AND i.table_name=$3 AND i.key_hash=${key}) LIMIT 1`,[header.manifestHash,JSON.stringify(roots),table.table])).rowCount)throw Error('paged_original_root_row_drift:'+table.table)
 }
 await assertPagedJsonEdges(c,catalog,header,roots)
 await assertPagedContextCoverage(c,header,roots)
}
/** Join declared handle values against frozen original identities, including
 * parents already deleted by committed pages. Prose is never searched/hashed. */
async function assertPagedJsonEdges(c:pg.Client,catalog:PagedCatalog,header:PagedCleanupHeader,roots:readonly PagedRoot[]){
 const fieldRows:{key:string;domain:'events'|'artifacts'|'episodes'|'sessions'}[]=SOURCE_REFERENCE_FIELDS.flatMap(f=>[...f.scalar,...f.arrays].map(key=>({key,domain:f.domain})))
 fieldRows.push(...UNREVIEWED_SESSION_ARRAY_KEYS.map(key=>({key,domain:'sessions' as const})))
 const fieldMap=JSON.stringify(Object.fromEntries(fieldRows.map(f=>[f.key,f.domain])))
 for(const path of exactReferenceChannels()){
  const [table,column]=path.split('.'),shape=tableShape(catalog,table),{from,owner}=referenceChannelSql(table)
  const key=`encode(sha256(convert_to((${keyProjection(shape)})::text,'UTF8')),'hex')`
  const original=`EXISTS(SELECT 1 FROM ${pagedRelation('items')} a WHERE a.plan_hash=$1 AND a.table_name='${table}' AND a.key_hash=${key})`
  const ownRoot=`EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.session_id=r."sessionId")`
  // Preserve the mature exact-source negative policy. Membership alone never
  // blesses arbitrary metadata on an external dependent/accepted row.
  const admitted=table==='source_events'||table==='source_artifacts'?original:
   table==='work_episodes'?`(${original} AND(${ownRoot}${column==='evidence_manifest'?` OR EXISTS(SELECT 1 FROM ${pagedRelation('items')} a WHERE a.plan_hash=$1 AND a.table_name='work_episodes' AND a.key_hash=${key} AND a.original->'references'->>'exact_source_policy_hash'='${pagedHash('native-exact-source-packet-v2')}')`:''}))`:
   table==='memory_task_bundles'?`(${original} AND ${ownRoot})`:'false'
  const independent=table==='knowledge_evidence'?`AND NOT EXISTS(SELECT 1 FROM memory.knowledge_evidence_capsules retained WHERE ${independentlyAcceptedEvidenceOwnershipSql('t','retained')})`:''
  // Expand only declared keys once per channel. Every spelling participates,
  // including malformed containers and recognized unreviewed Session arrays.
  // A MATERIALIZED boundary prevents the planner from rescanning JSON per ID.
  if((await c.query(`WITH declared AS MATERIALIZED(
   SELECT ${owner}::text AS owner_id,$3::jsonb->>field.key AS domain,field.value
   FROM ${from} CROSS JOIN LATERAL jsonb_path_query(t.${qi(column)},'strict $.** ? (@.type() == "object")') object
   CROSS JOIN LATERAL jsonb_each(object) field
   WHERE $3::jsonb ? field.key AND NOT(${admitted}) ${independent}), handles AS MATERIALIZED(
   SELECT owner_id,domain,handle#>>'{}' AS value FROM declared CROSS JOIN LATERAL jsonb_path_query(declared.value,'strict $.**') handle)
   SELECT 1 FROM handles h WHERE
   (h.domain='sessions' AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("installationId" text,"sessionId" text) WHERE r."installationId"=h.owner_id AND r."sessionId"=h.value))
   OR EXISTS(SELECT 1 FROM ${pagedRelation('items')} original WHERE original.plan_hash=$1 AND original.table_name=CASE h.domain WHEN 'events' THEN 'source_events' WHEN 'artifacts' THEN 'source_artifacts' WHEN 'episodes' THEN 'work_episodes' END AND lower(h.value)=original.original->'key'->>CASE h.domain WHEN 'events' THEN 'source_event_id' WHEN 'artifacts' THEN 'artifact_id' WHEN 'episodes' THEN 'episode_id' END) LIMIT 1`,[header.manifestHash,JSON.stringify(roots),fieldMap])).rowCount)throw Error('paged_original_json_reference_drift:'+path)
 }
}
