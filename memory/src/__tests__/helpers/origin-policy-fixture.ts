import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {governanceFixture} from '../../testing/governance-fixture.js'
import {createPromotionService} from '../../governance/promotion-service.js'
import {createPublicationService} from '../../governance/publication-service.js'
import {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY} from '../../governance/review-policy.js'
export async function originPolicyFixture(pool:pg.Pool,claimType='test_invariant',options:{scopeKey?:string;parentOrganizationId?:string;beforeOrganizationReview?:(team:string)=>Promise<void>;beforeOrganizationPublish?:(team:string)=>Promise<void>}={}){
 const f=await governanceFixture(pool)
 if(options.scopeKey)await pool.query('UPDATE knowledge_claims SET scope_key=$2 WHERE claim_id=$1',[f.claim,options.scopeKey])
 await pool.query('UPDATE knowledge_claims SET claim_type=$2 WHERE claim_id=$1',[f.claim,claimType])
 if(options.parentOrganizationId)await pool.query('UPDATE memory_owner_scopes SET parent_organization_id=$2 WHERE installation_id=$1',[f.team,options.parentOrganizationId])
 const first=await f.approved(),pub=createPublicationService(pool)
 if(options.parentOrganizationId){
  const reviewer=randomUUID();await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['reviewer'])",[f.team,reviewer])
  await pub.decide({grant:f.grant(reviewer,['read','review']),targetInstallationId:f.team,candidateId:first.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
 }
 const shared=await pub.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:first.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
 const org=randomUUID(),members=Array.from({length:4},()=>randomUUID())
 await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
 await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
 for(const [i,id]of members.entries())await pool.query('INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,$3)',[org,id,[i===0?'contributor':i===3?'scope_administrator':'reviewer']])
 const grant=(i:number,permissions:string[])=>({primaryInstallationId:org,configVersion:'1',scopeBindings:[
  {installation_id:f.team,owner_scope_kind:'team' as const,owner_scope_id:f.team,membership_id:f.proposer,membership_revision:'1',authorization_epoch:'1',permissions:['read']},
  {installation_id:org,owner_scope_kind:'organization' as const,owner_scope_id:org,membership_id:members[i],membership_revision:'1',authorization_epoch:'1',permissions}]})
 const evidence=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[shared.versionId])).rows[0].evidence_id
 const proposed=await createPromotionService(pool).propose({grant:grant(0,['read','contribute']),sourceInstallationId:f.team,sourceClaimId:shared.claimId,evidenceIds:[evidence],idempotencyDigest:randomUUID()})
 await options.beforeOrganizationReview?.(f.team)
 for(const i of[1,2])await pub.decide({grant:grant(i,['read','review']),targetInstallationId:org,candidateId:proposed.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
 await options.beforeOrganizationPublish?.(f.team)
 const published=await pub.publish({grant:grant(3,['read','publish']),targetInstallationId:org,candidateId:proposed.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
 const policies=createReviewPolicyRepository(pool),head=(await policies.getHead(f.team))!
 const change=()=>policies.publishVersion({installationId:f.team,document:{...DEFAULT_TEAM_REVIEW_POLICY,max_shared_evidence:7},createdByMembershipId:f.publisher,expectedRevision:head.revision})
 return{...f,org,shared,published,proposed,grant,policies,head,change}
}
