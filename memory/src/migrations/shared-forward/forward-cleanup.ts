import {bindLinkedPolicyOutputs} from './forward-cleanup-linked.js'
import {assertCleanupDependencyExclusions,discoverCleanupDependencies,cleanupState,type CleanupDependencies,type CleanupTableState} from './forward-cleanup-state.js'
import type pg from 'pg'
import {createPurgeRepository,invalidateDerivedEpisodes} from '../../purge/repository.js'
import {connectMaintenance,hash,qi,seal,assertManifest} from './source-maintenance-common.js'
import {assertPrivacyTargetClosed,assertPrivacyOverlayBarriers,lockPrivacyMetadata,readPrivacyFacts,type PrivacyOverlayConfig,type PrivacyOverlayManifest,type OverlayOptions} from './privacy-overlay.js'
import {probeSystemdDrain,validateDrainEvidence} from './source-fence.js'

/** Conservative admission for the existing repository's non-paginated policy
 * closure. Each admitted object is one bounded page; larger stores are refused.
 * No row bodies, excerpts, key material or database credentials leave SQL. */
export interface ForwardCleanupConfig extends PrivacyOverlayConfig {tombstoneHmacKeys:readonly {version:string;key:string}[]}
type TableState=CleanupTableState
type Step={kind:'session';installationId:string;sessionId:string;reason:string}|{kind:'configuration';installationId:string}|{kind:'membership';installationId:string;membershipId:string}|{kind:'scope';installationId:string}
export interface ForwardCleanupManifest {schemaVersion:1|2|3;kind:'memory-forward-privacy-cleanup';identity:string;configHash:string;overlay:PrivacyOverlayManifest;authorityHash:string;initialState:TableState[];dependencies:CleanupDependencies;steps:Step[];blockers:string[];manifestHash:string}
export interface ForwardCleanupOptions extends OverlayOptions {/** Test/embedding observation only, always AFTER COMMIT. */ afterCommit?:(step:number)=>Promise<void>}
const receiptTable='shared.memory_forward_cleanup_steps'
const columns=[['plan_hash','text'],['step','bigint'],['object_hash','text'],['before_hash','text'],['after_hash','text'],['completed_at','timestamp with time zone']]
function configBinding(config:ForwardCleanupConfig){
 if(!config.tombstoneHmacKeys?.length||config.tombstoneHmacKeys.length>16||config.tombstoneHmacKeys.some(k=>!k.version||!k.key)||new Set(config.tombstoneHmacKeys.map(k=>k.version)).size!==config.tombstoneHmacKeys.length)throw Error('cleanup_trusted_tombstone_keyring_required')
 return hash({expected:config.database.expected,installationIds:[...config.installationIds].sort(),units:config.units,keys:config.tombstoneHmacKeys.map(k=>({version:k.version,fingerprint:hash(k.key)}))})
}
function stepsFor(overlay:PrivacyOverlayManifest):Step[]{
 return [...overlay.sessions.map(s=>({kind:'session' as const,...s})),...[...new Set([...overlay.scopeBarriers.map(s=>s.installationId),...overlay.installations.filter(i=>i.reason==='scope_changed').map(i=>i.installationId)])].map(installationId=>({kind:'scope' as const,installationId})),...[...new Set([...overlay.installations.map(i=>i.installationId),...overlay.scopeBarriers.map(s=>s.installationId),...overlay.memberBarriers.map(m=>m.installationId)])].map(installationId=>({kind:'configuration' as const,installationId})),...overlay.memberBarriers.map(m=>({kind:'membership' as const,...m}))]
}
function bound(config:ForwardCleanupConfig,p:ForwardCleanupManifest){
 if(p.dependencies?.linked&&![2,3].includes(p.dependencies.linked.version))throw Error('cleanup_linked_manifest_version_unsupported')
 if(p.dependencies?.linked?.version===3&&p.dependencies.linked.exactSources?.version!==2||p.dependencies?.linked?.version===2&&p.dependencies.linked.exactSources)throw Error('cleanup_exact_source_policy_version_unsupported')
 assertManifest(p,'memory-forward-privacy-cleanup',p.dependencies?.linked?.version??1);assertManifest(p.overlay,'memory-current-privacy-overlay',2)
 if(hash(p.dependencies.roots)!==hash(p.overlay.sessions)||hash(p.dependencies.installationIds)!==hash(config.installationIds)||hash(p.dependencies.broadIds)!==hash([...new Set(p.steps.filter(s=>s.kind!=='session').map(s=>s.installationId))]))throw Error('cleanup_dependency_scope_drift')
 if(configBinding(config)!==p.configHash||p.overlay.configHash!==hash({expected:config.database.expected,installationIds:[...config.installationIds].sort(),units:config.units})||p.identity!==p.overlay.identity||p.authorityHash!==p.overlay.currentFactsHash||hash(p.steps)!==hash(stepsFor(p.overlay))||p.steps.some(s=>!config.installationIds.includes(s.installationId)))throw Error('cleanup_scope_drift')
}

async function drain(config:ForwardCleanupConfig,options:OverlayOptions){if(options.signal?.aborted)throw Error('maintenance_interrupted');const evidence=await(options.probe??probeSystemdDrain)(config.units);validateDrainEvidence(config.units,evidence);if(options.signal?.aborted)throw Error('maintenance_interrupted')}
/** Every operation, including plan/verify, has the same ten second hard wall. */
async function window<T>(config:ForwardCleanupConfig,options:OverlayOptions,readOnly:boolean,body:(c:pg.Client,identity:string,check:()=>void)=>Promise<T>):Promise<T>{
 const ms=options.transactionTimeoutMs??10000
 if(!Number.isSafeInteger(ms)||ms<1||ms>10000)throw Error('invalid_maintenance_timeout')
 await drain(config,options);const db=await connectMaintenance(config.database,readOnly),deadline=Date.now()+ms
 const check=()=>{if(options.signal?.aborted)throw Error('maintenance_interrupted');if(Date.now()>=deadline)throw Error('cleanup_transaction_window_expired')}
 const cancel=()=>{void db.close().catch(()=>{})},timer=setTimeout(cancel,ms);options.signal?.addEventListener('abort',cancel,{once:true})
 try{await db.client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');check();const result=await body(db.client,db.identity,check);check();if(readOnly)await db.client.query('ROLLBACK');else await db.client.query('COMMIT');return result}
 catch(error){await db.client.query('ROLLBACK').catch(()=>{});check();throw error}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);await db.close()}
}
async function auditReceipts(c:pg.Client,required=false){
 const r=(await c.query(`SELECT c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)=current_user AS owned,
  NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee<>c.relowner) AS closed,
  NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid) AS no_triggers,
  NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS no_rules
  FROM pg_class c WHERE c.oid=to_regclass($1)`,[receiptTable])).rows[0]
 if(!r){if(required)throw Error('cleanup_checkpoint_missing');return false}
 const attrs=(await c.query(`SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,attgenerated,attidentity,atthasdef FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[receiptTable])).rows
 const constraints=(await c.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1)',[receiptTable])).rows
 if(r.relkind!=='r'||r.relrowsecurity||r.relforcerowsecurity||!r.owned||!r.closed||!r.no_triggers||!r.no_rules||hash(attrs.map(a=>[a.attname,a.type]))!==hash(columns)||attrs.some(a=>!a.attnotnull||a.attgenerated||a.attidentity||a.atthasdef)||constraints.length!==1||constraints[0].definition!=='PRIMARY KEY (plan_hash, step)')throw Error('cleanup_checkpoint_structure_or_acl_mismatch')
 return true
}
async function prepareReceipts(c:pg.Client){
 if(!await auditReceipts(c))await c.query(`CREATE TABLE ${receiptTable}(plan_hash text NOT NULL,step bigint NOT NULL,object_hash text NOT NULL,before_hash text NOT NULL,after_hash text NOT NULL,completed_at timestamptz NOT NULL,PRIMARY KEY(plan_hash,step));REVOKE ALL ON ${receiptTable} FROM PUBLIC`)
 await auditReceipts(c,true)
}
async function checkpoints(c:pg.Client,p:ForwardCleanupManifest){
 if(!await auditReceipts(c))return []
 const rows=(await c.query(`SELECT step::text,object_hash,before_hash,after_hash FROM ${receiptTable} WHERE plan_hash=$1 ORDER BY memory_forward_cleanup_steps.step LIMIT 4098`,[p.manifestHash])).rows
 if(rows.length>p.steps.length)throw Error('cleanup_checkpoint_drift')
 let prior=hash(p.initialState)
 for(let i=0;i<rows.length;i++){const r=rows[i];if(r.step!==String(i)||r.object_hash!==hash(p.steps[i])||r.before_hash!==prior||!/^[a-f0-9]{64}$/.test(r.after_hash))throw Error('cleanup_checkpoint_drift');prior=r.after_hash}
 return rows
}
async function authority(c:pg.Client,config:ForwardCleanupConfig,overlay:PrivacyOverlayManifest){
 await assertPrivacyTargetClosed(c)
 const current=(await c.query('SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[config.installationIds,[]])).rows
 if(current.length!==config.installationIds.length||current.some(r=>!r.state.owner_exists||typeof r.state.provider_enabled!=='boolean'||!['pending','active','paused','revoking','revoked'].includes(r.state.status)||!['personal','team','organization'].includes(r.state.owner_scope_kind)||!['active','suspended','dissolving','dissolved'].includes(r.state.scope_state)||!/^([1-9][0-9]*)$/.test(r.state.authorization_epoch??'')||r.state.owner_scope_kind==='team'&&!['active','suspended','dissolving','dissolved'].includes(r.state.parent_state)))throw Error('cleanup_current_authority_unknown')
 const capsules=overlay.retainedClosure.capsules as {capsule_id:string}[]
 const retained=(await c.query("SELECT installation_id::text,capsule_id::text,version_id::text,retention_basis,xmin::text AS row_version,encode(source_content_hash,'hex') AS source_content_hash FROM memory.knowledge_evidence_capsules WHERE capsule_id=ANY($1::uuid[]) ORDER BY installation_id,capsule_id",[capsules.map(r=>r.capsule_id)])).rows
 if(hash(retained)!==hash(capsules))throw Error('cleanup_independent_capsule_drift')
 const facts=await readPrivacyFacts(c,config,overlay.retainedClosure)
 if(facts.retainedClosure.unresolved.length||facts.teamAuthority.some(a=>a.state==='unproven'))throw Error('cleanup_original_authority_unproven')
 return facts.currentFactsHash
}
async function remainingBarriers(c:pg.Client,p:ForwardCleanupManifest,completed:number){
 const members=new Set(p.steps.slice(0,completed).filter((s):s is Extract<Step,{kind:'membership'}>=>s.kind==='membership').map(s=>s.installationId+':'+s.membershipId))
 await assertPrivacyOverlayBarriers(c,{...p.overlay,memberBarriers:p.overlay.memberBarriers.filter(m=>!members.has(m.installationId+':'+m.membershipId))})
}
async function configuration(c:pg.Client,id:string,apply:boolean){
 const local=(await c.query('SELECT i.local_status,i.config_version::text,o.owner_scope_kind,o.owner_scope_id::text,o.parent_organization_id::text FROM memory.memory_installations i JOIN memory.memory_owner_scopes o USING(installation_id) WHERE i.installation_id=$1',[id])).rows[0]
 const trusted=(await c.query(`SELECT i.status,i.config_version::text,i.owner_scope_kind,i.owner_scope_id::text,to_jsonb(i.granted_scopes) AS granted_scopes,to_jsonb(i.subscriptions) AS subscriptions,to_jsonb(i.enabled_services) AS enabled_services,i.event_filter,t.organization_id::text AS parent_organization_id FROM public.extension_installations i LEFT JOIN public.extension_teams t ON i.owner_scope_kind='team' AND t.team_id=i.owner_scope_id WHERE i.installation_id=$1 AND i.provider_id='pocketctl-memory'`,[id])).rows[0]
 if(!local||!trusted||['purging','purged'].includes(local.local_status))throw Error('cleanup_installation_terminal_or_unknown')
 if(local.owner_scope_kind!==trusted.owner_scope_kind||local.owner_scope_id!==trusted.owner_scope_id||local.parent_organization_id!==trusted.parent_organization_id)throw Error('cleanup_owner_transfer_unsupported')
 if(!/^[1-9][0-9]*$/.test(local.config_version)||!/^[1-9][0-9]*$/.test(trusted.config_version)||BigInt(trusted.config_version)<BigInt(local.config_version))throw Error('cleanup_configuration_version_regression')
 if(!apply)return
 await c.query(`UPDATE memory.memory_installations SET relay_status=$2,config_version=$3::bigint,granted_scopes=$4::jsonb,subscriptions=$5::jsonb,enabled_services=$6::jsonb,event_filter=$7::jsonb,updated_at=clock_timestamp() WHERE installation_id=$1`,[id,trusted.status,trusted.config_version,JSON.stringify(trusted.granted_scopes),JSON.stringify(trusted.subscriptions),JSON.stringify(trusted.enabled_services),JSON.stringify(trusted.event_filter)])
}
async function configurationVersions(c:pg.Client,p:ForwardCleanupManifest){
 for(const step of p.steps)if(step.kind==='configuration')await configuration(c,step.installationId,false)
}
async function membership(c:pg.Client,step:Extract<Step,{kind:'membership'}>){
 const states=(await c.query('SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[step.installationId],[step.membershipId]])).rows
 const current=states.find(r=>r.state.membership_id===step.membershipId)?.state??states.find(r=>r.state.membership_id===null)?.state
 if(!current)throw Error('cleanup_membership_authority_unknown')
 // Same policy as the mature scope-control projector: retain owned accepted
 // knowledge, advance exact membership metadata, close revoked validity. The
 // existing database invalidation triggers enforce dependent consumption.
 const active=current.member_exists&&current.membership_state==='active'
 const local=(await c.query('SELECT membership_revision::text FROM memory.memory_scope_memberships WHERE installation_id=$1 AND membership_id=$2',[step.installationId,step.membershipId])).rows[0]
 if(!local||current.membership_revision&&BigInt(current.membership_revision)<BigInt(local.membership_revision))throw Error('cleanup_membership_revision_regression')
 await c.query(`UPDATE memory.memory_scope_memberships SET roles=$3::text[],state=$4,membership_revision=GREATEST(membership_revision,$5::bigint),valid_until=CASE WHEN $4='active' THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp() WHERE installation_id=$1 AND membership_id=$2`,[step.installationId,step.membershipId,current.roles??[],active?'active':current.member_exists&&['invited','suspended','revoked'].includes(current.membership_state)?current.membership_state:'revoked',current.membership_revision??local.membership_revision])
}
async function scopeMetadata(c:pg.Client,id:string){
 const states=(await c.query('SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[id],[]])).rows
 const current=states[0]?.state
 const local=(await c.query('SELECT owner_scope_kind,owner_scope_id::text,parent_organization_id::text,authorization_epoch::text FROM memory.memory_owner_scopes WHERE installation_id=$1',[id])).rows[0]
 if(!current||!local||!current.owner_exists||local.owner_scope_kind!==current.owner_scope_kind||local.owner_scope_id!==current.owner_scope_id||BigInt(current.authorization_epoch)<BigInt(local.authorization_epoch)||!['active','suspended','dissolving','dissolved'].includes(current.scope_state))throw Error('cleanup_scope_authority_unsupported')
 // The same lifecycle mirror policy as scope-control: advance the epoch/state;
 // retain the irreversible tombstone and independently owned accepted content.
 await c.query('UPDATE memory.memory_owner_scopes SET state=$2,authorization_epoch=$3::bigint,updated_at=clock_timestamp() WHERE installation_id=$1',[id,current.scope_state,current.authorization_epoch])
}
async function requireScopeInvalidationPolicy(c:pg.Client){
 const required=['memory_skill_scope_invalidated','memory_skill_member_invalidated','memory_git_scope_changed','memory_git_member_changed','memory_git_cancel_member']
 const installed=(await c.query("SELECT tgname FROM pg_trigger WHERE tgrelid IN('memory.memory_owner_scopes'::regclass,'memory.memory_scope_memberships'::regclass) AND NOT tgisinternal AND tgenabled IN('O','A')")).rows.map(r=>r.tgname)
 if(required.some(name=>!installed.includes(name)))throw Error('cleanup_scope_invalidation_policy_missing')
}
function sessionPolicyClient(c:pg.Client,dependencies:CleanupDependencies){
 const linked=dependencies.linked
 const allowed=new Set(['memory_session_tombstones','memory_skill_replay_runs','memory_feedback','memory_generation_runs','memory_context_packs','memory_task_bundles','memory_source_processing_receipts','memory_session_scene_frames','memory_candidates','memory_extraction_runs','work_episodes','source_artifacts','source_turns','source_events','memory_snapshot_events','memory_source_retention_receipts','memory_feed_inbox','source_sessions'])
 if(linked)for(const table of ['knowledge_tombstones','knowledge_claims','knowledge_versions','knowledge_evidence','memory_jobs'])allowed.add(table)
 return {query:(text:string,values?:unknown[])=>{
  const mutation=/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:memory\.)?([a-z_]+)/i.exec(text)
  if(mutation&&!allowed.has(mutation[1]))throw Error('cleanup_unreviewed_session_policy_mutation')
  if(linked&&mutation){
   if(mutation[1]==='knowledge_tombstones'&&!linked.tombstones.some(r=>r.installation_id===values?.[0]&&r.key_id===values?.[1]&&r.identity_hmac==='\\x'+(values?.[2] as Buffer).toString('hex')))throw Error('cleanup_unreviewed_tombstone_output')
   if(mutation[1]==='memory_jobs'&&!linked.jobKeys.includes(String(values?.[1])))throw Error('cleanup_unreviewed_reindex_output')
   if(mutation[1]==='knowledge_claims'&&!linked.claimIds.includes(String(values?.[1])))throw Error('cleanup_unreviewed_claim_mutation')
   if(mutation[1]==='knowledge_versions'&&!linked.versionIds.includes(String(values?.[1]))&&!linked.claimIds.includes(String(values?.[1])))throw Error('cleanup_unreviewed_version_mutation')
  }
  return c.query(text,values)
 }} as Pick<pg.PoolClient,'query'>
}
function protectedState(s:TableState[]){return s.filter(t=>/budget|attempt|consent|policy|settings|capsule/.test(t.table))}
export async function planForwardCleanup(config:ForwardCleanupConfig,overlay:PrivacyOverlayManifest,options:ForwardCleanupOptions={}):Promise<ForwardCleanupManifest>{
 assertManifest(overlay,'memory-current-privacy-overlay',2);const configHash=configBinding(config)
 // Validate the overlay's installation/unit binding without mutating its plan.
 if(overlay.configHash!==hash({expected:config.database.expected,installationIds:[...config.installationIds].sort(),units:config.units}))throw Error('cleanup_overlay_scope_drift')
 return window(config,options,true,async(c,identity,check)=>{
  if(identity!==overlay.identity)throw Error('cleanup_target_identity_drift')
  await auditReceipts(c);await assertPrivacyOverlayBarriers(c,overlay);const authorityHash=await authority(c,config,overlay),steps:Step[]=overlay.sessions.map(s=>({kind:'session',...s})),blockers:string[]=[]
  if((await readPrivacyFacts(c,config)).currentFactsHash!==overlay.currentFactsHash||authorityHash!==overlay.currentFactsHash)throw Error('cleanup_overlay_facts_drift')
  for(const id of [...new Set([...overlay.scopeBarriers.map(s=>s.installationId),...overlay.installations.filter(i=>i.reason==='scope_changed').map(i=>i.installationId)])])steps.push({kind:'scope',installationId:id})
  for(const session of overlay.sessions)if(overlay.teamAuthority.some(a=>a.installationId===session.installationId&&a.root===session.sessionId&&a.state==='current'))throw Error('cleanup_mixed_team_root_requires_exact_uuid_adapter')
  for(const revoked of overlay.teamAuthority.filter(a=>a.state!=='current')){
   if(overlay.teamAuthority.some(a=>a.installationId===revoked.installationId&&a.root===revoked.root&&a.state==='current'))throw Error('cleanup_mixed_team_root_requires_exact_uuid_adapter')
   if(!overlay.sessions.some(s=>s.installationId===revoked.installationId&&s.sessionId===revoked.root))blockers.push('exact_team_source_cleanup_requires_uuid_adapter')
  }
  if(overlay.installations.some(i=>i.reason==='installation_revoked'))blockers.push('revoked_installation_retention_requires_reviewed_policy_adapter')
  for(const id of [...new Set([...overlay.installations.map(i=>i.installationId),...overlay.scopeBarriers.map(s=>s.installationId),...overlay.memberBarriers.map(m=>m.installationId)])]){await configuration(c,id,false);steps.push({kind:'configuration',installationId:id})}
  for(const m of overlay.memberBarriers)steps.push({kind:'membership',...m})
  if(overlay.memberBarriers.length||overlay.scopeBarriers.length)await requireScopeInvalidationPolicy(c)
  const dependencies=await discoverCleanupDependencies(c,overlay.sessions,config.installationIds,[...new Set(steps.filter(s=>s.kind!=='session').map(s=>s.installationId))])
  if(dependencies.linked)await bindLinkedPolicyOutputs(c,dependencies.linked,dependencies,config.tombstoneHmacKeys)
  const initialState=await cleanupState(c,dependencies)
  if(steps.length>4096)throw Error('cleanup_object_limit');check()
  return seal({schemaVersion:dependencies.linked?.version??1 as const,kind:'memory-forward-privacy-cleanup' as const,identity,configHash,overlay,authorityHash,initialState,dependencies,steps,blockers})
 })
}
function receipt(p:ForwardCleanupManifest,completed:number,extra:string[]=[]){const blockers=[...p.blockers,...extra,...(completed<p.steps.length?['cleanup_steps_pending']:[])];return {schemaVersion:1,kind:'memory-forward-privacy-cleanup-verification',manifestHash:p.manifestHash,completedObjects:completed,totalObjects:p.steps.length,privacyCatchupReadyForReopen:blockers.length===0,reopeningReady:false,activationAuthorized:false,backupCreated:false,rollbackSupported:false,scopeRetentionPolicy:'existing_scope_control_retains_independent_accepted_ownership',reopenBlockers:['activation_and_business_acceptance_separate',...blockers]}}
export async function applyForwardCleanup(config:ForwardCleanupConfig,p:ForwardCleanupManifest,options:ForwardCleanupOptions={}){
 bound(config,p)
 // Receipt DDL is an explicit administrator apply operation only. This is a
 // separate short transaction; no partial user data work precedes readiness.
 await window(config,options,false,async(c,identity)=>{if(identity!==p.identity)throw Error('cleanup_target_identity_drift');await lockPrivacyMetadata(c);if(await authority(c,config,p.overlay)!==p.authorityHash)throw Error('cleanup_authority_drift');await configurationVersions(c,p);await assertCleanupDependencyExclusions(c,p.dependencies,true);await prepareReceipts(c)})
 for(let index=0;index<p.steps.length;index++){
  const committed=await window(config,options,false,async(c,identity,check)=>{
   if(identity!==p.identity)throw Error('cleanup_target_identity_drift')
   await lockPrivacyMetadata(c);await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('memory-forward-cleanup:'||$1,0))`,[p.manifestHash])
   if(await authority(c,config,p.overlay)!==p.authorityHash)throw Error('cleanup_authority_drift')
   await configurationVersions(c,p);await assertCleanupDependencyExclusions(c,p.dependencies,true)
   const before=await cleanupState(c,p.dependencies,true),done=await checkpoints(c,p),expected=done.at(-1)?.after_hash??hash(p.initialState)
   await remainingBarriers(c,p,done.length)
   if(hash(before)!==expected)throw Error('cleanup_dependency_drift')
   if(index<done.length)return false
   if(index!==done.length)throw Error('cleanup_checkpoint_drift')
   const step=p.steps[index]
   if(step.kind==='membership'||step.kind==='scope')await requireScopeInvalidationPolicy(c)
   await c.query('SET LOCAL search_path=memory,pg_catalog')
   if(step.kind==='session'&&p.dependencies.linked?.exactSources){
    // Execute the frozen cross-Session closure exactly once, before the first
    // raw Session step. A durable prefix skips this branch on resume.
    if(index===0)for(const id of p.dependencies.installationIds)await invalidateDerivedEpisodes(sessionPolicyClient(c,p.dependencies),{installationId:id,episodeIds:p.dependencies.linked.exactSources.episodeIds},config.tombstoneHmacKeys)
   }
   if(step.kind==='session')await createPurgeRepository({} as pg.Pool,{hmacKey:config.tombstoneHmacKeys[0].key,tombstoneHmacKeys:config.tombstoneHmacKeys}).purgeSession({...step,sourceFeedId:null},sessionPolicyClient(c,p.dependencies))
   else if(step.kind==='configuration')await configuration(c,step.installationId,true)
   else if(step.kind==='membership')await membership(c,step)
   else await scopeMetadata(c,step.installationId)
   const after=await cleanupState(c,p.dependencies)
   if(hash(protectedState(before))!==hash(protectedState(after)))throw Error('cleanup_protected_policy_or_incurred_state_changed')
   if(await authority(c,config,p.overlay)!==p.authorityHash)throw Error('cleanup_authority_drift');check()
   await c.query(`INSERT INTO ${receiptTable}(plan_hash,step,object_hash,before_hash,after_hash,completed_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())`,[p.manifestHash,index,hash(step),hash(before),hash(after)])
   return true
  })
  if(committed)await options.afterCommit?.(index)
 }
 return verifyForwardCleanup(config,p,options)
}
/** Resume is intentionally the exact same operation and immutable manifest. */
export const resumeForwardCleanup=applyForwardCleanup
export async function verifyForwardCleanup(config:ForwardCleanupConfig,p:ForwardCleanupManifest,options:ForwardCleanupOptions={}){
 bound(config,p)
 return window(config,options,true,async(c,identity,check)=>{
  if(identity!==p.identity)throw Error('cleanup_target_identity_drift')
  if(await authority(c,config,p.overlay)!==p.authorityHash)throw Error('cleanup_authority_drift')
  await configurationVersions(c,p);await assertCleanupDependencyExclusions(c,p.dependencies)
  const done=await checkpoints(c,p),current=await cleanupState(c,p.dependencies)
  await remainingBarriers(c,p,done.length)
  if(hash(current)!==(done.at(-1)?.after_hash??hash(p.initialState)))throw Error('cleanup_dependency_drift')
  if(p.steps.some(s=>s.kind==='membership'||s.kind==='scope'))await requireScopeInvalidationPolicy(c)
  const remaining:string[]=[]
  for(const step of p.steps)if(step.kind==='session'){
   // Rows can retain a minimal source_sessions tombstone. Bodies and original
   // derived source rows must actually be gone, including canonical aliases.
   if((await c.query('SELECT 1 FROM memory.source_sessions WHERE installation_id=$1 AND session_id=$2 AND(deleted_at IS NULL OR agent_type IS NOT NULL OR daemon_id IS NOT NULL OR status IS NOT NULL OR cwd_observation IS NOT NULL OR worktree_path IS NOT NULL OR worktree_branch IS NOT NULL) LIMIT 1',[step.installationId,step.sessionId])).rowCount)remaining.push('session_metadata_cleanup_incomplete')
   for(const table of ['source_events','source_artifacts','source_turns','work_episodes','memory_task_bundles','memory_context_packs','memory_feed_inbox']){
    const canonical=table==='source_events'?' OR canonical_session_key=$2':''
    if((await c.query(`SELECT 1 FROM memory.${qi(table)} WHERE installation_id=$1 AND(session_id=$2${canonical}) LIMIT 1`,[step.installationId,step.sessionId])).rowCount)remaining.push('session_physical_cleanup_incomplete')
   }
  }
  check();return receipt(p,done.length,[...new Set(remaining)])
 })
}
