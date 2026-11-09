import type pg from 'pg'
import {createHash} from 'node:crypto'
import type {RetainedClosure} from './source-maintenance-retained.js'
import {retainedReferenceRoster,referenceChannelSql,SOURCE_REFERENCE_FIELDS,UNREVIEWED_SESSION_ARRAY_KEYS} from './source-reference-contract.js'
import {hash,qi} from './source-maintenance-common.js'
import {memoryForwardTableRoster} from './engine.js'
export interface PersonalDirectClosureScope {personalInstallationId:string;organizationInstallationId:string}
export interface PersonalDirectClosure extends RetainedClosure {verificationScope:'finite-personal-direct-launch';databaseLayout:'copied-target'|'original-schema84';channels:{path:string;rows:number;digest:string}[]}
export class PersonalDirectReferenceError extends Error {
 constructor(readonly channel:string,readonly rowKeyHashes:string[]){super('personal_direct_reference_unproven')}
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** Dedicated closed-target audit, not the global retained-authority adapter.
 * The caller supplies a consistent snapshot and keeps target writers fenced.
 * All typed roots are finite; repeated exact metadata handles collapse only
 * after SQL validates every spelling against its original owner/FK. Text,
 * excerpts, source bodies and raw metadata never leave PostgreSQL. */
export async function collectPersonalDirectClosure(c:pg.Client,scope:PersonalDirectClosureScope,options:{signal?:AbortSignal;databaseLayout?:'copied-target'|'original-schema84'}={}):Promise<PersonalDirectClosure>{
 const ids=[scope.personalInstallationId,scope.organizationInstallationId]
 const check=()=>{if(options.signal?.aborted)throw Error('personal_direct_interrupted')};check()
 if(ids.some(id=>!uuid.test(id))||new Set(ids).size!==2)throw Error('personal_direct_scope_invalid')
 const databaseLayout=options.databaseLayout??'copied-target'
 if(!['copied-target','original-schema84'].includes(databaseLayout))throw Error('personal_direct_layout_invalid')
 let originalTables:Set<string>|undefined
 if(databaseLayout==='original-schema84'){
  if((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only!=='on'||(await c.query('SELECT max(version) AS schema_version FROM public.memory_schema_migrations')).rows[0].schema_version!==84)throw Error('personal_direct_original_schema_invalid')
  const tables=(await c.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') ORDER BY c.relname")).rows.map(r=>r.relname)
  const roster=memoryForwardTableRoster(84);if(hash(tables.sort())!==hash(roster.sort()))throw Error('personal_direct_original_schema_invalid');originalTables=new Set(roster)
  // The original namespace is explicit and catalog-bound. Only this fixed
  // module's SQL identifiers and regclass parameters are translated. Values
  // read from source cells never participate in SQL construction.
  const original=c;c={query:(sql:string,args?:unknown[])=>original.query(sql.replaceAll('memory.','public.'),args?.map(value=>typeof value==='string'&&value.startsWith('memory.')?'public.'+value.slice(7):value))} as pg.Client
 }
 if(!['repeatable read','serializable'].includes((await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation)){
  const required=[...new Set([...retainedReferenceRoster().map(p=>'memory.'+p.split('.')[0]),...['source_events','source_sessions','source_artifacts','work_episodes','memory_task_bundles','memory_context_packs','knowledge_evidence_capsules','memory_owner_scopes'].map(t=>'memory.'+t)])]
  if((await c.query(`SELECT 1 FROM unnest($1::text[]) required(relation) WHERE NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.relation=to_regclass(required.relation) AND l.granted AND l.mode IN('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) LIMIT 1`,[required])).rowCount)throw Error('personal_direct_snapshot_required')
 }
 // JSON path's planner estimate can trigger repeated JIT compilation even
 // for empty channels. This transaction-local setting changes no DB policy.
 await c.query("SELECT set_config('jit','off',true)")
 const owners=(await c.query('SELECT installation_id::text,owner_scope_kind FROM memory.memory_owner_scopes WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id',[ids])).rows
 if(owners.length!==2||!owners.some(r=>r.installation_id===ids[0]&&r.owner_scope_kind==='personal')||!owners.some(r=>r.installation_id===ids[1]&&r.owner_scope_kind==='organization'))throw Error('personal_direct_scope_invalid')
 const roots=(await c.query(`SELECT installation_id::text AS "installationId",session_id AS "sessionId" FROM (
  SELECT installation_id,session_id FROM memory.source_events WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id,session_id FROM memory.source_sessions WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id,session_id FROM memory.source_artifacts WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id,session_id FROM memory.work_episodes WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id,session_id FROM memory.memory_task_bundles WHERE installation_id=ANY($1::uuid[])
  UNION SELECT installation_id,session_id FROM memory.memory_context_packs WHERE installation_id=ANY($1::uuid[])) roots ORDER BY installation_id,session_id LIMIT 4097`,[ids])).rows as RetainedClosure['roots']
 if(roots.length>4096||roots.some(r=>typeof r.sessionId!=='string'||!r.sessionId||r.sessionId.length>512))throw Error('personal_direct_root_limit')
 if(roots.some(r=>r.installationId!==ids[0]||r.sessionId.startsWith('team_')))throw Error('personal_direct_organization_history_not_empty')
 const fields=SOURCE_REFERENCE_FIELDS.flatMap(f=>[...f.scalar.map(key=>`('${key}','${f.domain}',false)`),...f.arrays.map(key=>`('${key}','${f.domain}',true)`)]).join(',')
 const referenceCte=`objects AS(SELECT selected.*,object FROM bounded selected CROSS JOIN LATERAL jsonb_path_query(CASE WHEN COALESCE(metadata_bytes,0)<=8388608 AND COALESCE(page_bytes,0)<=16777216 THEN metadata ELSE '{"_finite_overflow":true}'::jsonb END,'strict $.** ? (@.type() == "object")') object),
 handles AS(SELECT objects.*,field.domain,field.is_array,object->field.key AS handle FROM objects CROSS JOIN (VALUES ${fields}) field(key,domain,is_array) WHERE object ? field.key),
 expanded AS(SELECT handles.*,value FROM handles CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN is_array AND jsonb_typeof(handle)='array' THEN handle ELSE jsonb_build_array(handle) END) value),
 checked AS(SELECT row_key, bool_or(
  (handle<>'null'::jsonb AND (is_array AND jsonb_typeof(handle)<>'array' OR NOT is_array AND jsonb_typeof(handle)<>'string'))
  OR (is_array AND jsonb_typeof(handle)='array' AND jsonb_typeof(value)<>'string')
  OR (value<>'null'::jsonb AND jsonb_typeof(value)<>'string')
  OR (value<>'null'::jsonb AND NOT independent AND CASE domain
   WHEN 'sessions' THEN NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) root("installationId" text,"sessionId" text) WHERE root."installationId"=installation_id AND root."sessionId"=value#>>'{}')
   WHEN 'events' THEN NOT EXISTS(SELECT 1 FROM memory.source_events exact WHERE exact.installation_id=h.installation_id::uuid AND exact.source_event_id=CASE WHEN value#>>'{}' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN (value#>>'{}')::uuid END)
   WHEN 'artifacts' THEN NOT EXISTS(SELECT 1 FROM memory.source_artifacts exact WHERE exact.installation_id=h.installation_id::uuid AND exact.artifact_id=CASE WHEN value#>>'{}' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN (value#>>'{}')::uuid END)
   WHEN 'episodes' THEN NOT EXISTS(SELECT 1 FROM memory.work_episodes exact WHERE exact.installation_id=h.installation_id::uuid AND exact.episode_id=CASE WHEN value#>>'{}' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN (value#>>'{}')::uuid END)
   ELSE true END)) AS invalid FROM expanded h GROUP BY row_key),
 object_checks AS(SELECT row_key,bool_or(object ? '_finite_overflow' OR object ?| ARRAY['team','accepted_delivery','team_id','team_session_id',${UNREVIEWED_SESSION_ARRAY_KEYS.map(k=>"'"+k+"'").join(',')}] OR object->>'source_kind'='team_session') AS invalid FROM objects GROUP BY row_key)`
 const channels:PersonalDirectClosure['channels']=[]
 for(const path of retainedReferenceRoster()){
  check();const [table,column]=path.split('.'),{from,owner}=referenceChannelSql(table)
  if(originalTables&&!originalTables.has(table)){channels.push({path,rows:0,digest:createHash('sha256').digest('hex')});continue}
  if(!(await c.query(`SELECT 1 FROM ${from} WHERE ${owner}=ANY($1::uuid[]) LIMIT 1`,[ids])).rowCount){channels.push({path,rows:0,digest:createHash('sha256').digest('hex')});continue}
  const pk=(await c.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY key(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum WHERE i.indrelid=to_regclass($1) AND i.indisprimary ORDER BY key.ordinal`,['memory.'+table])).rows
  if(!pk.length)throw Error('personal_direct_metadata_primary_key_required')
  const key=`jsonb_build_array(${pk.map(k=>'t.'+qi(k.attname)+'::text').join(',')})`,order=pk.map(k=>'t.'+qi(k.attname)).join(','),selectedKeys=pk.map((k,n)=>'t.'+qi(k.attname)+' AS key_'+n).join(','),finalOrder=pk.map((_,n)=>'key_'+n).join(',')
  const after=pk.map((k,n)=>`($2::jsonb->>${n})::${k.type}`).join(',')
  let metadata='t.'+qi(column),independent='false',filter='',typedInvalid='false'
  if(table==='source_events')filter=" AND COALESCE(t.source_provenance,'{}'::jsonb)<>'{}'::jsonb"
  if(table==='source_artifacts'){
   metadata="jsonb_build_object('details',t.details,'typed',jsonb_build_object('source_event_id',t.source_event_id::text,'session_id',t.session_id))"
   typedInvalid='NOT EXISTS(SELECT 1 FROM memory.source_events exact WHERE exact.source_event_id=t.source_event_id AND exact.installation_id=t.installation_id AND exact.session_id=t.session_id)'
  }
  if(table==='knowledge_evidence'){
   metadata="jsonb_build_object('locator',t.locator,'typed',jsonb_strip_nulls(jsonb_build_object('source_event_id',t.source_event_id::text,'artifact_id',t.artifact_id::text,'episode_id',t.episode_id::text)))"
   independent="t.evidence_kind='accepted_excerpt' AND EXISTS(SELECT 1 FROM memory.knowledge_evidence_capsules capsule WHERE capsule.installation_id=t.installation_id AND capsule.capsule_id=t.capsule_id AND capsule.version_id=t.version_id AND capsule.retention_basis='user_accepted')"
  }
  const digest=createHash('sha256');let cursor:unknown=null,rows=0
  for(;;){
   check();const page=(await c.query(`WITH selected AS MATERIALIZED(SELECT ${selectedKeys},${key} AS row_key,${owner}::text AS installation_id,${metadata} AS metadata,${independent} AS independent,${typedInvalid} AS typed_invalid FROM ${from} WHERE ${owner}=ANY($1::uuid[]) ${filter} AND ($2::jsonb IS NULL OR (${order})>(${after})) ORDER BY ${order} LIMIT 256),
    bounded AS(SELECT *,octet_length(metadata::text) AS metadata_bytes,sum(octet_length(metadata::text)) OVER() AS page_bytes FROM selected),${referenceCte}
    SELECT row_key,encode(sha256(convert_to(COALESCE(metadata::text,''),'UTF8')),'hex') AS digest,
     typed_invalid OR COALESCE(metadata_bytes,0)>8388608 OR COALESCE(page_bytes,0)>16777216 OR COALESCE(checked.invalid,false) OR COALESCE(object_checks.invalid,false) AS invalid
    FROM bounded LEFT JOIN checked USING(row_key) LEFT JOIN object_checks USING(row_key) ORDER BY ${finalOrder}`,[ids,cursor===null?null:JSON.stringify(cursor),JSON.stringify(roots)])).rows
   if(!page.length)break
   if(table.startsWith('memory_team_semantic_')||page.some(r=>r.invalid))throw new PersonalDirectReferenceError(path,page.filter(r=>r.invalid||table.startsWith('memory_team_semantic_')).map(r=>hash(r.row_key)))
   // Continue using native typed PK order, never JSON text comparison.
   cursor=page.at(-1)!.row_key;rows+=page.length
   if(rows>2000000)throw Error('personal_direct_channel_limit')
   for(const row of page)digest.update(hash({key:row.row_key,digest:row.digest}))
  }
  channels.push({path,rows,digest:digest.digest('hex')})
 }
 const capsules=(await c.query("SELECT installation_id::text,capsule_id::text,version_id::text,retention_basis,encode(source_content_hash,'hex') AS source_content_hash FROM memory.knowledge_evidence_capsules WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id,capsule_id LIMIT 4097",[ids])).rows
 if(capsules.length>4096)throw Error('personal_direct_capsule_limit')
 check();const result={verificationScope:'finite-personal-direct-launch' as const,databaseLayout,roots,capsules,channels,references:[],unresolved:[],deliveries:[]}
 return {...result,fingerprint:hash(result)}
}
