import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { createSkillPublicationFixture } from './skill-publication-fixture.js'
import { gitClaimFixture, gitWikiFixture, insertGitConnection } from './phase6-db-fixture.js'

export async function gitExportFixture(pool: pg.Pool, published = true) {
  const skill = await createSkillPublicationFixture(pool, { publish: published })
  const actor = await skill.actor(['scope_administrator'], ['read','contribute','review','publish','scope_admin'])
  const f = { installationId: skill.installationId, repositoryId: skill.repositoryId, scopeId: skill.installationId,
    membershipId: actor.membershipId!, grant: actor.grant }
  const connectionId = await insertGitConnection(pool, f)
  const source = (await pool.query('SELECT claim_id,version_id FROM knowledge_versions WHERE installation_id=$1', [f.installationId])).rows[0]
  const rule = await gitClaimFixture(pool, f, { claimType: 'test_invariant', noVersionRepository: true, scopeKey: skill.repositoryId })
  await pool.query(`UPDATE knowledge_versions SET source_promotion_candidate_id=$2,structured_content=$3,confidence='0.8723',branch='private-branch',freshness_at='2026-01-02T03:04:05Z' WHERE version_id=$1`,
    [rule.versionId, randomUUID(), { value: null, flags: ['strict'], retries: 7 }])
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility,locator,source_evidence_hash,contributor_membership_id)
    VALUES($1,$2,$3,$4,'episode','tests passed',$5,'2026-01-02T03:04:05Z',4,'shared',$6,$7,$8)`,
    [randomUUID(), f.installationId, rule.versionId, skill.episodeId, createHash('sha256').update('tests passed').digest(), { privatePath: '/private/source' }, 'b'.repeat(64), f.membershipId])
  await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
    SELECT $1,installation_id,$2,$3,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash FROM memory_authority_records WHERE version_id=$4`,
    [randomUUID(), rule.versionId, randomUUID(), source.version_id])
  const wiki = await gitWikiFixture(pool, f)
  const w = (await pool.query('SELECT source_snapshot_id,graph_version_id FROM memory_wiki_versions WHERE wiki_version_id=$1', [wiki.versionId])).rows[0]
  const runId = randomUUID(), pageId = randomUUID(), generatedSection = randomUUID(), manualSection = randomUUID(), manualVersionId = randomUUID(), nodeId = randomUUID()
  const sourceText='export const test = true\n',blobHash=createHash('sha256').update(sourceText).digest('hex')
  await pool.query('INSERT INTO memory_source_blobs(installation_id,blob_hash,byte_count,utf8_content) VALUES($1,$2,$3,$4)',[f.installationId,blobHash,Buffer.byteLength(sourceText),sourceText])
  await pool.query(`INSERT INTO memory_source_snapshot_entries(snapshot_id,installation_id,path,blob_hash,language,capability,byte_count,mode)
    VALUES($1,$2,'src/test.ts',$3,'typescript','symbols_and_edges',$4,'100644')`,[w.source_snapshot_id,f.installationId,blobHash,Buffer.byteLength(sourceText)])
  await pool.query(`UPDATE memory_wikis SET generation=1 WHERE wiki_id=$1`, [wiki.wikiId])
  await pool.query(`INSERT INTO memory_code_graph_heads(installation_id,repository_id,active_graph_version_id,revision) VALUES($1,$2,$3,1)`, [f.installationId,f.repositoryId,w.graph_version_id])
  await pool.query(`INSERT INTO memory_code_nodes(graph_version_id,installation_id,node_id,kind,stable_key,path,name,metadata)
    VALUES($1,$2,$3,'file','file:src/test.ts','src/test.ts','test.ts',$4)`, [w.graph_version_id,f.installationId,nodeId,{ content_hash:'c'.repeat(64) }])
  await pool.query(`INSERT INTO memory_wiki_build_runs(run_id,installation_id,wiki_id,generation,source_snapshot_id,graph_version_id,state,input_digest)
    VALUES($1,$2,$3,1,$4,$5,'published',$6)`, [runId,f.installationId,wiki.wikiId,w.source_snapshot_id,w.graph_version_id,'d'.repeat(64)])
  await pool.query(`UPDATE memory_wiki_versions SET build_run_id=$2 WHERE wiki_version_id=$1`,[wiki.versionId,runId])
  await pool.query(`INSERT INTO memory_wiki_build_sources(run_id,installation_id,source_token,ordinal,source_kind,stable_key,source_ref_id,source_snapshot_id,commit_sha,path,content_hash)
    VALUES($1,$2,'file-1',0,'file','file:src/test.ts',$3,$4,$5,'src/test.ts',$6)`, [runId,f.installationId,nodeId,w.source_snapshot_id,'a'.repeat(40),blobHash])
  await pool.query(`INSERT INTO memory_wiki_heads(installation_id,repository_id,wiki_id,active_version_id,revision) VALUES($1,$2,$3,$4,9007199254740993)`, [f.installationId,f.repositoryId,wiki.wikiId,wiki.versionId])
  await pool.query(`INSERT INTO memory_wiki_pages(wiki_version_id,installation_id,page_id,page_key,title,position) VALUES($1,$2,$3,'overview','Complete overview',0)`, [wiki.versionId,f.installationId,pageId])
  await pool.query(`INSERT INTO memory_wiki_sections(wiki_version_id,installation_id,section_id,page_id,section_key,heading,markdown,authority,coverage,position)
    VALUES($1,$2,$3,$4,'generated','Generated','File summary','generated','partial',0),($1,$2,$5,$4,'manual','Human','  Keep CRLF\r\n','locked','complete',1)`,[wiki.versionId,f.installationId,generatedSection,pageId,manualSection])
  await pool.query(`INSERT INTO memory_wiki_source_bindings(wiki_version_id,installation_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha)
    VALUES($1,$2,$3,$4,'file','file-1',$5,$6)`, [wiki.versionId,f.installationId,generatedSection,randomUUID(),w.source_snapshot_id,'a'.repeat(40)])
  await pool.query(`INSERT INTO memory_wiki_manual_section_versions(manual_version_id,installation_id,wiki_id,section_key,markdown,content_hash,actor_scope_kind,actor_scope_id,reason_code)
    VALUES($1,$2,$3,'manual','  Keep CRLF\r\n',$4,'team',$2::uuid::text,'fixture')`, [manualVersionId,f.installationId,wiki.wikiId,createHash('sha256').update('  Keep CRLF\r\n').digest('hex')])
  await pool.query(`INSERT INTO memory_wiki_manual_section_heads(installation_id,wiki_id,section_key,current_version_id,locked,lock_version)
    VALUES($1,$2,'manual',$3,true,9007199254740995)`, [f.installationId,wiki.wikiId,manualVersionId])
  return { ...f, connectionId, skill, rule, wiki, manualVersionId, nodeId, runId,
    keys: [{kind:'claim' as const,id:source.claim_id as string},{kind:'rule' as const,id:rule.claimId},{kind:'wiki' as const,id:wiki.wikiId},{kind:'skill' as const,id:skill.reviewed.skillId}] }
}
