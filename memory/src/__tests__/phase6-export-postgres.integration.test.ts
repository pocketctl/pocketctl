import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { verifyExportBase } from '../git-sync/attestation.js'
import { DOMAIN_FIELD_MAPPING } from '../git-sync/types.js'
import { skillFixtureDocument } from '../testing/skill-fixture.js'
import { createHash, randomUUID } from 'node:crypto'
import { validateSkillPublicationTarget } from '../skills/publication-validation.js'
import { decodeAsset, encodeAsset } from '../git-sync/codec.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
db('Phase 6 lossless authorized Ledger exports', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 8 }); await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await applyMemorySchema(pool) }, 60_000)
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations CASCADE') })
  afterAll(async () => { await pool?.end() })
  function setup(f: Awaited<ReturnType<typeof gitExportFixture>>) {
    const registry = attestationFixture().registry
    const service = createGitExportService({ pool, keys: registry, skill: { context: f.skill.context, cases: f.skill.cases } })
    const request = { installationId: f.installationId, connectionId: f.connectionId, expectedGeneration: '1',
      baseCommit: 'a'.repeat(40), purpose: 'external_export' as const, assets: f.keys }
    return { service, request, registry, run: () => service.export(f.grant, request) }
  }
  test('exports all four governed kinds with exact source-rich fields, controls and immutable no-op persistence', async () => {
    const f = await gitExportFixture(pool), s = setup(f), first = await s.run(), second = await s.run()
    expect(first).toEqual(second)
    expect(first.assets.map(a => a.asset.key.kind).sort()).toEqual(['claim','rule','skill','wiki'])
    expect(first).toMatchObject({ publishable:true, repositoryId:f.repositoryId, generation:'1' })
    expect(verifyExportBase(first, { installationId:f.installationId,repositoryId:f.repositoryId,connectionId:f.connectionId,
      exportId:first.exportId,generation:'1',baseCommit:'a'.repeat(40),tombstoneGeneration:'1',purpose:'external_export',publishable:true }, s.registry)).toBe(true)
    const rule = first.assets.find(a=>a.asset.key.kind==='rule')!.asset
    expect(rule).toMatchObject({ editable:{ statement:'Synthetic statement',structuredContent:{value:null,flags:['strict'],retries:7} },
      immutable:{confidence:'0.8723',freshnessAt:'2026-01-02T03:04:05.000Z',evidence:[{ordinal:4,visibility:'shared'}]},
      serverOnly:{repositoryId:null,branch:'private-branch',evidence:[{locator:{privatePath:'/private/source'},sourceEvidenceHash:'b'.repeat(64),contributorMembershipId:f.membershipId}]} })
    const wiki = first.assets.find(a=>a.asset.key.kind==='wiki')!.asset
    expect(wiki).toMatchObject({baseRevision:'9007199254740993',immutable:{evidence:[],pages:[{sections:[{authority:'generated'},{authority:'locked',manualVersionId:f.manualVersionId,lockVersion:'9007199254740995',sourceBindings:[]}]}]},
      editable:{pages:[{title:'Complete overview',sections:[{coverage:'partial'},{markdown:'  Keep CRLF\r\n'}]}]},serverOnly:{manualVersions:[{reasonCode:'fixture',manualVersionId:f.manualVersionId}]}})
    const skill = first.assets.find(a=>a.asset.key.kind==='skill')!.asset
    expect(skill).toMatchObject({baseVersionId:f.skill.reviewed.versionId,immutable:{publicationState:'active',replayState:'passed'},editable:{document:skillFixtureDocument()}})
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots')).rowCount).toBe(1)
    expect((await pool.query('SELECT 1 FROM memory_skill_versions')).rowCount).toBe(1)
    expect((await pool.query('SELECT 1 FROM knowledge_versions')).rowCount).toBe(2)
    const wire = first.files.map(file=>Buffer.from(file.bytes).toString()).join('\n')
    expect(wire).not.toMatch(/privatePath|private-branch|serverOnly|credential/)
  })
  test('covers every current domain column, including Wiki and Skill child fields', async () => {
    for (const [table,mapping] of Object.entries(DOMAIN_FIELD_MAPPING)) {
      const rows = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])
      expect(rows.rows.map(r=>r.column_name).sort(),table).toEqual(Object.keys(mapping).sort())
    }
  })
  test.each(['personal','unpublished','expired','revoked','deleted','tombstoned','private_evidence','bad_hash','missing_authority','wrong_scope','wrong_repository'] as const)('rejects %s source before persisting an export', async mutation => {
    const f=await gitExportFixture(pool), s=setup(f), id=f.rule.versionId
    if(mutation==='personal') await pool.query("UPDATE knowledge_claims SET owner_scope_kind='personal' WHERE claim_id=$1",[f.rule.claimId])
    if(mutation==='unpublished') await pool.query("UPDATE knowledge_versions SET authority='user_accepted',source_promotion_candidate_id=NULL WHERE version_id=$1",[id])
    if(mutation==='expired') await pool.query("UPDATE knowledge_versions SET valid_until=NOW()-INTERVAL '1 second' WHERE version_id=$1",[id])
    if(mutation==='revoked') await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[f.rule.claimId])
    if(mutation==='deleted') await pool.query('DELETE FROM work_episodes WHERE episode_id=$1',[f.skill.episodeId])
    if(mutation==='tombstoned') await pool.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'shared-governance','fixture',NOW())",[f.installationId])
    if(mutation==='private_evidence') await pool.query("UPDATE knowledge_evidence SET visibility='personal' WHERE version_id=$1",[id])
    if(mutation==='bad_hash') await pool.query("UPDATE knowledge_evidence SET excerpt='changed behind hash' WHERE version_id=$1",[id])
    if(mutation==='missing_authority') await pool.query('DELETE FROM memory_authority_records WHERE version_id=$1',[id])
    if(mutation==='wrong_scope') await pool.query('UPDATE knowledge_claims SET owner_scope_id=$2 WHERE claim_id=$1',[f.rule.claimId,randomUUID()])
    if(mutation==='wrong_repository') await pool.query("UPDATE knowledge_claims SET scope_key='different' WHERE claim_id=$1",[f.rule.claimId])
    await expect(s.run()).rejects.toThrow(/git_source|skill_|source_|not_found/)
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots')).rowCount).toBe(0)
  })
  test.each(['manual_missing','manual_wrong_key','manual_changed','graph_stale','binding_missing','node_deleted','blob_missing','source_hash_wrong'] as const)('rejects stale Wiki provenance: %s', async mutation => {
    const f=await gitExportFixture(pool),s=setup(f)
    if(mutation==='manual_missing')await pool.query('DELETE FROM memory_wiki_manual_section_heads WHERE wiki_id=$1',[f.wiki.wikiId])
    if(mutation==='manual_wrong_key')await pool.query("UPDATE memory_wiki_manual_section_versions SET section_key='forged' WHERE manual_version_id=$1",[f.manualVersionId])
    if(mutation==='manual_changed')await pool.query("UPDATE memory_wiki_manual_section_versions SET markdown='different' WHERE manual_version_id=$1",[f.manualVersionId])
    if(mutation==='graph_stale')await pool.query("UPDATE memory_code_graph_versions SET state='superseded' WHERE installation_id=$1",[f.installationId])
    if(mutation==='binding_missing')await pool.query('DELETE FROM memory_wiki_source_bindings WHERE wiki_version_id=$1',[f.wiki.versionId])
    if(mutation==='node_deleted')await pool.query('DELETE FROM memory_code_nodes WHERE node_id=$1',[f.nodeId])
    if(mutation==='blob_missing')await pool.query('DELETE FROM memory_source_snapshot_entries WHERE installation_id=$1',[f.installationId])
    if(mutation==='source_hash_wrong')await pool.query("UPDATE memory_wiki_build_sources SET content_hash=repeat('e',64) WHERE run_id=$1",[f.runId])
    await expect(s.run()).rejects.toThrow(/git_source/)
  })
  test('uses published Skill version despite newer draft; preview is explicitly nonpublishable', async () => {
    const f=await gitExportFixture(pool),s=setup(f)
    const draft=await f.skill.review.execute(f.skill.author,{action:'edit',skillId:f.skill.reviewed.skillId,expectedRevision:f.skill.reviewed.revision,document:{...skillFixtureDocument(),title:'Unpublished draft'}})
    expect((await s.run()).assets.find(a=>a.asset.key.kind==='skill')!.asset.baseVersionId).toBe(f.skill.reviewed.versionId)
    const preview=await s.service.export(f.grant,{...s.request,purpose:'local_preview'})
    expect(preview).toMatchObject({publishable:false})
    expect(preview.assets.find(a=>a.asset.key.kind==='skill')!.asset.baseVersionId).toBe(draft.versionId)
    const exported=(await s.run()).assets.find(a=>a.asset.key.kind==='skill')!.asset
    expect(exported).toMatchObject({baseVersionId:f.skill.reviewed.versionId,immutable:{state:'reviewed'},
      serverOnly:{editableHeadVersionId:draft.versionId,editableHeadRevision:String(draft.revision),editableHeadState:'draft'}})
    expect(decodeAsset(encodeAsset(exported),{asset:exported,contentHash:'a'.repeat(64),deleted:false})).toEqual(exported)
  })
  test.each(['unpublished','publisher_expired','reviewer_expired','recording_changed','replay_session_deleted','policy_changed'] as const)('rejects Skill publication eligibility after %s', async mutation => {
    const f=await gitExportFixture(pool,mutation!=='unpublished'),s=setup(f)
    if(mutation==='publisher_expired'||mutation==='reviewer_expired')await pool.query("UPDATE memory_scope_memberships SET valid_until=NOW()-INTERVAL '1 second' WHERE membership_id=$1",[mutation==='publisher_expired'?f.skill.publisher.membershipId:f.skill.reviewer.membershipId])
    if(mutation==='recording_changed')f.skill.reviewed.records[0]!.steps[0]!.response={matches:99}
    if(mutation==='replay_session_deleted')await pool.query('UPDATE source_sessions SET deleted_at=NOW() WHERE installation_id=$1 AND session_id=$2',[f.installationId,f.skill.sessionId])
    if(mutation==='policy_changed')await pool.query("UPDATE memory_owner_scopes SET authorization_epoch=2 WHERE installation_id=$1",[f.installationId])
    await expect(s.run()).rejects.toThrow(mutation==='policy_changed'?/git_forbidden/:/git_source/)
  })
  test('refreshes baseline for revision/source changes without changing semantic content or appending versions', async () => {
    const f=await gitExportFixture(pool),s=setup(f),first=await s.run()
    await pool.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[f.rule.claimId])
    const second=await s.run();expect(second.exportId).not.toBe(first.exportId)
    await pool.query("UPDATE knowledge_evidence SET locator='{" + '"privatePath":"/private/new"' + "}' WHERE version_id=$1",[f.rule.versionId])
    const third=await s.run();expect(third.exportId).not.toBe(second.exportId)
    expect(first.assets.find(a=>a.asset.key.kind==='rule')!.contentHash).toBe(third.assets.find(a=>a.asset.key.kind==='rule')!.contentHash)
    expect((await pool.query('SELECT 1 FROM knowledge_versions')).rowCount).toBe(2)
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots')).rowCount).toBe(3)
  })
  test('serial concurrent exports share one persisted baseline and reject stale generation', async () => {
    const f=await gitExportFixture(pool),s=setup(f),values=await Promise.all([s.run(),s.run()])
    expect(values[0].exportId).toBe(values[1].exportId)
    await pool.query('UPDATE memory_git_connections SET generation=2 WHERE connection_id=$1',[f.connectionId])
    await expect(s.run()).rejects.toThrow(/git_generation_conflict/)
  })
  test('registered base rejects unknown, cross-tenant, deleted and old-generation exports even with valid signatures', async () => {
    const f=await gitExportFixture(pool),s=setup(f),bundle=await s.run()
    const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:bundle.exportId}
    expect(await s.service.loadRegisteredBase(f.grant,request)).toEqual(bundle)
    await expect(s.service.loadRegisteredBase(f.grant,{...request,exportId:randomUUID()})).rejects.toThrow(/git_export_unregistered/)
    await expect(s.service.loadRegisteredBase(f.grant,{...request,installationId:randomUUID()})).rejects.toThrow(/git_export_unregistered/)
    await pool.query('UPDATE memory_git_connections SET generation=2 WHERE connection_id=$1',[f.connectionId])
    await expect(s.service.loadRegisteredBase(f.grant,{...request,expectedGeneration:'2'})).rejects.toThrow(/git_export_unregistered/)
    await pool.query('DELETE FROM knowledge_claims WHERE claim_id=$1',[f.rule.claimId])
    await expect(s.service.loadRegisteredBase(f.grant,{...request,expectedGeneration:'2'})).rejects.toThrow(/git_export_unregistered/)
  })
  test('rejects Evidence whose surviving event points at a deleted source session', async () => {
    const f=await gitExportFixture(pool),s=setup(f),eventId=randomUUID(),sessionId=randomUUID()
    await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at,deleted_at) VALUES($1,$2,NOW(),NOW(),NOW())',[f.installationId,sessionId])
    await pool.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,payload,payload_hash)
      VALUES($1,$2,'feed',$1::uuid::text,$3,'test',NOW(),'{}',decode(repeat('a',64),'hex'))`,[eventId,f.installationId,sessionId])
    await pool.query("UPDATE knowledge_evidence SET evidence_kind='event',source_event_id=$2 WHERE version_id=$1",[f.rule.versionId,eventId])
    await expect(s.run().then(()=>undefined)).rejects.toThrow(/git_source_stale/)
  })
  test('purge commits before waiting exporter reads tombstone; export-first deletion removes the entire immutable bundle', async () => {
    const f=await gitExportFixture(pool),s=setup(f),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':shared-governance',0))",[f.installationId])
      const pending=s.run().then(()=> 'unexpected_success',error=>(error as Error).message)
      let waiting=false
      for(let i=0;i<100&&!waiting;i++) {
        waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting")).rows[0].waiting
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,5))
      }
      expect(waiting).toBe(true)
      await client.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'shared-governance','fixture',NOW())",[f.installationId])
      await client.query('COMMIT')
      expect(await pending).toBe('git_source_stale')
    } finally {await client.query('ROLLBACK');client.release()}
    await pool.query('TRUNCATE memory_installations CASCADE')
    const next=await gitExportFixture(pool),nextService=setup(next),exported=await nextService.run()
    await pool.query('DELETE FROM work_episodes WHERE installation_id=$1 AND episode_id=$2',[next.installationId,next.skill.episodeId])
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots WHERE export_id=$1',[exported.exportId])).rowCount).toBe(0)
  })
  test('publication validator accepts decimal-string revision and rejects malformed or unsafe numeric revisions', async () => {
    const f=await gitExportFixture(pool),client=await pool.connect()
    try {
      await client.query('BEGIN')
      const target={skillId:f.skill.reviewed.skillId,versionId:f.skill.reviewed.versionId,expectedRevision:String(f.skill.reviewed.revision),mode:'execution' as const,allowHistoricalVersion:true}
      await expect(validateSkillPublicationTarget(client,f.skill.reader,target,f.skill.deps)).resolves.toMatchObject({replayRunId:f.skill.reviewed.evidence.runId})
      for(const revision of ['02','9007199254740993',9007199254740992,'9223372036854775808']) {
        await expect(validateSkillPublicationTarget(client,f.skill.reader,{...target,expectedRevision:revision},f.skill.deps)).rejects.toMatchObject({code:'revision_conflict'})
      }
    } finally {await client.query('ROLLBACK');client.release()}
  })
  async function knowledgeWiki(f:Awaited<ReturnType<typeof gitExportFixture>>,kind:'claim_version'|'evidence') {
    const evidence=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[f.rule.versionId])).rows[0]
    // Independent fixture contract, deliberately not the production helper.
    const hash=createHash('sha256').update(kind==='claim_version'
      ? '{"statement":"Synthetic statement","structuredContent":{"flags":["strict"],"retries":7,"value":null}}'
      : 'tests passed').digest('hex')
    await pool.query(`UPDATE memory_wiki_build_sources SET source_kind=$2,source_ref_id=$3,stable_key=$4,
      source_snapshot_id=NULL,commit_sha=NULL,path=NULL,content_hash=$5 WHERE run_id=$1`,[f.runId,kind,kind==='claim_version'?f.rule.versionId:evidence.evidence_id,`${kind}:fixture`,hash])
    await pool.query(`UPDATE memory_wiki_source_bindings SET source_kind=$2,source_snapshot_id=NULL,commit_sha=NULL WHERE wiki_version_id=$1`,[f.wiki.versionId,kind])
  }
  test.each(['claim_version','evidence'] as const)('rejects %s-backed Wiki recorded hash mismatch and rehashed source edits',async kind=>{
    const f=await gitExportFixture(pool),s=setup(f)
    await knowledgeWiki(f,kind)
    const request={...s.request,assets:f.keys.filter(key=>key.kind==='wiki')}
    await expect(s.service.export(f.grant,request)).resolves.toMatchObject({assets:[{asset:{key:{kind:'wiki'}}}]})
    await pool.query('DELETE FROM memory_git_snapshots WHERE connection_id=$1',[f.connectionId])
    request.expectedGeneration=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])).rows[0].generation
    await pool.query("UPDATE memory_wiki_build_sources SET content_hash=repeat('e',64) WHERE run_id=$1",[f.runId])
    await expect(s.service.export(f.grant,request).then(()=>undefined)).rejects.toThrow(/git_source_stale/)
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots')).rowCount).toBe(0)
    await knowledgeWiki(f,kind)
    if(kind==='evidence')await pool.query("UPDATE knowledge_evidence SET excerpt='Changed',excerpt_hash=$2 WHERE version_id=$1",[f.rule.versionId,createHash('sha256').update('Changed').digest()])
    else await pool.query("UPDATE knowledge_versions SET structured_content='{}' WHERE version_id=$1",[f.rule.versionId])
    await expect(s.service.export(f.grant,request).then(()=>undefined)).rejects.toThrow(/git_source_stale/)
    expect((await pool.query('SELECT 1 FROM memory_git_snapshots')).rowCount).toBe(0)
  })
  async function advanceRule(f:Awaited<ReturnType<typeof gitExportFixture>>) {
    const versionId=randomUUID(),episodeId=randomUUID(),sessionId=randomUUID(),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version)
        VALUES($1,$2,$3,$2::uuid::text,'ready','fixture')`,[f.installationId,episodeId,sessionId])
      await client.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,source_promotion_candidate_id)
        SELECT $1,installation_id,claim_id,2,'Version two','{}',authority,confidence,source_promotion_candidate_id FROM knowledge_versions WHERE version_id=$2`,[versionId,f.rule.versionId])
      await client.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
        SELECT $1,installation_id,$2,$3,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility FROM knowledge_evidence WHERE version_id=$4`,[randomUUID(),versionId,episodeId,f.rule.versionId])
      await client.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
        SELECT $1,installation_id,$2,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash FROM memory_authority_records WHERE version_id=$3`,[randomUUID(),versionId,f.rule.versionId])
      await client.query('UPDATE knowledge_claims SET current_version_id=$2,revision=revision+1 WHERE claim_id=$1',[f.rule.claimId,versionId])
      await client.query('COMMIT')
    } catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    return versionId
  }
  test.each(['expired','private_evidence'] as const)('preserves eligible historical B but rejects its original %s source after V2 becomes current',async mutation=>{
    const f=await gitExportFixture(pool),s=setup(f),request={...s.request,assets:f.keys.filter(key=>key.kind==='rule')}
    const original=await s.service.export(f.grant,request),versionId=await advanceRule(f)
    const saved={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:original.exportId}
    expect((await s.service.export(f.grant,request)).assets[0].asset.baseVersionId).toBe(versionId)
    expect((await s.service.loadRegisteredBase(f.grant,saved)).assets[0].asset.baseVersionId).toBe(f.rule.versionId)
    if(mutation==='expired')await pool.query("UPDATE knowledge_versions SET valid_until=NOW()-INTERVAL '1 second' WHERE version_id=$1",[f.rule.versionId])
    else await pool.query("UPDATE knowledge_evidence SET visibility='personal' WHERE version_id=$1",[f.rule.versionId])
    expect(BigInt((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])).rows[0].generation)).toBeGreaterThan(1n)
    await expect(s.service.loadRegisteredBase(f.grant,saved).then(()=>undefined)).rejects.toThrow(/git_export_unregistered/)
  })
  test('registered historical B waits on its original source session after current head changes',async()=>{
    const f=await gitExportFixture(pool),s=setup(f),request={...s.request,assets:f.keys.filter(key=>key.kind==='rule')}
    const original=await s.service.export(f.grant,request);await advanceRule(f)
    const client=await pool.connect()
    let pending:Promise<string>|undefined
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':shared-governance',0))",[f.installationId])
      pending=s.service.loadRegisteredBase(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:original.exportId}).then(()=> 'unexpected_success',error=>(error as Error).message)
      let waiting=false
      for(let i=0;i<100&&!waiting;i++) {
        waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting")).rows[0].waiting
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,5))
      }
      expect(waiting).toBe(true)
      await client.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'shared-governance','fixture',NOW())",[f.installationId])
      await client.query('COMMIT')
      expect(await pending).toBe('git_generation_conflict')
    } finally {await client.query('ROLLBACK');client.release();await pending}
  })
  test('historical Wiki B retains original build Claim provenance after a newer Wiki publishes',async()=>{
    const f=await gitExportFixture(pool),s=setup(f)
    await knowledgeWiki(f,'claim_version')
    const request={...s.request,assets:f.keys.filter(key=>key.kind==='wiki')},original=await s.service.export(f.grant,request)
    const sourceVersionId=await advanceRule(f),wikiVersionId=randomUUID(),runId=randomUUID(),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO memory_wiki_build_runs(run_id,installation_id,wiki_id,generation,source_snapshot_id,graph_version_id,state,input_digest)
        SELECT $1,installation_id,wiki_id,2,source_snapshot_id,graph_version_id,'published',input_digest FROM memory_wiki_build_runs WHERE run_id=$2`,[runId,f.runId])
      await client.query(`INSERT INTO memory_wiki_build_sources(run_id,installation_id,source_token,ordinal,source_kind,stable_key,source_ref_id,source_snapshot_id,commit_sha,path,content_hash)
        SELECT $1,installation_id,source_token,ordinal,source_kind,stable_key,$2,source_snapshot_id,commit_sha,path,$3 FROM memory_wiki_build_sources WHERE run_id=$4`,
        [runId,sourceVersionId,createHash('sha256').update('{"statement":"Version two","structuredContent":{}}').digest('hex'),f.runId])
      await client.query("UPDATE memory_wiki_versions SET state='superseded' WHERE wiki_version_id=$1",[f.wiki.versionId])
      await client.query(`INSERT INTO memory_wiki_versions(wiki_version_id,installation_id,wiki_id,revision,source_snapshot_id,graph_version_id,build_run_id,content_hash)
        SELECT $1,installation_id,wiki_id,2,source_snapshot_id,graph_version_id,$2,content_hash FROM memory_wiki_versions WHERE wiki_version_id=$3`,[wikiVersionId,runId,f.wiki.versionId])
      await client.query(`INSERT INTO memory_wiki_pages(wiki_version_id,installation_id,page_id,page_key,title,position)
        SELECT $1,installation_id,page_id,page_key,title,position FROM memory_wiki_pages WHERE wiki_version_id=$2`,[wikiVersionId,f.wiki.versionId])
      await client.query(`INSERT INTO memory_wiki_sections(wiki_version_id,installation_id,section_id,page_id,section_key,heading,markdown,authority,coverage,position)
        SELECT $1,installation_id,section_id,page_id,section_key,heading,markdown,authority,coverage,position FROM memory_wiki_sections WHERE wiki_version_id=$2`,[wikiVersionId,f.wiki.versionId])
      await client.query(`INSERT INTO memory_wiki_source_bindings(wiki_version_id,installation_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha)
        SELECT $1,installation_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha FROM memory_wiki_source_bindings WHERE wiki_version_id=$2`,[wikiVersionId,f.wiki.versionId])
      await client.query('UPDATE memory_wiki_heads SET active_version_id=$2,revision=revision+1 WHERE wiki_id=$1',[f.wiki.wikiId,wikiVersionId])
      await client.query('UPDATE memory_wikis SET generation=2 WHERE wiki_id=$1',[f.wiki.wikiId])
      await client.query('COMMIT')
    } catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    const saved={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:original.exportId}
    expect((await s.service.export(f.grant,request)).assets[0].asset.baseVersionId).toBe(wikiVersionId)
    expect((await s.service.loadRegisteredBase(f.grant,saved)).assets[0].asset.baseVersionId).toBe(f.wiki.versionId)
    await pool.query("UPDATE knowledge_versions SET valid_until=NOW()-INTERVAL '1 second' WHERE version_id=$1",[f.rule.versionId])
    await expect(s.service.loadRegisteredBase(f.grant,saved).then(()=>undefined)).rejects.toThrow(/git_export_unregistered/)
    expect((await s.service.export(f.grant,{...request,expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])).rows[0].generation})).assets[0].asset.baseVersionId).toBe(wikiVersionId)
  })
  test('historical Skill draft B remains readable after editing, but its explicit version revocation is enforced',async()=>{
    const f=await gitExportFixture(pool),s=setup(f),request={...s.request,purpose:'local_preview',assets:f.keys.filter(key=>key.kind==='skill')}
    const original=await s.service.export(f.grant,request)
    const draft=await f.skill.review.execute(f.skill.author,{action:'edit',skillId:f.skill.reviewed.skillId,expectedRevision:f.skill.reviewed.revision,document:{...skillFixtureDocument(),title:'New draft'}})
    const saved={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:original.exportId}
    expect((await s.service.export(f.grant,request)).assets[0].asset.baseVersionId).toBe(draft.versionId)
    expect((await s.service.loadRegisteredBase(f.grant,saved)).assets[0].asset.baseVersionId).toBe(f.skill.reviewed.versionId)
    await pool.query('INSERT INTO memory_skill_version_revocations(installation_id,skill_id,version_id) VALUES($1,$2,$3)',[f.installationId,draft.skillId,f.skill.reviewed.versionId])
    await expect(s.service.loadRegisteredBase(f.grant,saved).then(()=>undefined)).rejects.toThrow(/git_export_unregistered/)
    expect((await s.service.export(f.grant,{...request,expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])).rows[0].generation})).assets[0].asset.baseVersionId).toBe(draft.versionId)
  })
})
