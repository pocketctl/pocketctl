import type pg from 'pg'
import {collectPersonalDirectClosure,type PersonalDirectClosure,type PersonalDirectClosureScope} from './personal-direct-closure.js'
import {readPrivacyFacts,assertPrivacyTargetClosed,lockPrivacyMetadata,type PrivacyOverlayConfig,type PrivacyOverlayManifest} from './privacy-overlay.js'
import {retainedReferenceRoster} from './source-reference-contract.js'
import {connectMaintenance,hash,seal,assertManifest,qi} from './source-maintenance-common.js'
import {probeSystemdDrain,validateDrainEvidence,type DrainEvidence,type MemoryUnits} from './source-fence.js'
export interface PersonalDirectPrivacyConfig extends PrivacyOverlayConfig {scope:PersonalDirectClosureScope}
interface Options {signal?:AbortSignal;probe?:(units:MemoryUnits)=>Promise<DrainEvidence>;beforeCommit?:()=>Promise<void>}
function check(options:Options){if(options.signal?.aborted)throw Error('personal_direct_interrupted')}
function binding(config:PersonalDirectPrivacyConfig){
 const ids=[config.scope.personalInstallationId,config.scope.organizationInstallationId]
 if(config.installationIds.length!==2||new Set(ids).size!==2||hash([...config.installationIds].sort())!==hash([...ids].sort()))throw Error('personal_direct_scope_invalid')
 return hash({scope:config.scope,expected:config.database.expected,units:config.units})
}
async function drained(config:PersonalDirectPrivacyConfig,options:Options){check(options);const evidence=await (options.probe??probeSystemdDrain)(config.units);validateDrainEvidence(config.units,evidence);return evidence}
const memoryTables=[...new Set([...retainedReferenceRoster().map(p=>p.split('.')[0]),'memory_installations','memory_owner_scopes','memory_scope_memberships','source_events','source_sessions','source_artifacts','work_episodes','memory_task_bundles','memory_context_packs','knowledge_evidence','knowledge_evidence_capsules','memory_session_tombstones'])].sort()
async function lockMemory(c:pg.Client){await c.query('LOCK TABLE '+memoryTables.map(t=>'memory.'+qi(t)).join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT')}
interface Restriction {installationId:string;sessionId:string;reason:'user_deleted'|'access_revoked';sources:string;has_derived_dependencies:boolean}
interface Review {closure:PersonalDirectClosure;state:Omit<PrivacyOverlayManifest,'schemaVersion'|'kind'|'identity'|'configHash'|'manifestHash'>;sessions:PrivacyOverlayManifest['sessions'];restrictions:Restriction[];canonicalAbsenceProven:false;deletionAuthorized:false}
async function review(c:pg.Client,config:PersonalDirectPrivacyConfig,options:Options,frozenClosure?:PersonalDirectClosure):Promise<Review>{
 const closure=frozenClosure??await collectPersonalDirectClosure(c,config.scope,options)
 const missing=(await c.query(`SELECT root."installationId",root."sessionId" FROM jsonb_to_recordset($1::jsonb) root("installationId" uuid,"sessionId" text)
  WHERE NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.session_id=root."sessionId") AND NOT EXISTS(SELECT 1 FROM public.deleted_sessions d WHERE d.session_id=root."sessionId") ORDER BY 1,2`,[JSON.stringify(closure.roots)])).rows as {installationId:string;sessionId:string}[]
 const absent=new Set(missing.map(r=>r.installationId+':'+r.sessionId))
 // Missing current authority only adds a local denial. Its original source
 // cells survive; it is neither a canonical absence nor deletion proof.
 const reviewedClosure={...closure,roots:closure.roots.filter(r=>!absent.has(r.installationId+':'+r.sessionId)),fingerprint:hash({closure:closure.fingerprint,retainDenied:missing})}
 const state=await readPrivacyFacts(c,config,reviewedClosure)
 if(state.installations.length||state.memberBarriers.length||state.scopeBarriers.length||state.withdrawals.length||state.teamAuthority.length)throw Error('personal_direct_current_control_repair_required')
 const sessions=[...state.sessions,...missing.map(r=>({...r,reason:'access_revoked' as const}))].sort((a,b)=>(a.installationId+':'+a.sessionId).localeCompare(b.installationId+':'+b.sessionId))
 const restrictions=(await c.query(`SELECT root."installationId",root."sessionId",root.reason,
  (SELECT count(*)::text FROM memory.source_events s WHERE s.installation_id=root."installationId" AND s.session_id=root."sessionId") AS sources,
  EXISTS(SELECT 1 FROM memory.source_artifacts a WHERE a.installation_id=root."installationId" AND a.session_id=root."sessionId") OR
  EXISTS(SELECT 1 FROM memory.work_episodes e WHERE e.installation_id=root."installationId" AND e.session_id=root."sessionId") OR
  EXISTS(SELECT 1 FROM memory.memory_task_bundles b WHERE b.installation_id=root."installationId" AND b.session_id=root."sessionId") OR
  EXISTS(SELECT 1 FROM memory.memory_context_packs p WHERE p.installation_id=root."installationId" AND p.session_id=root."sessionId") AS has_derived_dependencies
  FROM jsonb_to_recordset($1::jsonb) root("installationId" uuid,"sessionId" text,reason text) ORDER BY 1,2`,[JSON.stringify(sessions)])).rows as Restriction[]
 if(restrictions.some(r=>r.has_derived_dependencies||r.reason==='user_deleted'&&r.sources!=='0'))throw Error('personal_direct_restricted_dependency_repair_required')
 check(options);return {closure,state,sessions,restrictions,canonicalAbsenceProven:false as const,deletionAuthorized:false as const}
}
export interface PersonalDirectPrivacyManifest extends Review {schemaVersion:1;kind:'finite-personal-direct-privacy';identity:string;configHash:string;manifestHash:string}
function result(plan:PersonalDirectPrivacyManifest){return {schemaVersion:1,kind:'finite-personal-direct-privacy-verification',manifestHash:plan.manifestHash,roots:plan.closure.roots.length,restrictedRoots:plan.sessions.length,retainedOriginalSourceRows:plan.restrictions.filter(r=>r.reason==='access_revoked').reduce((n,r)=>n+BigInt(r.sources),0n).toString(),currentRestrictionsVerified:true,sourceBodiesChanged:false,deletionAuthorized:false,canonicalAbsenceProven:false,globalRetainedAuthorityVerified:false,reopeningReady:false,activationAuthorized:false}}
async function barriers(c:pg.Client,plan:PersonalDirectPrivacyManifest){
 if((await c.query(`SELECT 1 FROM jsonb_to_recordset($1::jsonb) root("installationId" uuid,"sessionId" text) WHERE NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones t WHERE t.installation_id=root."installationId" AND t.session_id=root."sessionId") LIMIT 1`,[JSON.stringify(plan.sessions)])).rowCount)throw Error('personal_direct_barrier_missing')
}
export async function planPersonalDirectPrivacy(config:PersonalDirectPrivacyConfig,options:Options={}):Promise<PersonalDirectPrivacyManifest>{
 const configHash=binding(config);await drained(config,options);const db=await connectMaintenance(config.database,true)
 try{await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertPrivacyTargetClosed(db.client);const facts=await review(db.client,config,options);return seal({schemaVersion:1 as const,kind:'finite-personal-direct-privacy' as const,identity:db.identity,configHash,...facts})}finally{await db.client.query('ROLLBACK').catch(()=>{});await db.close()}
}
export async function applyPersonalDirectPrivacy(config:PersonalDirectPrivacyConfig,plan:PersonalDirectPrivacyManifest,options:Options={}){
 assertManifest(plan,'finite-personal-direct-privacy');if(plan.configHash!==binding(config))throw Error('personal_direct_scope_drift')
 let evidence=await drained(config,options);const db=await connectMaintenance(config.database,false);let timer:ReturnType<typeof setTimeout>|undefined
 try{
  // Only closed Memory relations are held during the paged audit. Current
  // public controls are locked in the short final READ COMMITTED window.
  await db.client.query('BEGIN');await lockMemory(db.client);await assertPrivacyTargetClosed(db.client)
  const closure=await collectPersonalDirectClosure(db.client,config.scope,options)
  if(hash(closure)!==hash(plan.closure))throw Error('personal_direct_metadata_drift')
  await options.beforeCommit?.();check(options)
  // Real metadata auditing takes longer than the 15-second systemd evidence
  // lifetime. Reprobe after it; never extend that existing freshness limit.
  evidence=await drained(config,options)
  timer=setTimeout(()=>{void db.close().catch(()=>{})},10000)
  await lockPrivacyMetadata(db.client);await assertPrivacyTargetClosed(db.client)
  const facts=await review(db.client,config,{...options},closure)
  if(db.identity!==plan.identity||hash(facts)!==hash({closure:plan.closure,state:plan.state,sessions:plan.sessions,restrictions:plan.restrictions,canonicalAbsenceProven:false,deletionAuthorized:false}))throw Error('personal_direct_current_facts_drift')
  validateDrainEvidence(config.units,evidence);check(options)
  await db.client.query(`INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,source_feed_id,purged_at) SELECT root."installationId",root."sessionId",root.reason,NULL,clock_timestamp() FROM jsonb_to_recordset($1::jsonb) root("installationId" uuid,"sessionId" text,reason text) ON CONFLICT DO NOTHING`,[JSON.stringify(plan.sessions)])
  check(options);await barriers(db.client,plan);await db.client.query('COMMIT');return result(plan)
 }catch(e){await db.client.query('ROLLBACK').catch(()=>{});throw e}finally{if(timer)clearTimeout(timer);await db.close()}
}
export async function verifyPersonalDirectPrivacy(config:PersonalDirectPrivacyConfig,plan:PersonalDirectPrivacyManifest,options:Options={}){
 assertManifest(plan,'finite-personal-direct-privacy');if(plan.configHash!==binding(config))throw Error('personal_direct_scope_drift');await drained(config,options);const db=await connectMaintenance(config.database,true)
 try{await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertPrivacyTargetClosed(db.client);const facts=await review(db.client,config,options);if(db.identity!==plan.identity||hash(facts)!==hash({closure:plan.closure,state:plan.state,sessions:plan.sessions,restrictions:plan.restrictions,canonicalAbsenceProven:false,deletionAuthorized:false}))throw Error('personal_direct_current_facts_drift');await drained(config,options);await assertPrivacyTargetClosed(db.client);await barriers(db.client,plan);return result(plan)}finally{await db.client.query('ROLLBACK').catch(()=>{});await db.close()}
}
