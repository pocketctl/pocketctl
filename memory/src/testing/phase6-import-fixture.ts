import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { gitExportFixture } from './phase6-export-fixture.js'
import { attestationFixture } from './phase6-attestation-fixture.js'
import { changeMetadata } from './phase6-fixtures.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitProposalService } from '../git-sync/proposal-service.js'
import type { RepositoryFile } from '../git-sync/types.js'

/** Entirely synthetic exact-edit provider identity. No real person or provider
 * provenance is claimed; production readers deliberately produce actorId=null. */
export async function gitImportFixture(pool:pg.Pool,kinds=['rule'],unlockedWiki=false) {
  const f=await gitExportFixture(pool),keys=attestationFixture(),deps={pool,keys:keys.registry,skill:{context:f.skill.context,cases:f.skill.cases}}
  await pool.query('UPDATE memory_wiki_heads SET revision=1 WHERE wiki_id=$1',[f.wiki.wikiId])
  await pool.query('UPDATE memory_wiki_manual_section_heads SET lock_version=1 WHERE wiki_id=$1',[f.wiki.wikiId])
  if(unlockedWiki) {
    await pool.query('UPDATE memory_wiki_manual_section_heads SET locked=false WHERE wiki_id=$1',[f.wiki.wikiId])
    await pool.query("UPDATE memory_wiki_sections SET authority='manual' WHERE wiki_version_id=$1 AND authority='locked'",[f.wiki.versionId])
  }
  const originalAuthor=await f.skill.actor(['contributor','reviewer'],['read','contribute','review'])
  await pool.query(`INSERT INTO memory_git_actor_mappings(installation_id,connection_id,provider_actor_id,membership_id,membership_revision,authorization_epoch)
    VALUES($1,$2,'synthetic-exact-edit-author',$3,1,1)`,[f.installationId,f.connectionId,originalAuthor.membershipId])
  const bundle=await createGitExportService(deps).export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',
    baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>kinds.includes(k.kind))})
  const service=createGitProposalService(deps)
  const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:bundle.exportId,headCommit:'b'.repeat(40),files:bundle.files}
  const edit=(files:RepositoryFile[],fn:(value:any)=>void)=>files.map(file=>file.path.endsWith('/manifest.yaml')?file:changeMetadata([file],fn)[0])
  async function plan(files=edit(bundle.files,v=>{if(v.key?.kind==='rule')v.editable.statement='Governed Git edit'}),actorId:string|null='synthetic-exact-edit-author') {
    const proposals=await service.plan(f.grant,{...request,files}),runId=randomUUID()
    // Persist the same verified merge/run facts consumed by the application;
    // raw Git email, PR opener, requester and merger are never authors here.
    await pool.query(`INSERT INTO memory_git_runs(run_id,installation_id,connection_id,generation,direction,mode,outcome_kind,state,
      membership_id,membership_revision,authorization_epoch,config_version,request_hash,export_id,merge_commit,tree_sha,provider_actor_id)
      VALUES($1,$2,$3,1,'import','shadow','fixture','planned',$4,1,1,1,$5,$6,$7,$8,$9)`,
    [runId,f.installationId,f.connectionId,f.membershipId,runId.replaceAll('-','').repeat(2),bundle.exportId,request.headCommit,'c'.repeat(40),actorId])
    await pool.query(`INSERT INTO memory_git_run_receipts(installation_id,connection_id,generation,run_id,request_hash,admission_hash,outcome_kind,state,eligible,unfinished)
      VALUES($1,$2,1,$3,$4,$4,'fixture','planned',true,false)`,[f.installationId,f.connectionId,runId,runId.replaceAll('-','').repeat(2)])
    await pool.query(`INSERT INTO memory_git_merge_receipts(installation_id,connection_id,generation,commit_sha,run_id,tree_sha)
      VALUES($1,$2,1,$3,$4,$5)`,[f.installationId,f.connectionId,request.headCommit,runId,'c'.repeat(40)])
    await pool.query('UPDATE memory_git_import_proposals SET run_id=$2,provider_actor_id=$3 WHERE proposal_id=ANY($1::uuid[])',[proposals.map(p=>p.proposalId),runId,actorId])
    return {proposals,runId,files}
  }
  async function advanceRule() {
    const versionId=randomUUID()
    await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,source_promotion_candidate_id)
      SELECT $1,installation_id,claim_id,2,statement,'{"value":null,"flags":["strict"],"retries":9}',authority,confidence,source_promotion_candidate_id
      FROM knowledge_versions WHERE version_id=$2`,[versionId,f.rule.versionId])
    await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility,source_evidence_hash,contributor_membership_id)
      SELECT gen_random_uuid(),installation_id,$1,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility,source_evidence_hash,contributor_membership_id FROM knowledge_evidence WHERE version_id=$2`,[versionId,f.rule.versionId])
    await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
      SELECT gen_random_uuid(),installation_id,$1,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash FROM memory_authority_records WHERE version_id=$2`,[versionId,f.rule.versionId])
    await pool.query('UPDATE knowledge_claims SET current_version_id=$2,revision=revision+1 WHERE claim_id=$1',[f.rule.claimId,versionId])
    return versionId
  }
  return {f,deps,keys,bundle,service,request,edit,plan,originalAuthor,advanceRule}
}
