import type pg from 'pg'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {inspectCrossDatabaseCapabilities,type CrossDatabaseCapabilityProof} from './source-maintenance-capabilities.js'
import {TABLE_POLICY} from '../shared-source/table-policy.js'
import {assertFrozenMemorySource} from '../shared-source/maintenance.js'
import {connectMaintenance,hash,qi,seal,assertManifest,type MaintenanceDatabase} from './source-maintenance-common.js'
export interface MemoryUnits {api:string;worker:string;freshInstall:boolean}
interface UnitState {LoadState:string;ActiveState:string;SubState:string;MainPID:string}
export interface DrainEvidence {api:UnitState;worker:UnitState;observedAt:string}
export type SystemdRunner=(file:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<{stdout:string}>
function validateUnits(units:MemoryUnits){
 if(!units||units.api===units.worker||typeof units.freshInstall!=='boolean'||[units.api,units.worker].some(u=>!/^[-a-zA-Z0-9_.@]{1,160}\.service$/.test(u)))throw Error('invalid_memory_units')
}
export async function probeSystemdDrain(units:MemoryUnits,runner:SystemdRunner=promisify(execFile)):Promise<DrainEvidence>{
 validateUnits(units)
 const states:UnitState[]=[]
 for(const unit of [units.api,units.worker]){
  let stdout:string
  try{({stdout}=await runner('systemctl',['show','--no-pager','--property=LoadState,ActiveState,SubState,MainPID',unit],{timeout:5000,maxBuffer:16384}))}catch(error){
   const failed=error as {stdout?:unknown;code?:unknown}
   if(!units.freshInstall||typeof failed.stdout!=='string'||!failed.stdout.split('\n').includes('LoadState=not-found')||!Number.isInteger(failed.code))throw Error('systemd_probe_failed')
   stdout=failed.stdout
  }
  const entries=stdout.trim().split('\n').map(line=>line.split('='))
  if(entries.length!==4||entries.some(e=>e.length!==2)||new Set(entries.map(e=>e[0])).size!==4)throw Error('invalid_systemd_evidence')
  const state=Object.fromEntries(entries) as unknown as UnitState
  if(!['LoadState','ActiveState','SubState','MainPID'].every(k=>typeof state[k as keyof UnitState]==='string')||!/^\d+$/.test(state.MainPID))throw Error('invalid_systemd_evidence')
  states.push(state)
 }
 const evidence={api:states[0],worker:states[1],observedAt:new Date().toISOString()}
 validateDrainEvidence(units,evidence);return evidence
}
export function validateDrainEvidence(units:MemoryUnits,evidence:DrainEvidence):void{
 validateUnits(units)
 if(!Number.isFinite(Date.parse(evidence?.observedAt))||Math.abs(Date.now()-Date.parse(evidence.observedAt))>15000)throw Error('stale_systemd_evidence')
 for(const state of [evidence.api,evidence.worker])if(!state||state.MainPID!=='0'||state.ActiveState!=='inactive'||!['dead','failed'].includes(state.SubState)||!(state.LoadState==='loaded'||units.freshInstall&&state.LoadState==='not-found'))throw Error('memory_service_not_drained')
}
export interface SourceFenceConfig {database:MaintenanceDatabase;oldMemoryRole:string;targetRoles:string[];reviewedConnectRoles:string[];units:MemoryUnits}
interface Backend {pid:string;roleOid:string;role:string;backendStart:string;application:string;clientAddress:string|null;state:string;xactStart:string|null;backendType:string}
interface Role {oid:string;name:string;login:boolean;superuser:boolean;createdb:boolean;createrole:boolean;replication:boolean;bypassrls:boolean}
interface Acl {grantor:string;grantee:string;privilege:string;grantable:boolean}
interface SourceState {identity:string;role:Role;reviewedGrantees:{name:string;oid:string}[];acl:Acl[];memberships:unknown[];externalDependencies:unknown[];backends:Backend[]}
export interface SourceFenceManifest {schemaVersion:2;crossDatabaseReview:CrossDatabaseCapabilityProof[];kind:'memory-source-fence';configHash:string;identity:string;role:Role;reviewedGrantees:{name:string;oid:string}[];acl:Acl[];memberships:unknown[];externalDependencies:unknown[];backends:Backend[];drain:DrainEvidence;manifestHash:string}
export interface SourceFenceOptions {probe?:(units:MemoryUnits)=>Promise<DrainEvidence>;signal?:AbortSignal;drainTimeoutMs?:number}
const checkAbort=(options:SourceFenceOptions)=>{if(options.signal?.aborted)throw Error('maintenance_interrupted')}
async function drain(config:SourceFenceConfig,options:SourceFenceOptions){checkAbort(options);const evidence=await (options.probe??probeSystemdDrain)(config.units);validateDrainEvidence(config.units,evidence);checkAbort(options);return evidence}
function checkConfig(config:SourceFenceConfig){
 if(!/^[-a-zA-Z0-9_]{1,63}$/.test(config.oldMemoryRole)||!Array.isArray(config.targetRoles)||!config.targetRoles.length||config.targetRoles.length>16||config.targetRoles.some(r=>!/^[-a-zA-Z0-9_]{1,63}$/.test(r))||config.targetRoles.includes(config.oldMemoryRole)||config.oldMemoryRole===config.database.expected.role)throw Error('unsafe_old_memory_role')
 if(!Array.isArray(config.reviewedConnectRoles)||config.reviewedConnectRoles.length>16||config.reviewedConnectRoles.some(r=>!/^[-a-zA-Z0-9_]{1,63}$/.test(r))||!config.reviewedConnectRoles.includes(config.oldMemoryRole)||config.reviewedConnectRoles.some(r=>config.targetRoles.includes(r)||r===config.database.expected.role)||new Set(config.reviewedConnectRoles).size!==config.reviewedConnectRoles.length)throw Error('reviewed_connect_roles_required')
 validateUnits(config.units)
}
const configHash=(config:SourceFenceConfig)=>hash({expected:config.database.expected,oldMemoryRole:config.oldMemoryRole,targetRoles:[...config.targetRoles].sort(),reviewedConnectRoles:[...config.reviewedConnectRoles].sort(),units:config.units})
async function sourceState(client:pg.Client,identity:string,config:SourceFenceConfig):Promise<SourceState>{
 const namespace=(await client.query("SELECT to_regclass('public.memory_schema_migrations') IS NOT NULL AS memory,to_regclass('shared.memory_source_contract') IS NOT NULL AS shared")).rows[0]
 if(!namespace.memory||namespace.shared)throw Error('dedicated_legacy_memory_source_required')
 if((await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p','m') AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' AND NOT(n.nspname='public' AND c.relname=ANY($1::text[])) LIMIT 1",[Object.keys(TABLE_POLICY)])).rowCount)throw Error('unknown_source_business_relation')

 const role=(await client.query<Role>(`SELECT oid::text,rolname AS name,rolcanlogin AS login,rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname=$1`,[config.oldMemoryRole])).rows[0]
 if(!role||role.superuser||role.createdb||role.createrole||role.replication||role.bypassrls)throw Error('unsafe_old_memory_role')
 const reviewedGrantees=(await client.query<{name:string;oid:string}>('SELECT rolname AS name,oid::text FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[config.reviewedConnectRoles])).rows
 if(reviewedGrantees.length!==config.reviewedConnectRoles.length)throw Error('reviewed_connect_role_missing')
 const memberships=(await client.query(`SELECT roleid::text,member::text,grantor::text,admin_option FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid ORDER BY roleid,member,grantor`,[role.oid])).rows
 if(memberships.length)throw Error('old_memory_role_has_memberships')
 const externalDependencies=(await client.query(`SELECT dbid::text,classid::text,objid::text,objsubid::text,deptype FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1::oid AND NOT(dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) OR dbid=0 AND classid='pg_database'::regclass AND objid=(SELECT oid FROM pg_database WHERE datname=current_database())) ORDER BY dbid,classid,objid,objsubid`,[role.oid])).rows
 if(externalDependencies.length)throw Error('old_memory_role_cross_database_effects')
 if((await client.query('SELECT 1 FROM pg_stat_activity WHERE usesysid=$1::oid AND datname<>current_database() LIMIT 1',[role.oid])).rowCount)throw Error('old_memory_role_cross_database_backend')
 if((await client.query("SELECT 1 FROM pg_roles r,pg_database d WHERE d.datname=current_database() AND r.rolcanlogin AND NOT r.rolsuper AND r.rolname<>$1 AND NOT(r.rolname=ANY($2::text[])) AND pg_has_role(r.oid,d.datdba,'USAGE') LIMIT 1",[config.database.expected.role,config.reviewedConnectRoles])).rowCount)throw Error('unknown_source_owner_role')
 const acl=(await client.query<Acl>(`SELECT a.grantor::text,a.grantee::text,a.privilege_type AS privilege,a.is_grantable AS grantable FROM pg_database d,LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable`)).rows
 const unknown=(await client.query(`SELECT 1 FROM pg_database d,LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname=current_database() AND a.privilege_type='CONNECT' AND a.grantee<>0 AND a.grantee<>d.datdba AND NOT(r.rolname=ANY($1::text[])) LIMIT 1`,[config.reviewedConnectRoles])).rowCount
 if(unknown)throw Error('unreviewed_source_connect_grantee')
 if((await client.query(`SELECT 1 FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname<>$1 AND has_database_privilege(oid,current_database(),'CONNECT') AND NOT(rolname=ANY($2::text[])) LIMIT 1`,[config.database.expected.role,config.reviewedConnectRoles])).rowCount){
  // PUBLIC is intentionally about to be revoked. Roles with only PUBLIC
  // connectivity are harmless only when they have no source privileges/dependencies.
  if((await client.query(`SELECT 1 FROM pg_roles r JOIN pg_shdepend d ON d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname<>$1 AND NOT(r.rolname=ANY($2::text[])) AND (d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) OR d.dbid=0 AND d.classid='pg_database'::regclass AND d.objid=(SELECT oid FROM pg_database WHERE datname=current_database())) LIMIT 1`,[config.database.expected.role,config.reviewedConnectRoles])).rowCount)throw Error('unknown_source_role')
 }
 const backends=(await client.query<Backend>(`SELECT pid::text,usesysid::text AS "roleOid",usename AS role,backend_start::text AS "backendStart",md5(application_name) AS application,client_addr::text AS "clientAddress",state,xact_start::text AS "xactStart",backend_type AS "backendType" FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid LIMIT 257`)).rows
 if(backends.length>256)throw Error('source_backend_scope_limit')
 for(const b of backends)if(b.roleOid!==role.oid)throw Error('unknown_source_peer');else if(b.state!=='idle'||b.xactStart!==null||b.backendType!=='client backend')throw Error('active_source_backend')
 return {identity,role,reviewedGrantees,acl,memberships,externalDependencies,backends}
}
export async function planSourceFence(config:SourceFenceConfig,options:SourceFenceOptions={}):Promise<SourceFenceManifest>{
 checkConfig(config);const evidence=await drain(config,options),db=await connectMaintenance(config.database,true)
 try{const crossDatabaseReview=await inspectCrossDatabaseCapabilities(db.client,config.database,config.oldMemoryRole,options.signal);await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const state=await sourceState(db.client,db.identity,config);checkAbort(options);return seal({schemaVersion:2 as const,crossDatabaseReview,kind:'memory-source-fence' as const,configHash:configHash(config),...state,drain:evidence})}finally{await db.client.query('ROLLBACK').catch(()=>{});await db.close()}
}
function assertBound(config:SourceFenceConfig,manifest:SourceFenceManifest){checkConfig(config);assertManifest(manifest,'memory-source-fence',2);if(manifest.configHash!==configHash(config))throw Error('source_fence_config_drift')}
function checkState(state:SourceState,manifest:SourceFenceManifest){
 const expectedRole={...manifest.role,login:state.role.login}
 if(!manifest.role.login&&state.role.login||hash(expectedRole)!==hash(state.role)||state.identity!==manifest.identity)throw Error('source_fence_role_drift')
 if(hash(state.reviewedGrantees)!==hash(manifest.reviewedGrantees))throw Error('source_fence_grantee_drift')
 const revoked=new Set(['0',...manifest.reviewedGrantees.map(r=>r.oid)])
 const finalAcl=manifest.acl.filter(a=>!(a.privilege==='CONNECT'&&revoked.has(a.grantee)))
 if(hash(state.acl)!==hash(manifest.acl)&&hash(state.acl)!==hash(finalAcl))throw Error('source_fence_acl_drift')
 for(const b of state.backends)if(!manifest.backends.some(p=>hash(p)===hash(b)))throw Error('source_fence_backend_drift')
}
export async function applySourceFence(config:SourceFenceConfig,manifest:SourceFenceManifest,options:SourceFenceOptions={}){
 if(options.drainTimeoutMs!==undefined&&(!Number.isSafeInteger(options.drainTimeoutMs)||options.drainTimeoutMs<1||options.drainTimeoutMs>5000))throw Error('invalid_maintenance_timeout')
 assertBound(config,manifest);let evidence=await drain(config,options),db=await connectMaintenance(config.database,false)
 try{
  const proof=await inspectCrossDatabaseCapabilities(db.client,config.database,config.oldMemoryRole,options.signal);if(hash(proof)!==hash(manifest.crossDatabaseReview))throw Error('source_cross_database_review_drift')
  evidence=await drain(config,options)
  await db.client.query('BEGIN');await db.client.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-source-fence-v1',0))")
  const state=await sourceState(db.client,db.identity,config);checkState(state,manifest);validateDrainEvidence(config.units,evidence);checkAbort(options)
  await db.client.query('ALTER ROLE '+qi(config.oldMemoryRole)+' NOLOGIN')
  await db.client.query('REVOKE CONNECT ON DATABASE '+qi(config.database.expected.database)+' FROM PUBLIC')
  for(const name of config.reviewedConnectRoles)await db.client.query('REVOKE CONNECT ON DATABASE '+qi(config.database.expected.database)+' FROM '+qi(name))
  checkAbort(options);await db.client.query('COMMIT')
  // NOLOGIN and ACL changes must commit before the exact reviewed idle drain.
  // Cancellation here leaves the source restrictive; resume never restores LOGIN.
  const deadline=Date.now()+Math.min(5000,Math.max(1,options.drainTimeoutMs??5000))
  while(true){
   checkAbort(options);const current=await sourceState(db.client,db.identity,config);checkState(current,manifest)
   if(!current.backends.length)break
   if(Date.now()>=deadline)throw Error('source_backend_drain_timeout')
   for(const b of current.backends){checkAbort(options);await db.client.query(`SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a WHERE a.pid=$1::int AND a.usesysid=$2::oid AND a.backend_start::text=$3 AND a.state='idle' AND a.xact_start IS NULL`,[b.pid,b.roleOid,b.backendStart])}
   await new Promise(r=>setTimeout(r,20))
  }
  await assertFrozenMemorySource(db.client)
  return {schemaVersion:1,kind:'memory-source-fence-receipt',manifestHash:manifest.manifestHash,identity:db.identity,sourceFrozen:true,activationAuthorized:false,backupCreated:false,rollbackSupported:false}
 }catch(e){await db.client.query('ROLLBACK').catch(()=>{});throw e}finally{await db.close()}
}
export async function verifySourceFence(config:SourceFenceConfig,manifest:SourceFenceManifest,options:SourceFenceOptions={}){
 assertBound(config,manifest);await drain(config,options);const db=await connectMaintenance(config.database,true)
 try{if(hash(await inspectCrossDatabaseCapabilities(db.client,config.database,config.oldMemoryRole,options.signal))!==hash(manifest.crossDatabaseReview))throw Error('source_cross_database_review_drift');const state=await sourceState(db.client,db.identity,config);checkState(state,manifest);if(state.role.login)throw Error('source_role_still_login');await assertFrozenMemorySource(db.client);checkAbort(options);return {schemaVersion:1,kind:'memory-source-fence-verification',manifestHash:manifest.manifestHash,sourceFrozen:true,activationAuthorized:false}}finally{await db.close()}
}
