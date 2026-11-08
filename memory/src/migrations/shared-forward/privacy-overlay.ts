import type pg from 'pg'
import {inspectTeamAuthority,type TeamAuthorityFact} from './source-maintenance-authority.js'
import {collectRetainedClosure,type RetainedClosure} from './source-maintenance-retained.js'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {connectMaintenance,hash,seal,assertManifest,type MaintenanceDatabase} from './source-maintenance-common.js'
import {probeSystemdDrain,validateDrainEvidence,type MemoryUnits,type DrainEvidence} from './source-fence.js'
export interface PrivacyOverlayConfig {database:MaintenanceDatabase;installationIds:string[];units:MemoryUnits}
export interface OverlayOptions {probe?:(units:MemoryUnits)=>Promise<DrainEvidence>;signal?:AbortSignal;transactionTimeoutMs?:number}
interface SessionBarrier {installationId:string;sessionId:string;reason:'user_deleted'|'access_revoked'}
interface Withdrawal {teamId:string;teamSessionId:string;submissionId:string;decisionId:string}
interface MemberBarrier {installationId:string;membershipId:string}
interface MemberState extends MemberBarrier {state:string}
interface ScopeBarrier {installationId:string;kind:string;scopeId:string;epoch:string}
interface InstallationBarrier {installationId:string;reason:'installation_revoked'|'authority_changed'|'membership_changed'|'scope_changed'}
export interface PrivacyOverlayManifest {schemaVersion:2;kind:'memory-current-privacy-overlay';identity:string;configHash:string;currentFactsHash:string;localFactsHash:string;retainedClosure:RetainedClosure;memberBarriers:MemberBarrier[];memberStates:MemberState[];scopeBarriers:ScopeBarrier[];teamAuthority:TeamAuthorityFact[];sessions:SessionBarrier[];withdrawals:Withdrawal[];installations:InstallationBarrier[];manifestHash:string}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function validateConfig(config:PrivacyOverlayConfig){if(!Array.isArray(config.installationIds)||!config.installationIds.length||config.installationIds.length>16||new Set(config.installationIds).size!==config.installationIds.length||config.installationIds.some(id=>!uuid.test(id)))throw Error('fixed_overlay_scope_required')}
const binding=(c:PrivacyOverlayConfig)=>hash({expected:c.database.expected,installationIds:[...c.installationIds].sort(),units:c.units})
function abort(options:OverlayOptions){if(options.signal?.aborted)throw Error('maintenance_interrupted')}
async function drain(config:PrivacyOverlayConfig,options:OverlayOptions){abort(options);const evidence=await (options.probe??probeSystemdDrain)(config.units);validateDrainEvidence(config.units,evidence);abort(options);return evidence}
export async function assertPrivacyTargetClosed(c:pg.Client){
 const contract=(await c.query('SELECT version,activation_ready FROM shared.memory_source_contract WHERE singleton')).rows
 if(contract.length!==1||contract[0].version!==1||contract[0].activation_ready!==false)throw Error('target_source_activation_open')
 if((await c.query("SELECT 1 FROM shared.memory_source_modes WHERE mode NOT IN('legacy-feed','paused') LIMIT 1")).rowCount)throw Error('target_source_mode_open')
 await assertTargetMemoryWritersFenced(c)
}
/** Only fixed metadata columns are selected. Canonical payloads, archives,
 * accepted evidence text, credentials and provider state never enter JS. */
export async function readPrivacyFacts(c:pg.Client,config:PrivacyOverlayConfig,frozenClosure?:RetainedClosure){
 const ids=config.installationIds,retainedClosure=frozenClosure??await collectRetainedClosure(c,config.installationIds)
 const local=(await c.query(`SELECT i.installation_id::text,i.config_version::text,i.relay_status,i.granted_scopes,i.subscriptions,i.enabled_services,i.event_filter,o.owner_scope_kind,o.owner_scope_id::text,o.parent_organization_id::text,o.state AS scope_state,o.authorization_epoch::text FROM memory.memory_installations i JOIN memory.memory_owner_scopes o USING(installation_id) WHERE i.installation_id=ANY($1::uuid[]) ORDER BY i.installation_id`,[ids])).rows
 if(local.length!==ids.length)throw Error('overlay_local_scope_unknown')
 const members=(await c.query(`SELECT installation_id::text,membership_id::text,roles,state,membership_revision::text FROM memory.memory_scope_memberships WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id,membership_id`,[ids])).rows
 if(members.length>16)throw Error('overlay_membership_scope_limit')
 const current=(await c.query('SELECT * FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[ids,members.map(m=>m.membership_id)])).rows
 if(ids.some(id=>!current.some(r=>r.installation_id===id)))throw Error('overlay_current_installation_unknown')
 const settings=(await c.query(`SELECT i.installation_id::text,i.granted_scopes,i.subscriptions,i.enabled_services,i.event_filter,t.organization_id::text AS parent_organization_id FROM public.extension_installations i LEFT JOIN public.extension_teams t ON i.owner_scope_kind='team' AND i.owner_scope_id=t.team_id WHERE i.provider_id='pocketctl-memory' AND i.installation_id=ANY($1::uuid[]) ORDER BY i.installation_id`,[ids])).rows
 const sessions=(await c.query(`SELECT s."installationId"::text AS installation_id,s."sessionId" AS session_id,i.owner_user_id::text AS owner_user_id,canonical.user_id::text AS canonical_owner,canonical.content_state,canonical.source,canonical.daemon_id,canonical.agent_type,daemon.user_id::text AS daemon_owner,
  EXISTS(SELECT 1 FROM public.deleted_sessions d WHERE d.session_id=s."sessionId") AS deleted,
  EXISTS(SELECT 1 FROM shared.memory_source_session_barriers b WHERE b.owner_user_id=i.owner_user_id AND b.session_id=s."sessionId") AS barrier,
  EXISTS(SELECT 1 FROM memory.source_events archive WHERE archive.installation_id=s."installationId" AND archive.canonical_session_key=s."sessionId" AND archive.source_kind='legacy_archive' AND archive.mapping_state='verified' AND archive.legacy_owner_user_id=i.owner_user_id AND archive.canonical_key=archive.source_event_id::text AND archive.legacy_manifest_hash IS NOT NULL AND archive.adapter_version='legacy-archive-v1' AND archive.origin IN('feed','snapshot') AND left(archive.session_id,5)<>'team_' AND NOT(archive.source_provenance ? 'team') AND NOT(archive.source_provenance ? 'accepted_delivery')) AS legacy_verified,
  delivery.team_id,delivery.team_session_id,delivery.submission_id::text,delivery.decision_id::text,delivery.revoked_at IS NOT NULL AS delivery_revoked,delivery.withdrawn_at IS NOT NULL AS delivery_withdrawn
  FROM jsonb_to_recordset($2::jsonb) s("installationId" uuid,"sessionId" text) JOIN public.extension_installations i ON i.installation_id=s."installationId"
  LEFT JOIN public.sessions canonical ON canonical.session_id=s."sessionId" LEFT JOIN public.daemons daemon ON daemon.daemon_id=canonical.daemon_id
  LEFT JOIN public.team_delivery_memory_sources delivery ON delivery.source_session_id=s."sessionId"
  WHERE s."installationId"=ANY($1::uuid[]) ORDER BY s."installationId",s."sessionId" LIMIT 4097`,[ids,JSON.stringify(retainedClosure.roots)])).rows
 if(sessions.length>4096)throw Error('overlay_session_scope_limit')
 // A withdrawal is global for this exact accepted-delivery identity. Limit it
 // to deliveries actually copied into the reviewed installations.
 const withdrawals=(await c.query(`SELECT DISTINCT w.team_id AS "teamId",w.team_session_id AS "teamSessionId",w.submission_id::text AS "submissionId",w.decision_id::text AS "decisionId"
  FROM (SELECT team_id,team_session_id,submission_id,decision_id FROM public.team_delivery_memory_withdrawals
    UNION SELECT d.team_id,d.team_session_id,d.submission_id,d.decision_id FROM public.team_delivery_memory_sources d WHERE d.withdrawn_at IS NOT NULL
    UNION SELECT d.team_id,d.team_session_id,d.submission_id,d.decision_id FROM public.team_delivery_memory_sources d JOIN public.team_artifact_revocations a USING(submission_id)) w
  WHERE EXISTS(SELECT 1 FROM public.team_delivery_memory_sources d JOIN memory.source_sessions s ON s.session_id=d.source_session_id WHERE s.installation_id=ANY($1::uuid[]) AND (d.team_id,d.team_session_id,d.submission_id,d.decision_id)=(w.team_id,w.team_session_id,w.submission_id,w.decision_id))
  UNION SELECT w.team_id,w.team_session_id,w.submission_id::text,w.decision_id::text FROM public.team_delivery_memory_withdrawals w
   JOIN jsonb_to_recordset($2::jsonb) retained("teamId" text,"teamSessionId" text,"submissionId" uuid,"decisionId" uuid)
    ON (w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(retained."teamId",retained."teamSessionId",retained."submissionId",retained."decisionId")
  UNION SELECT retained."teamId",retained."teamSessionId",retained."submissionId"::text,retained."decisionId"::text FROM public.team_artifact_revocations a
   JOIN jsonb_to_recordset($2::jsonb) retained("teamId" text,"teamSessionId" text,"submissionId" uuid,"decisionId" uuid) ON a.submission_id=retained."submissionId"
  ORDER BY "teamId","teamSessionId","submissionId","decisionId" LIMIT 4097`,[ids,JSON.stringify(retainedClosure.deliveries)])).rows as Withdrawal[]
 if(withdrawals.length>4096)throw Error('overlay_withdrawal_scope_limit')
 const teamAuthority:TeamAuthorityFact[]=[]
 for(const ref of retainedClosure.references.filter(r=>r.provenance&&!r.independent)){const fact=await inspectTeamAuthority(c,ref);teamAuthority.push(fact)}
 const installations:InstallationBarrier[]=[],sessionBarriers:SessionBarrier[]=[],memberBarriers:MemberBarrier[]=[],scopeBarriers:ScopeBarrier[]=[]
 for(const row of local){
  const authorities=current.filter(r=>r.installation_id===row.installation_id).map(r=>r.state),state=authorities[0],setting=settings.find(s=>s.installation_id===row.installation_id)
  if(!state||!setting||typeof state.provider_enabled!=='boolean'||typeof state.owner_exists!=='boolean')throw Error('overlay_authority_unknown')
  let reason:InstallationBarrier['reason']|undefined
  if(state.status!=='active'||!state.provider_enabled||!state.owner_exists)reason='installation_revoked'
  else if(state.owner_scope_kind!==row.owner_scope_kind||state.owner_scope_id!==row.owner_scope_id||state.authorization_epoch!==row.authorization_epoch||state.scope_state!=='active'||state.owner_scope_kind==='team'&&(state.parent_state!=='active'||setting.parent_organization_id!==row.parent_organization_id))reason='scope_changed'
  else if(state.config_version!==row.config_version||hash([setting.granted_scopes,setting.subscriptions,setting.enabled_services,setting.event_filter])!==hash([row.granted_scopes,row.subscriptions,row.enabled_services,row.event_filter]))reason='authority_changed'
  for(const m of members.filter(m=>m.installation_id===row.installation_id))if(!authorities.some(s=>s.membership_id===m.membership_id&&s.membership_state==='active'&&s.membership_revision===m.membership_revision&&s.member_exists&&hash(s.roles)===hash(m.roles)))memberBarriers.push({installationId:row.installation_id,membershipId:m.membership_id})
  if(reason==='scope_changed'&&['team','organization'].includes(row.owner_scope_kind)&&state.owner_scope_kind===row.owner_scope_kind&&state.owner_scope_id===row.owner_scope_id&&/^[1-9][0-9]*$/.test(state.authorization_epoch))scopeBarriers.push({installationId:row.installation_id,kind:row.owner_scope_kind,scopeId:row.owner_scope_id,epoch:state.authorization_epoch})
  else if(reason)installations.push({installationId:row.installation_id,reason})
 }
 for(const s of sessions){
  if(s.deleted||s.barrier||['deleting','deleted'].includes(s.content_state)||s.delivery_withdrawn||s.delivery_revoked){sessionBarriers.push({installationId:s.installation_id,sessionId:s.session_id,reason:s.deleted||['deleting','deleted'].includes(s.content_state)?'user_deleted':'access_revoked'});continue}
  if(s.submission_id){if(teamAuthority.some(a=>a.installationId===s.installation_id&&a.root===s.session_id&&a.state==='current'))continue;sessionBarriers.push({installationId:s.installation_id,sessionId:s.session_id,reason:'access_revoked'});continue} // no copied original authority proof: restrict raw source; independent capsules stay retained
  if(s.canonical_owner===null){
   const known=teamAuthority.find(a=>a.installationId===s.installation_id&&a.root===s.session_id);if(known){if(known.state!=='current')sessionBarriers.push({installationId:s.installation_id,sessionId:s.session_id,reason:'access_revoked'});continue}
   if(s.legacy_verified){const filter=settings.find(i=>i.installation_id===s.installation_id)?.event_filter;if(!personalFilterAllows(filter,null,null))sessionBarriers.push({installationId:s.installation_id,sessionId:s.session_id,reason:'access_revoked'});continue}
   // An absent canonical session may be an explicitly verified cold legacy
   // source. That dependency needs W3's adapter; do not infer deletion.
   throw Error('overlay_session_authority_unknown')
  }
  if(s.canonical_owner!==s.owner_user_id||s.daemon_owner!==s.owner_user_id||s.source==='app_review_demo'||!personalFilterAllows(settings.find(i=>i.installation_id===s.installation_id)?.event_filter,s.daemon_id,s.agent_type))sessionBarriers.push({installationId:s.installation_id,sessionId:s.session_id,reason:'access_revoked'})
 }
 return {retainedClosure,teamAuthority,memberBarriers,scopeBarriers,memberStates:members.map(m=>({installationId:m.installation_id,membershipId:m.membership_id,state:m.state})),currentFactsHash:hash({current,settings,sessions,withdrawals,teamAuthority,retainedClosure:retainedClosure.fingerprint}),localFactsHash:hash({local,members:members.map(({state:_,...m})=>m),retainedClosure:retainedClosure.fingerprint}),sessions:sessionBarriers,withdrawals,installations}
}
export async function planPrivacyOverlay(config:PrivacyOverlayConfig,options:OverlayOptions={}):Promise<PrivacyOverlayManifest>{
 validateConfig(config);await drain(config,options);const db=await connectMaintenance(config.database,true)
 try{await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertPrivacyTargetClosed(db.client);const state=await readPrivacyFacts(db.client,config);abort(options);return seal({schemaVersion:2 as const,kind:'memory-current-privacy-overlay' as const,identity:db.identity,configHash:binding(config),...state})}finally{await db.client.query('ROLLBACK').catch(()=>{});await db.close()}
}
function personalFilterAllows(filter:unknown,daemon:string|null,agent:string|null){
 if(!filter||typeof filter!=='object'||Array.isArray(filter))return false
 const f=filter as Record<string,unknown>;if(Object.keys(f).some(k=>!['daemon_ids','agent_types'].includes(k)))return false
 for(const [key,value] of [['daemon_ids',daemon],['agent_types',agent]] as const){const allowed=f[key];if(allowed===undefined)continue;if(!Array.isArray(allowed)||allowed.some(v=>typeof v!=='string')||allowed.length&&!allowed.includes(value))return false}
 return true
}
function bound(config:PrivacyOverlayConfig,manifest:PrivacyOverlayManifest){validateConfig(config);assertManifest(manifest,'memory-current-privacy-overlay',2);if(manifest.configHash!==binding(config))throw Error('overlay_scope_drift')}
function unchanged(state:Awaited<ReturnType<typeof readPrivacyFacts>>,manifest:PrivacyOverlayManifest){if(state.currentFactsHash!==manifest.currentFactsHash||state.localFactsHash!==manifest.localFactsHash||hash([state.sessions,state.withdrawals,state.installations,state.memberBarriers,state.scopeBarriers])!==hash([manifest.sessions,manifest.withdrawals,manifest.installations,manifest.memberBarriers,manifest.scopeBarriers]))throw Error('overlay_facts_drift');for(const member of state.memberStates){const expected=manifest.memberStates.find(m=>m.installationId===member.installationId&&m.membershipId===member.membershipId);if(!expected||member.state!==expected.state&&!(member.state==='revoked'&&manifest.memberBarriers.some(m=>m.installationId===member.installationId&&m.membershipId===member.membershipId)))throw Error('overlay_member_state_drift')}}
function receipt(manifest:PrivacyOverlayManifest){
 const teamSourceCleanup=manifest.teamAuthority.filter(a=>a.state!=='current')
 const unresolved=manifest.retainedClosure.unresolved.length>0||teamSourceCleanup.some(a=>a.state==='unproven')
 const cleanupPending=manifest.sessions.length>0||manifest.installations.length>0||manifest.memberBarriers.length>0||manifest.scopeBarriers.length>0||unresolved
 return {schemaVersion:1,kind:'memory-privacy-overlay-verification',manifestHash:manifest.manifestHash,barrierApplied:true,currentRestrictionsVerified:true,privacyCatchupReadyForReopen:!cleanupPending,reopeningReady:false,activationAuthorized:false,backupCreated:false,rollbackSupported:false,
  pendingForwardRepair:{sessionCleanup:manifest.sessions,withdrawalDependencyReview:manifest.withdrawals,installationAuthorityRepair:manifest.installations,memberCleanup:manifest.memberBarriers,scopeCleanup:manifest.scopeBarriers,retainedReferences:manifest.retainedClosure.references,retainedUnresolved:manifest.retainedClosure.unresolved,teamSourceCleanup,
   missingAdapters:[...(unresolved?['unresolved_original_source_authority']:[]),...(manifest.installations.length?['installation_configuration_refresh']:[])]},
  reopenBlockers:['activation_and_business_acceptance_separate',...(manifest.sessions.length?['session_cleanup_not_executed']:[]),...(unresolved?['retained_original_authority_repair_required']:[]),...(manifest.installations.length?['affected_installations_held_integrity_error']:[]),...(manifest.memberBarriers.length||manifest.scopeBarriers.length?['exact_scope_authority_repair_pending']:[])]}
}
export async function assertPrivacyOverlayBarriers(c:pg.Client,manifest:PrivacyOverlayManifest){
 for(const s of manifest.sessions)if(!(await c.query('SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=$1::uuid AND session_id=$2',[s.installationId,s.sessionId])).rowCount)throw Error('overlay_session_barrier_missing')
 for(const w of manifest.withdrawals)if(!(await c.query('SELECT 1 FROM memory.memory_team_delivery_withdrawals WHERE(team_id,team_session_id,submission_id,decision_id)=($1,$2,$3::uuid,$4::uuid)',[w.teamId,w.teamSessionId,w.submissionId,w.decisionId])).rowCount)throw Error('overlay_withdrawal_barrier_missing')
 for(const m of manifest.memberBarriers)if(!(await c.query("SELECT 1 FROM memory.memory_scope_memberships WHERE installation_id=$1::uuid AND membership_id=$2::uuid AND state='revoked'",[m.installationId,m.membershipId])).rowCount)throw Error('overlay_member_barrier_missing')
 for(const scope of manifest.scopeBarriers)if(!(await c.query('SELECT 1 FROM memory.memory_scope_tombstones WHERE owner_scope_kind=$1 AND owner_scope_id=$2::uuid AND authorization_epoch>=$3::bigint',[scope.kind,scope.scopeId,scope.epoch])).rowCount)throw Error('overlay_scope_barrier_missing')
 for(const i of manifest.installations)if(!(await c.query("SELECT 1 FROM memory.memory_installations WHERE installation_id=$1::uuid AND local_status IN('integrity_error','purging','purged')",[i.installationId])).rowCount)throw Error('overlay_installation_barrier_missing')
}
/** Shared by explicit forward cleanup; callers own a bounded transaction. */
export async function lockPrivacyMetadata(c:pg.Client){
  // Bounded NOWAIT metadata locks also cover facts currently absent, such as
  // a newly inserted tombstone/withdrawal. No canonical body relation is locked.
  await c.query('LOCK TABLE public.extension_installations,public.extension_providers,public.users,public.extension_teams,public.extension_organizations,public.extension_scope_memberships,public.sessions,public.daemons,public.deleted_sessions,public.team_delivery_memory_sources,public.team_delivery_memory_withdrawals,public.team_artifact_revocations,shared.memory_source_session_barriers IN SHARE MODE NOWAIT')
  await c.query('LOCK TABLE shared.memory_source_contract,shared.memory_source_modes,memory.memory_installations,memory.memory_owner_scopes,memory.memory_scope_memberships,memory.source_sessions,memory.source_events,memory.source_artifacts,memory.work_episodes,memory.knowledge_evidence,memory.knowledge_evidence_capsules IN SHARE ROW EXCLUSIVE MODE NOWAIT')
  const teamTables=(await c.query("SELECT relation FROM unnest(ARRAY['public.team_memory_bindings','public.collaboration_sessions','public.collaboration_teams','public.collaboration_calls','public.collaboration_session_participants','public.collaboration_team_memberships','public.team_agent_offers','public.team_acceptance_decisions','public.team_task_submissions','public.team_task_specs']) relation WHERE to_regclass(relation) IS NOT NULL")).rows
  for(const row of teamTables)await c.query('LOCK TABLE '+row.relation+' IN SHARE MODE NOWAIT')
}
export async function applyPrivacyOverlay(config:PrivacyOverlayConfig,manifest:PrivacyOverlayManifest,options:OverlayOptions={}){
 if(options.transactionTimeoutMs!==undefined&&(!Number.isSafeInteger(options.transactionTimeoutMs)||options.transactionTimeoutMs<1||options.transactionTimeoutMs>10000))throw Error('invalid_maintenance_timeout')
 bound(config,manifest);const evidence=await drain(config,options),db=await connectMaintenance(config.database,false)
 const windowMs=Math.min(10000,Math.max(1,options.transactionTimeoutMs??10000)),deadline=Date.now()+windowMs,timer=setTimeout(()=>{void db.close().catch(()=>{})},windowMs),check=()=>{abort(options);if(Date.now()>deadline)throw Error('overlay_transaction_window_expired')}
 try{
  await db.client.query('BEGIN');await db.client.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-privacy-overlay-v1',0))")
  await lockPrivacyMetadata(db.client)
  await assertPrivacyTargetClosed(db.client);const state=await readPrivacyFacts(db.client,config);unchanged(state,manifest);if(state.retainedClosure.unresolved.length||state.teamAuthority.some(a=>a.state==='unproven'&&a.root===null))throw Error('retained_reference_forward_repair_required');if(db.identity!==manifest.identity)throw Error('overlay_target_identity_drift');validateDrainEvidence(config.units,evidence);check()
  for(const s of manifest.sessions){check();await db.client.query("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,source_feed_id,purged_at) VALUES($1::uuid,$2,$3,NULL,clock_timestamp()) ON CONFLICT DO NOTHING",[s.installationId,s.sessionId,s.reason])}
  for(const w of manifest.withdrawals){check();await db.client.query('INSERT INTO memory.memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id) VALUES($1,$2,$3::uuid,$4::uuid) ON CONFLICT DO NOTHING',[w.teamId,w.teamSessionId,w.submissionId,w.decisionId])}
  for(const m of manifest.memberBarriers){check();await db.client.query("UPDATE memory.memory_scope_memberships SET state='revoked',updated_at=clock_timestamp() WHERE installation_id=$1::uuid AND membership_id=$2::uuid AND state<>'revoked'",[m.installationId,m.membershipId])}
  for(const scope of manifest.scopeBarriers){check();await db.client.query("INSERT INTO memory.memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES($1,$2::uuid,$3::bigint,'maintenance_authority_changed') ON CONFLICT(owner_scope_kind,owner_scope_id) DO UPDATE SET authorization_epoch=GREATEST(memory.memory_scope_tombstones.authorization_epoch,excluded.authorization_epoch) WHERE memory.memory_scope_tombstones.authorization_epoch<excluded.authorization_epoch",[scope.kind,scope.scopeId,scope.epoch])}
  for(const i of manifest.installations){check();await db.client.query("UPDATE memory.memory_installations SET local_status='integrity_error',poll_owner=NULL,poll_expires_at=NULL,last_error_code='maintenance_authority_changed',updated_at=clock_timestamp() WHERE installation_id=$1::uuid AND local_status NOT IN('purging','purged','integrity_error')",[i.installationId])}
  await assertPrivacyOverlayBarriers(db.client,manifest);check();validateDrainEvidence(config.units,evidence);await db.client.query('COMMIT');return receipt(manifest)
 }catch(e){await db.client.query('ROLLBACK').catch(()=>{});if(Date.now()>=deadline)throw Error('overlay_transaction_window_expired');throw e}finally{clearTimeout(timer);await db.close()}
}
export async function verifyPrivacyOverlay(config:PrivacyOverlayConfig,manifest:PrivacyOverlayManifest,options:OverlayOptions={}){
 bound(config,manifest);await drain(config,options);const db=await connectMaintenance(config.database,true)
 try{await db.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertPrivacyTargetClosed(db.client);const state=await readPrivacyFacts(db.client,config);unchanged(state,manifest);if(state.retainedClosure.unresolved.length||state.teamAuthority.some(a=>a.state==='unproven'&&a.root===null))throw Error('retained_reference_forward_repair_required');await assertPrivacyOverlayBarriers(db.client,manifest);abort(options);return receipt(manifest)}finally{await db.client.query('ROLLBACK').catch(()=>{});await db.close()}
}
