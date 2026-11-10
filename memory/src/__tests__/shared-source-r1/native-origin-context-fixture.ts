import{randomUUID}from'node:crypto'
import type{DirectLaunchFixture}from'./direct-launch-fixture.js'
import{governanceFixture}from'../../testing/governance-fixture.js'
import{createPublicationService}from'../../governance/publication-service.js'
import{createPromotionService}from'../../governance/promotion-service.js'
import type{ValidatedV2Grant}from'../../governance/authorization.js'
/** Real native scopes/members and least-role promotion/publication services;
 * no control mirror refresh or namespace override supplies authority. */
export async function nativeOriginKnowledgeFixture(f:DirectLaunchFixture,parentScope:string,options:{retainedExcerpt?:boolean;repositoryScoped?:boolean}={}){
 const g=await governanceFixture(f.runtime),pub=createPublicationService(f.runtime)
 const user=async()=>(await f.pool.query("INSERT INTO public.users(email,password_hash,team_enabled) VALUES($1,'synthetic-only',true) RETURNING id",[randomUUID()+'@origin.invalid'])).rows[0].id as number
 const users=[await user(),await user(),await user(),await user()],owner=users[0],teamMembers=[g.proposer,g.reviewer,g.publisher,randomUUID()]
 await f.pool.query("INSERT INTO public.extension_teams(team_id,organization_id,name) VALUES($1,$2,$1::uuid::text)",[g.team,parentScope])
 for(const[id,kind]of[[g.personal,'personal'],[g.team,'team']])await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,$3,$1,'active','{}','{}',ARRAY['memory.manage'],'retained_history')",[id,kind==='personal'?owner:null,kind])
 for(const[i,id]of teamMembers.entries())await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'team',$2,$3,ARRAY[$4]::text[])",[id,g.team,users[i],['contributor','reviewer','scope_administrator','reader'][i]])
 const repositories=new Map<string,string>(),canonicalKey='github.com/pocketctl/synthetic-'+randomUUID()
 const addRepository=async(installation:string)=>{
  const id=randomUUID();await f.runtime.query("INSERT INTO repositories(repository_id,installation_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,'native-origin-fixture',$3,clock_timestamp(),clock_timestamp())",[id,installation,'https://'+canonicalKey]);repositories.set(installation,id);return id
 }
 if(options.repositoryScoped){
  const id=await addRepository(g.personal);await addRepository(g.team)
  const applicability={scopeKind:'repository',scopeKey:id,repositoryId:id,snapshotId:null,branch:null,canonicalRepositoryKey:canonicalKey,status:'verified'}
  await f.runtime.query("UPDATE knowledge_claims SET scope_kind='repository',scope_key=$2,canonical_repository_key=$3 WHERE claim_id=$1",[g.claim,id,canonicalKey])
  await f.runtime.query('UPDATE knowledge_versions SET repository_id=$2,applicability=$3::jsonb WHERE version_id=$1',[g.version,id,JSON.stringify(applicability)])
 }
 // Explicit user-accepted retained text, not an invented raw episode proof.
 // Source UUIDs stay NULL; the negative case retains the unproved episode kind.
 if(options.retainedExcerpt!==false){
  const capsule=randomUUID()
  await f.runtime.query(`INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
   SELECT $1,$2,$3,'user_accepted',sha256(convert_to(encode(excerpt_hash,'hex'),'UTF8')) FROM knowledge_evidence WHERE evidence_id=$4`,[capsule,g.personal,g.version,g.evidence])
  await f.runtime.query("UPDATE knowledge_evidence SET evidence_kind='accepted_excerpt',episode_id=NULL,capsule_id=$2,source_evidence_hash=encode(excerpt_hash,'hex') WHERE evidence_id=$1",[g.evidence,capsule])
 }
 const teamGrant=(i:number,permissions:string[]):ValidatedV2Grant=>({primaryInstallationId:g.team,configVersion:'1',userId:users[i],scopeBindings:[
  {installation_id:g.team,owner_scope_kind:'team',owner_scope_id:g.team,membership_id:teamMembers[i],membership_revision:'1',authorization_epoch:'1',permissions}]})
 const first=await createPromotionService(f.runtime).propose({...g.proposeInput,grant:{...g.grant(g.proposer,['read','contribute']),userId:users[0]}})
 for(const i of[1,2])await pub.decide({grant:teamGrant(i,['read','review']),targetInstallationId:g.team,candidateId:first.candidate.candidate_id,expectedCandidateRevision:first.candidate.revision,decision:'approve'})
 const shared=await pub.publish({grant:teamGrant(2,['read','publish']),targetInstallationId:g.team,candidateId:first.candidate.candidate_id,expectedCandidateRevision:first.candidate.revision,resolution:'new'})
 const org=randomUUID(),scope=randomUUID(),members=Array.from({length:4},()=>randomUUID())
 await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,$1::uuid::text)",[scope])
 await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}','{}',ARRAY['memory.manage'],'retained_history')",[org,scope])
 await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
 await f.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$2)",[org,scope])
 if(options.repositoryScoped)await addRepository(org)
 for(const[i,id]of members.entries()){
  const role=i===0?'contributor':i===3?'scope_administrator':'reviewer'
  await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'organization',$2,$3,ARRAY[$4]::text[])",[id,scope,users[i],role])
  await f.runtime.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY[$3]::text[])",[org,id,role])
 }
 const grant=(i:number,permissions:string[]):ValidatedV2Grant=>({primaryInstallationId:org,configVersion:'1',userId:users[i],scopeBindings:[
  {installation_id:g.team,owner_scope_kind:'team',owner_scope_id:g.team,membership_id:teamMembers[i],membership_revision:'1',authorization_epoch:'1',permissions:['read']},
  {installation_id:org,owner_scope_kind:'organization',owner_scope_id:scope,membership_id:members[i],membership_revision:'1',authorization_epoch:'1',permissions}]})
 const evidence=(await f.runtime.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[shared.versionId])).rows[0].evidence_id
 const proposal=await createPromotionService(f.runtime).propose({grant:grant(0,['read','contribute']),sourceInstallationId:g.team,sourceClaimId:shared.claimId,evidenceIds:[evidence],idempotencyDigest:randomUUID()})
 for(const i of[1,2])await pub.decide({grant:grant(i,['read','review']),targetInstallationId:org,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:proposal.candidate.revision,decision:'approve'})
 const published=await pub.publish({grant:grant(3,['read','publish']),targetInstallationId:org,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:proposal.candidate.revision,resolution:'new'})
 const personalGrant:ValidatedV2Grant={primaryInstallationId:g.personal,configVersion:'1',userId:users[0],scopeBindings:[
  {installation_id:g.personal,owner_scope_kind:'personal',owner_scope_id:g.personal,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']}]}
 return{...g,org,scope,shared,published,grant,personalGrant,repositories}
}
