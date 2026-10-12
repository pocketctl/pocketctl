import type pg from 'pg'
import {createHash} from 'node:crypto'
import {loadEffectiveReviewPolicySnapshot,parseReviewPolicyDocument,ReviewPolicyScopeStaleError} from './review-policy.js'

/** Only explicit shared-claim revocations with intact policy provenance qualify.
 * Keep immutable IDs/hashes and authority; privacy redaction is recorded once.
 * Expired proposals and unknown historical policies have no deletion semantics.
 */
export async function cleanupRevokedSharedClaims(pool:pg.Pool,input:{limit:number}):Promise<number>{
 if(!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new Error('invalid_retention_limit')
 const client=await pool.connect()
 try{
  await client.query('BEGIN')
  const observed=await client.query<{installation_id:string;claim_id:string}>(`SELECT c.installation_id,c.claim_id
   FROM knowledge_claims c WHERE c.state='revoked' AND c.owner_scope_kind IN('team','organization')
   AND EXISTS(SELECT 1 FROM memory_authority_records a JOIN knowledge_versions v ON v.version_id=a.version_id
     WHERE a.installation_id=c.installation_id AND v.claim_id=c.claim_id)
   AND EXISTS(SELECT 1 FROM memory_governance_events e WHERE e.installation_id=c.installation_id AND e.target_id=c.claim_id
     AND e.action='shared_claim_revoked' AND e.created_at<clock_timestamp()-interval '1 day')
   AND NOT EXISTS(SELECT 1 FROM memory_governance_events e WHERE e.installation_id=c.installation_id
     AND e.target_id=c.claim_id AND e.action='shared_claim_retention_purged')
   ORDER BY c.updated_at,c.claim_id LIMIT $1`,[input.limit])
  const targets=[...new Set(observed.rows.map(r=>r.installation_id))]
  const parents=await client.query<{installation_id:string}>(`SELECT p.installation_id FROM memory_owner_scopes t
   JOIN memory_owner_scopes p ON p.owner_scope_kind='organization' AND p.owner_scope_id=t.parent_organization_id
   WHERE t.installation_id=ANY($1::uuid[])`,[targets])
  for(const id of [...new Set([...targets,...parents.rows.map(r=>r.installation_id)])].sort()){
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[id])
  }
  let count=0
  for(const observedClaim of observed.rows){
   const values=[observedClaim.installation_id,observedClaim.claim_id]
   const claim=(await client.query(`SELECT 1 FROM knowledge_claims WHERE installation_id=$1 AND claim_id=$2
    AND state='revoked' FOR UPDATE`,values)).rows[0]
   if(!claim)continue
   if((await client.query(`SELECT 1 FROM memory_governance_events WHERE installation_id=$1 AND target_id=$2
    AND action='shared_claim_retention_purged'`,values)).rowCount)continue
   const policies=await client.query<{document:unknown;parent_document:unknown;policy_version_id:string}>(`SELECT p.document,
    parent.document AS parent_document,p.policy_version_id FROM memory_authority_records a
    JOIN knowledge_versions v ON v.installation_id=a.installation_id AND v.version_id=a.version_id
    JOIN memory_review_policy_versions p ON p.policy_version_id=a.review_policy_version_id
    LEFT JOIN memory_promotion_candidate_versions r ON r.candidate_revision_id=a.candidate_revision_id
    LEFT JOIN memory_review_policy_versions parent ON parent.policy_version_id=r.parent_review_policy_version_id
    WHERE a.installation_id=$1 AND v.claim_id=$2 ORDER BY p.policy_version_id`,values)
   if(!policies.rows.length)continue
   let current
   try{current=await loadEffectiveReviewPolicySnapshot(client,observedClaim.installation_id)}catch(error){
    if(error instanceof ReviewPolicyScopeStaleError||(error instanceof Error&&error.message==='review policy head missing'))continue
    throw error
   }
   let days=current.policy.retention_days_after_revoke,unknown=false
   for(const p of policies.rows){
    const policy=parseReviewPolicyDocument(p.document),parent=p.parent_document?parseReviewPolicyDocument(p.parent_document):null
    if(!policy||(p.parent_document&&!parent)){unknown=true;break}
    days=Math.max(days,policy.retention_days_after_revoke,parent?.retention_days_after_revoke??0)
   }
   if(unknown)continue
   const due=await client.query(`SELECT 1 FROM memory_governance_events WHERE installation_id=$1 AND target_id=$2
     AND action='shared_claim_revoked' HAVING MAX(created_at)+($3*interval '1 day')<clock_timestamp()`,[...values,days])
   if(!due.rowCount)continue
   // Domain locks follow the installation fence, so publication, purge and cleanup serialize.
   const versions=await client.query<{version_id:string;statement:string}>(`SELECT version_id,statement FROM knowledge_versions
     WHERE installation_id=$1 AND claim_id=$2 ORDER BY version_id FOR UPDATE`,values)
   const candidateIds=(await client.query<{candidate_id:string}>(`SELECT DISTINCT r.candidate_id FROM memory_authority_records a
    JOIN memory_promotion_candidate_versions r USING(candidate_revision_id)
    JOIN knowledge_versions v ON v.version_id=a.version_id AND v.installation_id=a.installation_id
    WHERE a.installation_id=$1 AND v.claim_id=$2`,values)).rows.map(r=>r.candidate_id)
   if(candidateIds.length){
    await client.query('SELECT 1 FROM memory_promotion_candidates WHERE candidate_id=ANY($1::uuid[]) ORDER BY candidate_id FOR UPDATE',[candidateIds])
    await client.query(`UPDATE memory_promotion_candidate_versions SET statement='[retention purged]',structured_content='{}',
      revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_id=ANY($1::uuid[])`,[candidateIds])
    await client.query(`UPDATE memory_promotion_evidence SET excerpt='[retention purged]',sanitized_locator=NULL
      WHERE candidate_revision_id IN(SELECT candidate_revision_id FROM memory_promotion_candidate_versions WHERE candidate_id=ANY($1::uuid[]))`,[candidateIds])
   }
   const ids=versions.rows.map(v=>v.version_id)
   await client.query(`DELETE FROM claim_search_documents WHERE installation_id=$1 AND version_id=ANY($2::uuid[])`,[values[0],ids])
   await client.query(`UPDATE knowledge_evidence SET excerpt='[retention purged]',locator='{}' WHERE installation_id=$1 AND version_id=ANY($2::uuid[])`,[values[0],ids])
   await client.query(`UPDATE knowledge_versions SET statement='[retention purged]',structured_content='{}' WHERE installation_id=$1 AND claim_id=$2`,values)
   await client.query(`UPDATE knowledge_claims SET consumption_hold_reason='retention_purged' WHERE installation_id=$1 AND claim_id=$2`,values)
   await client.query(`INSERT INTO memory_governance_events(event_id,installation_id,action,target_kind,target_id,previous_state,next_state,metadata)
    VALUES(gen_random_uuid(),$1,'shared_claim_retention_purged','knowledge_claim',$2,'revoked','revoked',$3::jsonb)`,[...values,JSON.stringify({
     policy_version_id:current.activeVersionId,retention_days:days,versions:ids.length,
     content_hashes:versions.rows.map(v=>createHash('sha256').update(v.statement).digest('hex'))})])
   count++
  }
  await client.query('COMMIT');return count
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
