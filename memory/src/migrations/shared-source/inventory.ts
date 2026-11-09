import { canonicalJsonString } from '../../inbox/canonical-json.js'
import { classifyObject, type CatalogObject, type ObjectPlan } from './classification.js'
import type { Snapshot } from './database.js'
import { fingerprint } from './report.js'
import {quoteIdentifier} from '../shared-db/schema-context.js'
const scope="n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'"
/** Definitions stay in memory only. Reports contain hashes, structural flags,
 * exact decimal sizes, and privilege metadata; never function bodies/default literals. */
export async function inventoryDatabase(snapshot:Snapshot, service:'memory'|'relay', plan:ObjectPlan) {
  const db=snapshot.client, objects:(CatalogObject&{classification:ReturnType<typeof classifyObject>})[]=[]
  async function collect(sql:string) {
    const rows=(await db.query(sql)).rows
    for(const row of rows){
      const {definition,...metadata}=row
      const object:CatalogObject={...metadata,key:`${row.kind}:${row.schema}.${row.name}`,definitionHash:fingerprint(canonicalJsonString(definition))}
      objects.push({...object,classification:classifyObject(object,plan)})
    }
  }
  await collect(`SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' WHEN 'f' THEN 'foreign-table' ELSE 'table' END kind,
    n.nspname AS schema,c.relname AS name,c.relrowsecurity AS "rowSecurity",c.relforcerowsecurity AS "forceRowSecurity",
    CASE WHEN c.relkind IN ('r','m','p') THEN pg_total_relation_size(c.oid)::text ELSE '0' END AS bytes,
    c.reltuples::text AS "estimatedRows",
    jsonb_build_object('kind',c.relkind,'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,'persistence',c.relpersistence,'partition',pg_get_expr(c.relpartbound,c.oid),
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
       'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'view',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END,'options',c.reloptions) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} AND c.relkind IN ('r','p','S','v','m','f') ORDER BY n.nspname,c.relname`)
  await collect(`SELECT 'index' AS kind,n.nspname AS schema,c.relname AS name,t.relname AS parent,
    i.indisvalid AS valid,i.indisready AS ready,pg_relation_size(c.oid)::text AS bytes,
    jsonb_build_object('ddl',pg_get_indexdef(c.oid),'valid',i.indisvalid,'ready',i.indisready) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} ORDER BY n.nspname,c.relname`)
  await collect(`WITH RECURSIVE json_types(oid) AS(
    SELECT oid FROM pg_type WHERE oid IN('json'::regtype,'jsonb'::regtype)
    UNION SELECT t.oid FROM pg_type t JOIN json_types base ON t.typbasetype=base.oid OR t.typelem=base.oid)
   SELECT 'json-column' AS kind,n.nspname AS schema,c.relname||'.'||a.attname AS name,c.relname AS parent,
    a.attname AS "columnName",format_type(a.atttypid,a.atttypmod) AS "dataType",
    jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) AS definition
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE ${scope} AND c.relkind IN('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid IN(SELECT oid FROM json_types)
   ORDER BY n.nspname,c.relname,a.attnum`)
  await collect(`SELECT CASE c.contype WHEN 'f' THEN 'foreign-key' ELSE 'constraint' END kind,n.nspname AS schema,
    t.relname||'.'||c.conname AS name,t.relname AS parent,c.convalidated AS valid,
    (SELECT ns.nspname FROM pg_class cr JOIN pg_namespace ns ON ns.oid=cr.relnamespace WHERE cr.oid=c.confrelid) AS "referencedSchema",
    (SELECT cr.relname FROM pg_class cr WHERE cr.oid=c.confrelid) AS "referencedTable",
    jsonb_build_object('ddl',pg_get_constraintdef(c.oid,true),'valid',c.convalidated) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE ${scope} ORDER BY n.nspname,t.relname,c.conname`)
  await collect(`SELECT 'function' AS kind,n.nspname AS schema,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS name,
    p.prosecdef AS "securityDefiner",COALESCE(array_to_string(p.proconfig,',') LIKE '%search_path=%',false) AS "fixedSearchPath",
    (p.prosrc ~* 'EXECUTE[[:space:]]') AS "dynamicSql",(p.prosrc ~* '(public[.]|regclass|search_path)') AS "namespaceSensitive",
    jsonb_build_object('ddl',CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE p.prosrc END,'config',p.proconfig) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${scope} ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`)
  await collect(`SELECT 'trigger' AS kind,n.nspname AS schema,c.relname||'.'||t.tgname AS name,c.relname AS parent,
    t.tgenabled AS enabled,t.tgisinternal AS internal,jsonb_build_object('ddl',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} ORDER BY n.nspname,c.relname,t.tgname`)
  const sequences=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,has_sequence_privilege(c.oid,'SELECT') AS "canRead",
   jsonb_build_object('start',s.seqstart::text,'min',s.seqmin::text,'max',s.seqmax::text,'increment',s.seqincrement::text,'cycle',s.seqcycle,'cache',s.seqcache::text) AS definition
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid WHERE ${scope} ORDER BY n.nspname,c.relname`)).rows
  for(const sequence of sequences){
   const state=sequence.canRead===true?(await db.query('SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM '+quoteIdentifier(sequence.schema)+'.'+quoteIdentifier(sequence.name))).rows[0]:{lastValue:null,isCalled:null}
   const object:CatalogObject={key:`sequence-state:${sequence.schema}.${sequence.name}`,kind:'sequence-state',schema:sequence.schema,name:sequence.name,
    ...state,stateReadable:sequence.canRead===true,definitionHash:fingerprint(canonicalJsonString({...sequence.definition,...state,stateReadable:sequence.canRead===true}))}
   objects.push({...object,classification:classifyObject(object,plan)})
  }
  await collect(`SELECT 'sequence-ownership' AS kind,n.nspname AS schema,c.relname AS name,
    jsonb_build_object('table',tn.nspname||'.'||t.relname,'column',a.attname,'dependency',d.deptype) AS definition
    FROM pg_depend d JOIN pg_class c ON c.oid=d.objid AND c.relkind='S' JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE ${scope} AND d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') ORDER BY n.nspname,c.relname`)
  await collect(`SELECT 'schema' AS kind,n.nspname AS schema,n.nspname AS name,n.nspacl::text AS definition FROM pg_namespace n WHERE ${scope} ORDER BY n.nspname`)
  await collect(`SELECT 'extension' AS kind,n.nspname AS schema,e.extname AS name,jsonb_build_object('version',e.extversion,'relocatable',e.extrelocatable,'owner',e.extowner::regrole::text) AS definition FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`)
  await collect(`SELECT 'policy' AS kind,n.nspname AS schema,c.relname||'.'||p.polname AS name,
    jsonb_build_object('using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid),'roles',p.polroles::text,'command',p.polcmd,'permissive',p.polpermissive) AS definition
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope}`)
  // Include all noninternal rules/types; unreviewed objects cannot disappear from the plan.
  await collect(`SELECT 'rule' AS kind,n.nspname AS schema,c.relname||'.'||r.rulename AS name,jsonb_build_object('ddl',pg_get_ruledef(r.oid,true),'enabled',r.ev_enabled) AS definition
    FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope}`)
  await collect(`SELECT 'type' AS kind,n.nspname AS schema,t.typname AS name,
    jsonb_build_object('type',t.typtype,'base',format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,
      'default',t.typdefaultbin::text,'collation',t.typcollation::text,
      'constraints',(SELECT jsonb_agg(pg_get_constraintdef(c.oid,true) ORDER BY c.conname) FROM pg_constraint c WHERE c.contypid=t.oid),
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attcollation::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped),
      'range',(SELECT jsonb_build_array(format_type(r.rngsubtype,NULL),r.rngcollation::text,r.rngsubopc::text,r.rngcanonical::text,r.rngsubdiff::text) FROM pg_range r WHERE r.rngtypid=t.oid),
      'enum',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)) AS definition
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
    WHERE ${scope} AND t.typelem=0 AND (t.typrelid=0 OR c.relkind='c')`)
  await collect(`SELECT 'event-trigger' AS kind,'*' AS schema,e.evtname AS name,
    jsonb_build_object('event',e.evtevent,'function',e.evtfoid::regprocedure::text,'enabled',e.evtenabled,'tags',e.evttags,'owner',e.evtowner::regrole::text) AS definition
    FROM pg_event_trigger e ORDER BY e.evtname`)
  const privileges=(await db.query(`SELECT permissions.*,(SELECT jsonb_agg(jsonb_build_object('grantor',x.grantor::regrole::text,
      'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.privilege_type)
      FROM aclexplode(permissions.acl::aclitem[]) x) AS grants FROM (SELECT 'relation'::text AS kind,n.nspname::text AS schema,c.relname::text AS name,c.relowner::regrole::text AS owner,
      COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} AND c.relkind IN ('r','p','S','v','m','f')
    UNION ALL SELECT 'function',n.nspname::text,(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')')::text,p.proowner::regrole::text,COALESCE(p.proacl,acldefault('f',p.proowner))::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${scope}
    UNION ALL SELECT 'schema',n.nspname::text,n.nspname::text,n.nspowner::regrole::text,COALESCE(n.nspacl,acldefault('n',n.nspowner))::text FROM pg_namespace n WHERE ${scope}
    UNION ALL SELECT 'default',COALESCE(n.nspname::text,'*'),d.defaclrole::regrole::text||'.'||d.defaclobjtype::text,d.defaclrole::regrole::text,d.defaclacl::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    UNION ALL SELECT 'column',n.nspname::text,(c.relname||'.'||a.attname)::text,c.relowner::regrole::text,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} AND a.attacl IS NOT NULL
    UNION ALL SELECT 'type',n.nspname::text,t.typname::text,t.typowner::regrole::text,COALESCE(t.typacl,acldefault('T',t.typowner))::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${scope} AND t.typelem=0
    UNION ALL SELECT 'database','*',d.datname::text,d.datdba::regrole::text,COALESCE(d.datacl,acldefault('d',d.datdba))::text FROM pg_database d WHERE d.datname=current_database()) permissions`)).rows
  for(const p of privileges){
    const object:CatalogObject={key:`permission:${p.schema}.${p.kind}.${p.kind==='default'||p.kind==='database'?fingerprint(p.name):p.name}`,kind:'permission',schema:p.schema,
      name:p.kind==='default'||p.kind==='database'?fingerprint(p.name):p.name,ownerFingerprint:fingerprint(p.owner),aclFingerprint:fingerprint(p.acl??''),
      grants:(p.grants??[]).map((g:Record<string,any>)=>({grantorFingerprint:fingerprint(g.grantor),granteeFingerprint:fingerprint(g.grantee),public:g.grantee==='PUBLIC',privilege:g.privilege,grantable:g.grantable})),
      definitionHash:fingerprint(canonicalJsonString(p))}
    objects.push({...object,classification:classifyObject(object,plan)})
  }
  const roles=(await db.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('role',roleid::regrole::text,'grantor',grantor::regrole::text,'admin',admin_option,'inherit',to_jsonb(m)->>'inherit_option','set',to_jsonb(m)->>'set_option') ORDER BY roleid::regrole::text) FROM pg_auth_members m WHERE m.member=r.oid),'[]') AS memberships,
    (SELECT jsonb_agg(jsonb_build_object('database',s.setdatabase::text,'config',s.setconfig) ORDER BY s.setdatabase) FROM pg_db_role_setting s WHERE s.setrole=r.oid) AS settings
    FROM pg_roles r ORDER BY rolname`)).rows
  for(const r of roles){
    const name=fingerprint(r.rolname),object:CatalogObject={key:'role:*.'+name,kind:'role',schema:'*',name,superuser:r.rolsuper,createRole:r.rolcreaterole,createDatabase:r.rolcreatedb,
      bypassRls:r.rolbypassrls,replication:r.rolreplication,inherit:r.rolinherit,canLogin:r.rolcanlogin,connectionLimit:String(r.rolconnlimit),settingsFingerprint:fingerprint(canonicalJsonString(r.settings)),
      memberships:r.memberships.map((m:Record<string,any>)=>({roleFingerprint:fingerprint(m.role),grantorFingerprint:fingerprint(m.grantor),adminOption:m.admin,inheritOption:m.inherit,setOption:m.set})),definitionHash:fingerprint(canonicalJsonString(r))}
    objects.push({...object,classification:classifyObject(object,plan)})
  }
  objects.sort((a,b)=>a.key.localeCompare(b.key))
  // Legacy human-readable keys are not an SQL identifier encoding. Quoted
  // dots can collide even when hashes match; no object-plan entry may clear
  // such an ambiguity. Keep both structural records and force explicit repair.
  const counts=new Map<string,number>()
  for(const object of objects)counts.set(object.key,(counts.get(object.key)??0)+1)
  const collisions=[...counts].filter(([,count])=>count>1).map(([key])=>key)
  for(const object of objects)if((counts.get(object.key)??0)>1)object.classification={...object.classification,blocked:true,reasons:[...object.classification.reasons,'catalog_identity_collision']}
  const bytes=(await db.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes as string
  const blockers=objects.filter(o=>o.classification.blocked).map(o=>'object_review:'+o.key)
  blockers.push(...collisions.map(key=>'catalog_identity_collision:'+key))
  for(const object of objects)if(object.kind==='sequence-state'&&object.stateReadable!==true)blockers.push('sequence_state_unavailable:'+object.key)
  for(const o of objects)if(o.valid===false || o.ready===false)blockers.push('invalid_object:'+o.key)
  return {schemaVersion:1,reportType:'inventory',service,identity:snapshot.identity,allocatedBytes:bytes,objects,blockers,
    fullMappingExecuted:false,migrationReady:false,limitations:['Catalog snapshot is database-local; the two databases are not atomically consistent.','Relation sizes and statistics are observations, not MVCC-frozen physical files.','Object classification requires a separately reviewed exact definition hash.']}
}
export function namespaceAudit(inventories:Awaited<ReturnType<typeof inventoryDatabase>>[]) {
  return {schemaVersion:1,reportType:'namespace-audit',crossDatabaseAtomic:false,
    databases:inventories.map(i=>({identity:i.identity,objects:i.objects,blockers:i.blockers})),migrationReady:false,
    blockers:['runtime_namespace_and_privileges_not_migrated','catalog_hashes_do_not_prove_dynamic_sql_safety']}
}
