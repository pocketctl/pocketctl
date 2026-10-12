import {createHash} from 'node:crypto'
import type pg from 'pg'
import { assertMemoryTestDatabase } from '../test-db.js'
import { seedMemoryV50Anomalies,V50_IDS } from './memory-v50.js'
const id=(n:number)=>`a0500200-0000-4000-8000-${String(n).padStart(12,'0')}`
export const UPGRADE_IDS={publisherClaim:id(101),parallelGroup:id(102),applicabilityClaim:id(103),revokedAuthority:id(104),oppositeProposal:id(105),editedRevision:id(106),budgetJob:id(107)} as const
/** Synthetic persisted outcomes, not an execution of old binaries or real human proof.
 * IDs are stable across restore/repeat; the minimal existing fixture remains unchanged. */
export async function seedMemoryV50UpgradeScenarios(pool:pg.Pool,url:string):Promise<void>{
 await assertMemoryTestDatabase(pool,url)
 await seedMemoryV50Anomalies(pool)
 const document=(await pool.query('SELECT document FROM memory_review_policy_versions WHERE policy_version_id=$1',[V50_IDS.policyVersion])).rows[0].document
 await pool.query('UPDATE memory_review_policy_versions SET content_hash=$2 WHERE policy_version_id=$1',[V50_IDS.policyVersion,createHash('sha256').update(JSON.stringify(document,Object.keys(document).sort())).digest('hex')])
 const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
 async function claim(claimId:string,n:number,statement:string,options:{personal?:boolean;group?:string;variant?:number;sourceRange?:boolean}={}){
  const installation=options.personal?V50_IDS.personal:V50_IDS.team,version=id(n)
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,owner_scope_kind,owner_scope_id,conflict_group_id,conflict_variant)
   VALUES($1,$2,'repository_convention',$3,$4,$5,'active',$6,$2,$7,$8)`,[claimId,installation,options.sourceRange?'branch':'installation',options.sourceRange?'main':'global',options.group?'parallel-fixture':claimId,options.personal?'personal':'team',options.group??null,options.variant??0])
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id,branch,valid_from,valid_until,freshness_at)
   VALUES($1,$2,$3,1,$4,'user_accepted',0.9,$5,$6,$7,$8,'2026-01-01')`,[version,installation,claimId,statement,options.sourceRange?V50_IDS.repository:null,options.sourceRange?'main':null,options.sourceRange?'2026-01-01':null,options.sourceRange?'2030-01-01':null])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claimId,version])
  return version
 }
 async function proposal(candidate:string,revision:string,sourceVersion=id(181),sourceClaim=id(180),statement='Always run focused tests before deploy.',state='published'){
  await pool.query(`INSERT INTO memory_promotion_candidates(candidate_id,target_installation_id,source_installation_id,source_scope_kind,source_claim_id,source_version_id,source_content_hash,target_claim_type,scope_kind,scope_key,normalized_key,state,expires_at)
   VALUES($1::uuid,$2,$3,'personal',$4,$5,$6,'repository_convention','installation','global',$1::uuid::text,$7,'2030-01-01')`,[candidate,V50_IDS.team,V50_IDS.personal,sourceClaim,sourceVersion,sha(statement),state])
  await pool.query(`INSERT INTO memory_promotion_candidate_versions(candidate_revision_id,candidate_id,revision_number,statement,content_hash,review_policy_version_id)
   VALUES($1,$2,1,$3,$4,$5)`,[revision,candidate,statement,sha(statement),V50_IDS.policyVersion])
 }
 async function authority(authorityId:string,version:string,revision:string,n:number,publisherCounts=false){
  const decision=id(n),reviewer=id(n+1),publisher=publisherCounts?reviewer:id(n+2)
  await pool.query(`INSERT INTO memory_review_decisions(decision_id,candidate_revision_id,membership_id,membership_revision,decision,created_at) VALUES($1,$2,$3,1,'approve','2026-01-01')`,[decision,revision,reviewer])
  await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash,published_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'personal','synthetic-source-hash','2026-01-03')`,[authorityId,V50_IDS.team,version,revision,V50_IDS.policyVersion,[decision],publisher])
  return publisher
 }
 await claim(id(180),181,'Always run focused tests before deploy.',{personal:true})
 const a=await claim(UPGRADE_IDS.publisherClaim,201,'Always run focused tests before deploy.')
 await proposal(id(202),id(203));await authority(id(204),a,id(203),205,true)
 for(const [n,variant] of [[220,1],[240,2]]){
  const version=await claim(id(n),n+1,'Parallel historical convention '+variant,{group:UPGRADE_IDS.parallelGroup,variant})
  await proposal(id(n+2),id(n+3));await authority(id(n+4),version,id(n+3),n+5)
 }
 const rangeSource=await claim(id(260),261,'Source-specific branch fact',{personal:true,sourceRange:true})
 const target=await claim(UPGRADE_IDS.applicabilityClaim,262,'Source-specific branch fact')
 await proposal(id(263),id(264),rangeSource,id(260),'Source-specific branch fact');await authority(id(265),target,id(264),266)
 const stale=await claim(id(280),281,'Recorded revocation window')
 await proposal(id(282),id(283));const publisher=await authority(UPGRADE_IDS.revokedAuthority,stale,id(283),285)
 await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision,updated_at) VALUES($1,$2,ARRAY['publisher'],'revoked',2,'2026-01-02')`,[V50_IDS.team,publisher])
 await pool.query(`INSERT INTO memory_governance_events(event_id,installation_id,actor_membership_id,action,target_kind,target_id,metadata,created_at) VALUES($1,$2,$3,'fixture_membership_revoked','membership',$3,'{"membership_revision":"1","evidence_status":"synthetic_recorded_window"}','2026-01-02')`,[id(288),V50_IDS.team,publisher])
 const opposite=await claim(id(300),301,'Never run focused tests before deploy.',{personal:true})
 await proposal(UPGRADE_IDS.oppositeProposal,id(302),opposite,id(300),'Never run focused tests before deploy.','proposed')
 await pool.query(`INSERT INTO memory_governance_events(event_id,installation_id,action,target_kind,target_id,metadata) VALUES($1,$2,'fixture_promotion_classified','candidate',$3,'{"classification":"new","evidence_status":"synthetic_legacy_outcome"}')`,[id(303),V50_IDS.team,UPGRADE_IDS.oppositeProposal])
 await proposal(id(320),id(321),undefined,undefined,'Earlier supported revision','approved')
 const excerpt='Synthetic earlier evidence excerpt'
 await pool.query(`INSERT INTO memory_promotion_evidence(candidate_revision_id,ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash,occurred_at) VALUES($1,1,'episode',$2,$3,$3,'2026-01-01')`,[id(321),excerpt,sha(excerpt)])
 await pool.query(`INSERT INTO memory_review_decisions(decision_id,candidate_revision_id,membership_id,membership_revision,decision) VALUES($1,$2,$3,1,'approve')`,[id(322),id(321),id(323)])
 await pool.query(`INSERT INTO memory_promotion_candidate_versions(candidate_revision_id,candidate_id,revision_number,statement,content_hash,review_policy_version_id) VALUES($1,$2,2,'Edited unsupported revision',$3,$4)`,[UPGRADE_IDS.editedRevision,id(320),sha('Edited unsupported revision'),V50_IDS.policyVersion])
 await pool.query('UPDATE memory_promotion_candidates SET revision=2 WHERE candidate_id=$1',[id(320)])
 await pool.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,state,last_error_code,completed_at,payload) VALUES($1,$2,'extract_candidates','historical-budget-omission','completed','budget_exceeded','2026-01-01','{"turn_id":"historical-budget-turn","source_digest":"unproven"}')`,[UPGRADE_IDS.budgetJob,V50_IDS.personal])
 await pool.query(`INSERT INTO knowledge_tombstones(installation_id,key_id,identity_hmac,reason,deleted_at) VALUES($1,'historical-key',$2,'privacy_delete','2026-01-01')`,[V50_IDS.personal,createHash('sha256').update('synthetic-deleted-identity').digest()])
}
