import {collectTeamSemanticLegacyAudit,type TeamSemanticLegacyAudit} from './team-semantic-legacy-audit.js'
import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,type SourceRoot} from '@pocketctl/session-source'
import {discoverTeamSemanticGroup,teamSemanticRawReady,type TeamSemanticRoster} from './team-semantic-discovery.js'
import {prepareTeamSemanticBody,type PreparedTeamSemanticBody} from './team-semantic-reader.js'
import {prepareTeamSemanticRegistration,persistTeamSemanticRegistration} from './team-semantic-registration.js'
import {teamSemanticRegistrationTransaction} from './team-semantic-registration-transport.js'
import {teamSemanticOriginalExecution,lockTeamSemanticExecutionGroup,guardSourceExecutionCommit,completeSourceProjection} from './source-execution.js'
import {projectCanonicalDerivedFact} from '../projection/source-projector.js'
const hash=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const preparations=new WeakMap<object,{pool:pg.Pool;execution:object;roster:TeamSemanticRoster;audit?:TeamSemanticLegacyAudit;body?:PreparedTeamSemanticBody;refs:Map<string,string>}>()
export interface TeamSemanticPublication {readonly token:object;readonly disposition:'published'|'policy_excluded'|'legacy_related'|'legacy_unproven'}
/** Collect only after every current principal/root is raw-ready. Preparatory
 * registration remains independently unusable; the three actual references,
 * derived facts and complete checkpoints are a separate atomic publication. */
export async function prepareTeamSemanticPublication(pool:pg.Pool,installation:string,root:SourceRoot,options:{metadataOnly?:boolean}={}):Promise<TeamSemanticPublication|null>{
 const execution=teamSemanticOriginalExecution(pool,installation),roster=await discoverTeamSemanticGroup(pool,installation,root)
 if(roster.supportCount<1||roster.withdrawn)throw Error('team_semantic_source_unavailable')
 if(!['eligible','before'].includes(roster.admission))throw Error('team_semantic_input_'+roster.admission)
 if(roster.admission==='eligible'&&(options.metadataOnly===true||!await teamSemanticRawReady(pool,roster)))return null
 const identity=roster.kind==='team_collaboration'?[roster.kind,'1',roster.teamId,roster.teamSessionId,roster.callId]:[roster.kind,'2',roster.teamId,roster.teamSessionId,roster.submissionId!,roster.decisionId!]
 const current=roster.roots.flatMap(r=>r.contexts).find(c=>c.state==='current')!.scope
 const groupKey=hash([[installation,current.ownerScopeKind,current.ownerScopeId,roster.bindingId,roster.bindingRevision],identity])
 const old=(await pool.query('SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1 AND group_key=$2',[installation,groupKey])).rows[0]
 // First snapshot is immutable. Later fees never rewrite or reinterpret it,
 // and they do not invalidate an already published semantic source read.
 const audit=roster.admission==='before'?undefined:old?old.legacy_relation_audit??undefined:await collectTeamSemanticLegacyAudit(pool,roster)
 const disposition:TeamSemanticPublication['disposition']=roster.admission==='before'?'policy_excluded':old?old.disposition:audit?.disposition==='related'?'legacy_related':'legacy_unproven'
 const refs=new Map<string,string>();let body:PreparedTeamSemanticBody|undefined
 if(roster.admission==='eligible'&&disposition!=='legacy_unproven'){
  body=await prepareTeamSemanticBody(pool,installation,root)
  if(canonicalJsonString(body.roster)!==canonicalJsonString(roster))throw Error('team_semantic_group_changed')
  const requests=roster.roots.flatMap(r=>r.contexts.filter(c=>c.state==='current').map(c=>({scope:c.scope,root:r.root})))
  // The registration entry point separately validates exact raw original
  // audit hashes/versions. It is never used as complete-roster authority.
  for(let n=0;n<requests.length;n+=64){
   const registered=await persistTeamSemanticRegistration(pool,await prepareTeamSemanticRegistration(pool,requests.slice(n,n+64)))
   for(const row of registered){
    if(refs.has(row.semanticKey)&&refs.get(row.semanticKey)!==row.semanticRefId)throw Error('team_semantic_registration_conflict')
    refs.set(row.semanticKey,row.semanticRefId)
   }
  }
  if(body.roles.some(r=>!refs.has(r.semanticKey)))throw Error('team_semantic_registration_conflict')
 }
 const token=Object.freeze({});preparations.set(token,{pool,execution:execution.token,roster,audit,body,refs})
 return {token,disposition}
}
/** Physical bounded transaction. No native body or provider IO occurs here. */
export async function persistTeamSemanticPublication(pool:pg.Pool,page:TeamSemanticPublication,stabilizationMs=30000):Promise<void>{
 const p=preparations.get(page.token)
 if(!p||p.pool!==pool)throw Error('team_semantic_publication_token_invalid')
 const {roster,audit,body,refs}=p,installation=roster.installationId,execution=teamSemanticOriginalExecution(pool,installation)
 if(execution.token!==p.execution)throw Error('team_semantic_publication_execution_changed')
 if(!Number.isSafeInteger(stabilizationMs)||stabilizationMs<0||stabilizationMs>86400000)throw Error('team_semantic_publication_options_invalid')
 await teamSemanticRegistrationTransaction(pool,async client=>{
  // Original execution + all current native set/root/principal fences precede
  // every Memory installation/group/reference/derived row lock.
  await lockTeamSemanticExecutionGroup(client,installation,roster)
  if((await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('team-semantic-publication:'||$1,0)) AS locked",[installation])).rows[0]?.locked!==true)throw Error('team_semantic_publication_busy')
  if(roster.admission!=='before'&&!await teamSemanticRawReady(client,roster))throw Error('team_semantic_group_not_ready')
  const identity=roster.kind==='team_collaboration'?[roster.kind,'1',roster.teamId,roster.teamSessionId,roster.callId]:[roster.kind,'2',roster.teamId,roster.teamSessionId,roster.submissionId!,roster.decisionId!]
  const scope=roster.roots.flatMap(r=>r.contexts).find(c=>c.state==='current')!.scope
  const partition=[installation,scope.ownerScopeKind,scope.ownerScopeId,roster.bindingId,roster.bindingRevision]
  const groupKey=hash([partition,identity]),session='team_semantic_'+groupKey,turn='team-semantic:'+groupKey
  if(body?.roles.some(r=>r.semanticSessionId!==session||r.semanticTurnId!==turn))throw Error('team_semantic_group_conflict')
  const digest=body?hash(body.roles.map(r=>[r.identity.at(-1),r.businessDigest]).sort((a,b)=>a[0]!.localeCompare(b[0]!))):null
  const old=(await client.query('SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1 AND group_key=$2 FOR SHARE NOWAIT',[installation,groupKey])).rows[0]
  if(old){
   if(old.disposition!==page.disposition||(old.business_digest?.toString('hex')??null)!==digest||canonicalJsonString(old.structured_identity)!==canonicalJsonString(identity))throw Error('team_semantic_publication_conflict')
  }else{
   if(audit&&canonicalJsonString(await collectTeamSemanticLegacyAudit(client,roster))!==canonicalJsonString(audit))throw Error('team_semantic_legacy_audit_changed')
   if(!(await client.query("SELECT 1 FROM memory_installations WHERE installation_id=$1 AND relay_status='active' AND local_status NOT IN('purging','purged','integrity_error') FOR KEY SHARE NOWAIT",[installation])).rowCount)throw Error('team_semantic_publication_unavailable')
   if((await client.query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[installation,session])).rowCount)throw Error('team_semantic_publication_unavailable')
   if(body){
    for(const role of [...body.roles].sort((a,b)=>['goal','reply','outcome'].indexOf(a.identity.at(-1)!) - ['goal','reply','outcome'].indexOf(b.identity.at(-1)!))){
     const ref=refs.get(role.semanticKey)!
     const registered=(await client.query('SELECT semantic_ref_id,business_digest,registration_state FROM memory_team_semantic_groups WHERE installation_id=$1 AND semantic_key=$2 FOR UPDATE NOWAIT',[installation,role.semanticKey])).rows[0]
     if(registered?.semantic_ref_id!==ref||registered.business_digest?.toString('hex')!==role.businessDigest||registered.registration_state!=='preparatory')throw Error('team_semantic_registration_conflict')
     await client.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,$3::timestamptz,$3::timestamptz)
      ON CONFLICT(installation_id,session_id) DO UPDATE SET first_recorded_at=LEAST(source_sessions.first_recorded_at,EXCLUDED.first_recorded_at),last_recorded_at=GREATEST(source_sessions.last_recorded_at,EXCLUDED.last_recorded_at)`,[installation,session,role.occurredAt])
     await client.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,
      source_provenance,source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version,canonical_projected_at)
      VALUES($1,$2,'canonical',$3,$4,$5,$6,$7::timestamptz,$8::jsonb,NULL,$9,$10::jsonb,'team_semantic',$11,$4,$12::jsonb,$9,'canonical-json-sha256-v1','verified','team-semantic-v1',clock_timestamp())`,
      [ref,installation,'team_semantic:'+role.semanticKey,session,turn,role.eventType,role.occurredAt,JSON.stringify(role.classification),Buffer.from(role.payloadHash,'hex'),JSON.stringify(role.provenance),role.semanticKey,JSON.stringify({normalization:'team-semantic-v1',businessDigest:role.businessDigest,originalSupportDigest:hash(roster)})])
     if(page.disposition==='published')await projectCanonicalDerivedFact(client,installation,{sourceEventId:ref,sessionId:session,turnId:turn,eventType:role.eventType,occurredAt:role.occurredAt,payload:role.payload},stabilizationMs)
     await client.query("UPDATE memory_team_semantic_groups SET registration_state='published',semantic_payload_hash=$3 WHERE installation_id=$1 AND semantic_key=$2",[installation,role.semanticKey,Buffer.from(role.payloadHash,'hex')])
    }
   }
   const roleId=(name:string)=>body?refs.get(body.roles.find(r=>r.identity.at(-1)===name)!.semanticKey):null
   await client.query(`INSERT INTO memory_team_semantic_publications(installation_id,group_key,source_kind,structured_identity,semantic_session_id,semantic_turn_id,disposition,
    goal_ref_id,reply_ref_id,outcome_ref_id,business_digest,support_digest,native_publication_proof,source_roster,normalization_version,publication_execution_id,publication_control_revision,publication_mode_generation,legacy_relation_audit,legacy_relation_digest)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,'team-semantic-v1',$15,$16::bigint,$17::bigint,$18::jsonb,CASE WHEN $18::jsonb IS NULL THEN NULL ELSE sha256(convert_to(($18::jsonb)::text,'UTF8')) END)`,
    [installation,groupKey,roster.kind,JSON.stringify(identity),session,turn,page.disposition,roleId('goal'),roleId('reply'),roleId('outcome'),digest?Buffer.from(digest,'hex'):null,Buffer.from(hash(roster),'hex'),JSON.stringify(roster.publication),JSON.stringify(roster),execution.executionId,execution.controlRevision,execution.generation,audit?JSON.stringify(audit):null])
  }
  if(page.disposition==='legacy_unproven')return
  for(const r of roster.roots)for(const c of r.contexts.filter(c=>c.state==='current')){
   if(page.disposition==='policy_excluded')await client.query(`INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,next_cursor,state)
    VALUES($1,$2,$3,shared.memory_source_scope_key($4::jsonb),$5::jsonb,NULL,'ready') ON CONFLICT(installation_id,source_kind,root_key,context_key)
    DO UPDATE SET source_version=EXCLUDED.source_version,next_cursor=NULL,state='ready',updated_at=clock_timestamp()`,[installation,r.root.kind,r.root.key,JSON.stringify(c.scope),JSON.stringify(c.version)])
   else await client.query(`UPDATE memory_canonical_projection_progress SET state='ready',updated_at=clock_timestamp() WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=shared.memory_source_scope_key($4::jsonb)`,[installation,r.root.kind,r.root.key,JSON.stringify(c.scope)])
  }
  for(const r of roster.roots)for(const c of r.contexts.filter(c=>c.state==='current'))await completeSourceProjection(client,c.scope,r.root,c.version)
  await lockTeamSemanticExecutionGroup(client,installation,roster)
  await guardSourceExecutionCommit(client,installation)
 })
}
