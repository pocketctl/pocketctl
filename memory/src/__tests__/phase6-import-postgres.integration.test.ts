import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitImportFixture } from '../testing/phase6-import-fixture.js'
import type { RuleAsset, WikiAsset } from '../git-sync/types.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 governed import atomic application',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:10});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function setup(kinds=['rule'],unlockedWiki=false) {
    const s=await gitImportFixture(pool,kinds,unlockedWiki)
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    // Loading happens after the real fixtures, so initial RED demonstrates the
    // missing application boundary without preventing existing tests collecting.
    const mod=await import('../git-sync/import-service.js').catch(()=>null)
    const service=mod?.createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const})
    return {...s,imports:service}
  }
  const subject=(s:Awaited<ReturnType<typeof setup>>,id:string)=>({installationId:s.f.installationId,connectionId:s.f.connectionId,
    expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:id,expectedRevision:'1'})
  test('retained exact Skill coauthor cannot self review or supply publication quorum after projection cleanup',async()=>{
    const s=await setup(['skill']),resolver=await s.f.skill.actor(['contributor','reviewer'],['read','contribute','review'])
    const files=s.edit(s.bundle.files,v=>{if(v.key)v.editable.document.title='Original Git title'})
    const {proposals:[p]}=await s.plan(files),editable=structuredClone(s.bundle.assets[0].asset.editable) as any
    editable.document.title='Material resolver title'
    const resolved=await s.service.resolve(resolver.grant,{...s.request,files,proposalId:p.proposalId,expectedRevision:p.revision,expectedInputs:p.inputs,
      resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable}})
    const input={...subject(s,p.proposalId),expectedRevision:resolved.revision}
    await s.imports!.review(s.f.skill.reviewer.grant,{...input,decision:'approve'})
    const result=await s.imports!.apply(s.f.skill.publisher.grant,input)
    await pool.query("UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id=$1",[s.f.connectionId])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT version_id FROM memory_git_retained_outcomes')).rows).toEqual([{version_id:result.versionId}])
    const revision=s.f.skill.reviewed.revision+1,request={action:'approve',skillId:s.f.skill.reviewed.skillId,expectedRevision:revision}
    await expect(s.f.skill.review.execute({installationId:s.f.installationId,grant:resolver.grant},request)).rejects.toThrow('self_review_denied')
    await expect(s.f.skill.review.execute({installationId:s.f.installationId,grant:s.originalAuthor.grant},request)).rejects.toThrow('self_review_denied')
    // A decision admitted by the historical bug must also be excluded by the
    // actual publication caller; do not rely only on blocking future writes.
    await pool.query(`INSERT INTO memory_skill_review_decisions(decision_id,installation_id,skill_id,version_id,document_hash,source_digest,policy_hash,
      actor_kind,actor_id,membership_revision,authorization_epoch,decision)
      SELECT gen_random_uuid(),installation_id,skill_id,version_id,document_hash,source_digest,policy_hash,'membership',$2,1,1,'approve'
      FROM memory_skill_versions WHERE version_id=$1`,[result.versionId,resolver.membershipId])
    await pool.query("UPDATE memory_skill_heads SET state='reviewed' WHERE current_version_id=$1",[result.versionId])
    await expect(s.f.skill.publication.execute(s.f.skill.publisher,{...s.f.skill.publishRequest,versionId:result.versionId,
      expectedRevision:revision,expectedPublicationRevision:1})).rejects.toThrow('review_required')
    await expect(s.f.skill.review.execute(s.f.skill.reviewer,request)).resolves.toMatchObject({versionId:result.versionId,state:'reviewed'})
  })
  test.each(['rule','claim','wiki'])('applied %s rename is retained by signed re-export and dedupe',async kind=>{
    const s=await setup([kind]),{encodeAsset}=await import('../git-sync/codec.js'),{createGitExportService}=await import('../git-sync/export-service.js')
    const asset=structuredClone(s.bundle.assets[0].asset),oldFiles=encodeAsset(asset),oldPaths=new Set(oldFiles.map(f=>f.path))
    asset.path=kind==='wiki'?'.pocketctl/knowledge/wiki/renamed/wiki.yaml':`.pocketctl/knowledge/claims/renamed-${kind}.yaml`
    const files=[...s.bundle.files.filter(f=>!oldPaths.has(f.path)),...encodeAsset(asset)],{proposals:[p]}=await s.plan(files)
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const applied=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    const request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',baseCommit:s.request.headCommit,purpose:'external_export',assets:[asset.key]}
    const exports=createGitExportService(s.deps),fresh=await exports.export(s.f.grant,request)
    expect(fresh.exportId).not.toBe(s.bundle.exportId)
    expect(fresh.assets[0].asset).toMatchObject({path:asset.path,baseVersionId:applied.versionId})
    expect(fresh.files.some(f=>oldPaths.has(f.path))).toBe(false)
    if(kind==='wiki')expect(fresh.files.some(f=>f.path==='.pocketctl/knowledge/wiki/renamed/overview.md')).toBe(true)
    expect(await exports.export(s.f.grant,request)).toEqual(fresh)
    expect(await exports.loadRegisteredBase(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:fresh.exportId})).toEqual(fresh)
  })
  test.each(['registered','internal'])('partial batch continues remaining conflict through %s resolution without reapplying sibling',async entry=>{
    const s=await setup(['rule','wiki']),{encodeAsset}=await import('../git-sync/codec.js')
    await s.advanceRule()
    const wiki=structuredClone(s.bundle.assets.find(a=>a.asset.key.kind==='wiki')!.asset) as WikiAsset
    wiki.editable.pages[0].title='Applied independent Wiki'
    const replacements=encodeAsset(wiki),paths=new Set(replacements.map(f=>f.path))
    const files=[...s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.structuredContent.retries=11}).filter(f=>!paths.has(f.path)),...replacements]
    const {proposals}=await s.plan(files),A=proposals.find(p=>p.key.kind==='wiki')!,B=proposals.find(p=>p.key.kind==='rule')!
    expect(B.result.kind).toBe('conflict')
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,A.proposalId),decision:'approve'})
    const applied=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,A.proposalId))
    const {createGitReadService}=await import('../git-sync/read-service.js'),{loadGitSyncConfig}=await import('../git-sync/config.js')
    const view=await createGitReadService({...s.deps,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),scopeMode:async()=> 'enabled',targets:{resolve:async()=>null}})
      .proposal({installationId:s.f.installationId,grant:s.f.grant},B.proposalId)
    expect(view.capabilities.can_resolve).toBe(true)
    const oldA=(await pool.query('SELECT * FROM memory_git_import_proposals WHERE proposal_id=$1',[A.proposalId])).rows[0]
    const common={...subject(s,B.proposalId),expectedInputs:B.inputs,resolution:{path:s.bundle.assets.find(a=>a.asset.key.kind==='rule')!.asset.path,
      deleted:false,editable:{statement:'Resolved remaining Rule',structuredContent:{value:null,flags:['strict'],retries:12}}}}
    const resolved=entry==='registered'?await s.service.resolveRegistered(s.f.grant,{...common,expectedPolicyHash:B.policyHash,expectedProposedHash:B.proposedHash,expectedAssetRevision:'2'})
      :await s.service.resolve(s.f.grant,{...s.request,...common,files})
    const input={...subject(s,B.proposalId),expectedRevision:resolved.revision}
    await s.imports!.review(s.f.skill.reviewer.grant,{...input,decision:'approve'})
    await expect(s.imports!.apply(s.f.skill.publisher.grant,input)).resolves.toMatchObject({outcome:'published'})
    expect(await s.imports!.apply(s.f.skill.publisher.grant,subject(s,A.proposalId))).toEqual(applied)
    expect((await pool.query('SELECT * FROM memory_git_import_proposals WHERE proposal_id=$1',[A.proposalId])).rows[0]).toEqual(oldA)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(2)
    expect((await pool.query('SELECT count(*)::int n FROM memory_wiki_versions WHERE wiki_id=$1',[wiki.key.id])).rows[0].n).toBe(2)
    expect((await s.service.plan(s.f.grant,{...s.request,files})).every(p=>p.state==='applied')).toBe(true)
  })
  test.each(['registered','internal'].flatMap(entry=>['memory','git','source','authorization','namespace','applied_version','policy','generation'].map(change=>({entry,change}))))(
    'partial $entry resolution still rejects real $change changes',async({entry,change})=>{
      const s=await setup(['rule','wiki']),{encodeAsset}=await import('../git-sync/codec.js')
      await s.advanceRule()
      const wiki=structuredClone(s.bundle.assets.find(a=>a.asset.key.kind==='wiki')!.asset) as WikiAsset
      wiki.editable.pages[0].title='Applied A'
      const replacements=encodeAsset(wiki),paths=new Set(replacements.map(f=>f.path))
      let files=[...s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.structuredContent.retries=11}).filter(f=>!paths.has(f.path)),...replacements]
      const {proposals}=await s.plan(files),A=proposals.find(p=>p.key.kind==='wiki')!,B=proposals.find(p=>p.key.kind==='rule')!
      await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,A.proposalId),decision:'approve'})
      await s.imports!.apply(s.f.skill.publisher.grant,subject(s,A.proposalId))
      const path='.pocketctl/knowledge/claims/resolved.yaml'
      if(change==='memory')await pool.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[s.f.rule.claimId])
      if(change==='git'){
        files=s.edit(files,v=>{if(v.key?.kind==='rule')v.editable.structuredContent.retries=13})
        if(entry==='registered')await pool.query(`UPDATE memory_git_import_proposals SET revision=revision+1,
          proposed_document=jsonb_set(proposed_document,'{gitSnapshot,asset,editable,structuredContent,retries}','13') WHERE proposal_id=$1`,[B.proposalId])
      }
      if(change==='source')await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
      if(change==='authorization')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.membershipId])
      if(change==='generation')await pool.query('UPDATE memory_git_connections SET generation=generation+1 WHERE connection_id=$1',[s.f.connectionId])
      if(change==='namespace')await pool.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,skill_id,path)
        VALUES(gen_random_uuid(),$1,$2,$3,'skill',$4,$5)`,[s.f.installationId,s.f.connectionId,s.f.repositoryId,s.f.skill.reviewed.skillId,path+'/child.yaml'])
      if(change==='applied_version')await pool.query('UPDATE memory_wiki_heads SET active_version_id=$2,revision=revision+1 WHERE wiki_id=$1',[wiki.key.id,s.f.wiki.versionId])
      if(change==='policy'){
        const {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY}=await import('../governance/review-policy.js')
        const revision=(await pool.query('SELECT revision FROM memory_review_policy_heads h JOIN memory_review_policy_sets s USING(policy_id) WHERE s.installation_id=$1',[s.f.installationId])).rows[0].revision
        await createReviewPolicyRepository(pool).publishVersion({installationId:s.f.installationId,document:{...DEFAULT_TEAM_REVIEW_POLICY,minimum_approvals:2},createdByMembershipId:s.f.membershipId,expectedRevision:Number(revision)})
      }
      const common={...subject(s,B.proposalId),expectedRevision:change==='git'&&entry==='registered'?'2':'1',expectedInputs:B.inputs,
        resolution:{path,deleted:false,editable:{statement:'Resolved B',structuredContent:{value:null,flags:['strict'],retries:12}}}}
      const run=()=>entry==='registered'?s.service.resolveRegistered(s.f.grant,{...common,expectedPolicyHash:B.policyHash,expectedProposedHash:B.proposedHash,expectedAssetRevision:'2'})
        :s.service.resolve(s.f.grant,{...s.request,...common,files})
      await expect(run()).rejects.toThrow()
      expect((await pool.query(`SELECT count(*)::int n FROM (SELECT proposal_id FROM memory_git_import_outcomes UNION SELECT proposal_id FROM memory_git_retained_outcomes) o`)).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM memory_wiki_versions WHERE wiki_id=$1',[wiki.key.id])).rows[0].n).toBe(2)
    })
  test('same-Scope reviewed edit appends one version and atomically confirms its link and outcome',async()=>{
    const s=await setup(),{proposals:[p]}=await s.plan()
    expect(s.imports,'governed import boundary exists').toBeDefined()
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const out=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect(out).toMatchObject({outcome:'published',proposalId:p.proposalId})
    const row=(await pool.query(`SELECT c.claim_id,c.revision::text,v.version_number,v.statement,v.source_promotion_candidate_id,
      o.outcome,l.version_id,p.state FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id=c.current_version_id
      JOIN memory_git_revision_links l ON l.claim_version_id=v.version_id JOIN memory_git_import_outcomes o USING(link_id)
      JOIN memory_git_import_proposals p ON p.proposal_id=o.proposal_id WHERE c.claim_id=$1`,[s.f.rule.claimId])).rows[0]
    expect(row).toMatchObject({claim_id:s.f.rule.claimId,revision:'2',version_number:2,statement:'Governed Git edit',outcome:'published',state:'applied'})
    expect(row.source_promotion_candidate_id).toBe((s.bundle.assets[0].asset as RuleAsset).serverOnly.sourcePromotionCandidateId)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_confirmed_bases')).rows[0].n).toBe(1)
    expect(await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).toEqual(out)
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(2)
  })
  test('unknown exact Git author cannot be replaced by triggering publisher',async()=>{
    const s=await setup(),{proposals:[p]}=await s.plan(undefined,null)
    expect(s.imports).toBeDefined()
    await expect(s.imports!.apply(s.f.grant,subject(s,p.proposalId))).rejects.toThrow('git_identity_unknown')
    expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].current_version_id).toBe(s.f.rule.versionId)
    expect((await pool.query('SELECT state FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].state).toBe('awaiting_identity')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='apply' AND outcome='denied'")).rows[0].n).toBe(1)
  })
  test('unchanged verified system export links without impersonating a human or appending a version',async()=>{
    const s=await setup(),{proposals:[p]}=await s.plan(s.bundle.files,null)
    expect(s.imports).toBeDefined()
    const result=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect(result).toMatchObject({outcome:'linked',versionId:s.f.rule.versionId})
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_original_authors')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(1)
  })
  test('Memory-only export confirmation links current M with null author while retaining actual Git G',async()=>{
    const s=await setup(),currentVersion=await s.advanceRule(),{proposals:[p]}=await s.plan(s.bundle.files,null)
    expect(p.result.kind).toBe('export')
    expect((await pool.query('SELECT state FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].state).toBe('planned')
    const result=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect(result).toMatchObject({outcome:'linked',versionId:currentVersion})
    expect((await pool.query(`SELECT l.version_id,l.commit_sha,p.state,b.git_document FROM memory_git_import_outcomes o
      JOIN memory_git_revision_links l USING(link_id) JOIN memory_git_confirmed_bases b USING(link_id)
      JOIN memory_git_import_proposals p ON p.proposal_id=o.proposal_id WHERE o.proposal_id=$1`,[p.proposalId])).rows[0])
      .toMatchObject({version_id:currentVersion,commit_sha:s.request.headCommit,state:'applied',git_document:s.bundle.assets[0]})
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).resolves.toEqual(result)
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(2)
    for(const table of ['memory_git_original_authors','memory_git_governed_revisions','memory_git_revision_reviews'])
      expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
    for(const table of ['memory_git_import_outcomes','memory_git_revision_links','memory_git_confirmed_bases'])
      expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(1)
    await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.skill.publisher.membershipId])
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow('git_forbidden')
  })
  test.each(['publisher','source','run','namespace'])('Memory-only export confirmation still rejects changed %s',async mode=>{
    const s=await setup();await s.advanceRule()
    const {proposals:[p],runId}=await s.plan(s.bundle.files,null)
    expect(p.result.kind).toBe('export')
    if(mode==='publisher')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.skill.publisher.membershipId])
    if(mode==='source')await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[s.f.rule.claimId])
    if(mode==='run')await pool.query('UPDATE memory_git_run_receipts SET eligible=false WHERE run_id=$1',[runId])
    if(mode==='namespace')await pool.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,skill_id,path)
      VALUES(gen_random_uuid(),$1,$2,$3,'skill',$4,$5)`,[s.f.installationId,s.f.connectionId,s.f.repositoryId,s.f.skill.reviewed.skillId,s.bundle.assets[0].asset.path+'/child.yaml'])
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow(
      mode==='publisher'?'git_forbidden':mode==='namespace'?'git_resolution_conflict':mode==='source'?'git_export_unregistered':'git_source_stale')
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(2)
    for(const table of ['memory_git_import_outcomes','memory_git_revision_links','memory_git_confirmed_bases'])
      expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='apply' AND outcome='denied'")).rows[0].n).toBe(1)
  })
  test('Memory-only export confirmation rolls back link and outcome if common-base recording fails',async()=>{
    const s=await setup();await s.advanceRule()
    const {proposals:[p]}=await s.plan(s.bundle.files,null)
    await pool.query(`CREATE FUNCTION fixture_fail_confirmed_base() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_confirmation_failure';END $$`)
    await pool.query('CREATE TRIGGER fixture_fail_confirmed_base BEFORE INSERT ON memory_git_confirmed_bases FOR EACH ROW EXECUTE FUNCTION fixture_fail_confirmed_base()')
    try{await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow('fixture_confirmation_failure')}
    finally{await pool.query('DROP TRIGGER fixture_fail_confirmed_base ON memory_git_confirmed_bases; DROP FUNCTION fixture_fail_confirmed_base()')}
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(2)
    for(const table of ['memory_git_import_outcomes','memory_git_revision_links','memory_git_confirmed_bases'])
      expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
    expect((await pool.query('SELECT state FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].state).toBe('planned')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='apply' AND outcome='denied'")).rows[0].n).toBe(1)
  })
  test('planned state cannot disguise a content proposal as metadata-only confirmation',async()=>{
    const s=await setup(),{proposals:[p]}=await s.plan(undefined,null)
    expect(p.result.kind).toBe('proposal')
    await pool.query("UPDATE memory_git_import_proposals SET state='planned' WHERE proposal_id=$1",[p.proposalId])
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow('git_proposal_terminal')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
  })
  test('Skill Git edit appends a draft attributed to the verified author and cannot use old review or Replay',async()=>{
    const s=await setup(['skill']),files=s.edit(s.bundle.files,v=>{if(v.key)v.editable.document.title='Imported Skill draft'})
    const {proposals:[p]}=await s.plan(files)
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const result=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect(result.outcome).toBe('draft_appended')
    const row=(await pool.query(`SELECT h.state,v.author_id,v.document->>'title' AS title,p.current_version_id AS publication
      FROM memory_skill_heads h JOIN memory_skill_versions v ON v.version_id=h.current_version_id
      JOIN memory_skill_publication_heads p ON p.installation_id=h.installation_id AND p.skill_id=h.skill_id WHERE h.skill_id=$1`,[s.f.skill.reviewed.skillId])).rows[0]
    expect(row).toEqual({state:'draft',author_id:s.originalAuthor.membershipId,title:'Imported Skill draft',publication:s.f.skill.reviewed.versionId})
    await expect(s.f.skill.publication.execute(s.f.skill.publisher,{...s.f.skill.publishRequest,versionId:result.versionId,
      expectedRevision:s.f.skill.reviewed.revision+1,expectedPublicationRevision:1})).rejects.toThrow('review_required')
    expect((await pool.query('SELECT count(*)::int n FROM memory_skill_replay_runs WHERE version_id=$1',[result.versionId])).rows[0].n).toBe(0)
  })
  test('Wiki generated edit publishes a whole manual version preserving generated provenance and all editable metadata',async()=>{
    const s=await setup(['wiki'])
    // Wiki edits live in Markdown; encode a candidate using the real wire codec.
    const {encodeAsset}=await import('../git-sync/codec.js')
    const asset=structuredClone(s.bundle.assets[0].asset) as WikiAsset
    asset.editable.pages[0].title='Imported page title'
    Object.assign(asset.editable.pages[0].sections[0],{sectionKey:'renamed-generated',heading:'Imported heading',markdown:'Imported paragraph',coverage:'degraded'})
    const changed=encodeAsset(asset),paths=new Set(changed.map(f=>f.path))
    const files=[...s.bundle.files.filter(f=>!paths.has(f.path)),...changed]
    const {proposals:[p]}=await s.plan(files)
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const result=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect(result.outcome).toBe('published')
    const rows=(await pool.query(`SELECT p.title,s.section_key,s.heading,s.markdown,s.coverage,s.authority,v.build_run_id
      FROM memory_wiki_versions v JOIN memory_wiki_pages p USING(installation_id,wiki_version_id)
      JOIN memory_wiki_sections s ON s.installation_id=p.installation_id AND s.wiki_version_id=p.wiki_version_id AND s.page_id=p.page_id
      WHERE v.wiki_version_id=$1 ORDER BY s.position`,[result.versionId])).rows
    expect(rows[0]).toEqual({title:'Imported page title',section_key:'renamed-generated',heading:'Imported heading',markdown:'Imported paragraph',coverage:'degraded',authority:'manual',build_run_id:s.f.runId})
    expect(rows[1]).toMatchObject({section_key:'manual',markdown:'  Keep CRLF\r\n',authority:'locked'})
    expect((await pool.query('SELECT count(*)::int n FROM memory_wiki_source_bindings WHERE wiki_version_id=$1',[result.versionId])).rows[0].n).toBe(1)
    // A fresh domain-backed export must accept the new head/source representation.
    const {createGitExportService}=await import('../git-sync/export-service.js')
    await expect(createGitExportService(s.deps).export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',
      baseCommit:'c'.repeat(40),purpose:'external_export',assets:[{kind:'wiki',id:s.f.wiki.wikiId}]})).resolves.toMatchObject({assets:[{asset:{baseVersionId:result.versionId}}]})
  })
  test.each(['author','resolver'])('%s cannot approve their own current resolution',async who=>{
    const s=await setup(),{proposals:[p],files}=await s.plan()
    let reviewer=s.originalAuthor.grant,revision='1'
    if(who==='resolver') {
      const resolver=await s.f.skill.actor(['scope_administrator'],['read','contribute','review','publish'])
      await s.service.resolve(resolver.grant,{...s.request,files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:p.inputs,
        resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable:{...s.bundle.assets[0].asset.editable,statement:'Current resolver content'}}})
      reviewer=resolver.grant;revision='2'
    }
    await expect(s.imports!.review(reviewer,{...subject(s,p.proposalId),expectedRevision:revision,decision:'approve'})).rejects.toThrow('git_self_review_denied')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_revision_reviews')).rows[0].n).toBe(0)
  })
  test.each(['author_revision','author_roles','reviewer_revision','reviewer_expired','publisher_roles','policy','source_revoke','source_evidence','tenant','current_head'])('rejects changed %s without domain/link/outcome writes',async mode=>{
    const s=await setup(),{proposals:[p]}=await s.plan()
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    if(mode==='author_revision')await pool.query('UPDATE memory_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[s.originalAuthor.membershipId])
    if(mode==='author_roles')await pool.query("UPDATE memory_scope_memberships SET roles=ARRAY['reader'] WHERE membership_id=$1",[s.originalAuthor.membershipId])
    if(mode==='reviewer_revision')await pool.query('UPDATE memory_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[s.f.skill.reviewer.membershipId])
    if(mode==='reviewer_expired')await pool.query("UPDATE memory_scope_memberships SET valid_until=NOW()-INTERVAL '1 second' WHERE membership_id=$1",[s.f.skill.reviewer.membershipId])
    if(mode==='publisher_roles')await pool.query("UPDATE memory_scope_memberships SET roles=ARRAY['reader'] WHERE membership_id=$1",[s.f.skill.publisher.membershipId])
    if(mode==='policy')await pool.query(`UPDATE memory_review_policy_heads SET active_version_id=(SELECT policy_version_id FROM memory_review_policy_versions WHERE policy_id=memory_review_policy_heads.policy_id ORDER BY version_number DESC LIMIT 1),revision=revision+1`)
    if(mode==='policy') {
      const {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY}=await import('../governance/review-policy.js')
      await createReviewPolicyRepository(pool).publishVersion({installationId:s.f.installationId,document:{...DEFAULT_TEAM_REVIEW_POLICY,minimum_approvals:2},createdByMembershipId:s.f.membershipId,expectedRevision:2})
    }
    if(mode==='source_revoke')await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[s.f.rule.claimId])
    if(mode==='source_evidence')await pool.query("UPDATE knowledge_evidence SET excerpt='changed',excerpt_hash=decode(repeat('e',64),'hex') WHERE version_id=$1",[s.f.rule.versionId])
    if(mode==='current_head')await pool.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[s.f.rule.claimId])
    const input=subject(s,p.proposalId)
    if(mode==='tenant')input.installationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await expect(s.imports!.apply(s.f.skill.publisher.grant,input)).rejects.toThrow()
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_revision_links')).rows[0].n).toBe(0)
  })
  test.each(['rule','wiki','skill'])('second-step %s link failure rolls back domain/version/base and retains one outer denial',async kind=>{
    const s=await setup([kind])
    let files=s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.statement='Rollback content';if(v.key?.kind==='skill')v.editable.document.title='Rollback draft'})
    if(kind==='wiki') {
      const {encodeAsset}=await import('../git-sync/codec.js'),asset=structuredClone(s.bundle.assets[0].asset) as WikiAsset
      asset.editable.pages[0].title='Rollback page'
      const changed=encodeAsset(asset),paths=new Set(changed.map(f=>f.path));files=[...s.bundle.files.filter(f=>!paths.has(f.path)),...changed]
    }
    const {proposals:[p]}=await s.plan(files)
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const table=kind==='rule'?'knowledge_versions':kind==='wiki'?'memory_wiki_versions':'memory_skill_versions'
    const before=(await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n
    await pool.query(`CREATE FUNCTION fixture_fail_import_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_second_step';END $$`)
    await pool.query('CREATE TRIGGER fixture_fail_import_link BEFORE INSERT ON memory_git_revision_links FOR EACH ROW EXECUTE FUNCTION fixture_fail_import_link()')
    try{await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow('fixture_second_step')}
    finally{await pool.query('DROP TRIGGER fixture_fail_import_link ON memory_git_revision_links; DROP FUNCTION fixture_fail_import_link()')}
    expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(before)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_confirmed_bases')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT state FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].state).toBe('awaiting_review')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='apply' AND outcome='denied'")).rows[0].n).toBe(1)
  })
  test('current publisher cannot count when effective policy excludes publisher approval',async()=>{
    const s=await setup(),{createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY}=await import('../governance/review-policy.js')
    await createReviewPolicyRepository(pool).publishVersion({installationId:s.f.installationId,document:{...DEFAULT_TEAM_REVIEW_POLICY,publisher_may_count_as_reviewer:false},createdByMembershipId:s.f.membershipId,expectedRevision:1})
    const {proposals:[p]}=await s.plan()
    const grant=structuredClone(s.f.skill.publisher.grant);grant.scopeBindings[0].permissions.push('review')
    await s.imports!.review(grant,{...subject(s,p.proposalId),decision:'approve'})
    await expect(s.imports!.apply(grant,subject(s,p.proposalId))).rejects.toThrow('git_quorum_failed')
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    await expect(s.imports!.apply(grant,subject(s,p.proposalId))).resolves.toMatchObject({outcome:'published'})
  })
  test.each(['off','shadow'])('%s cannot apply even with sufficient review and publication permission',async mode=>{
    const s=await setup(),{proposals:[p]}=await s.plan()
    await pool.query('UPDATE memory_git_connections SET sync_mode=$2 WHERE connection_id=$1',[s.f.connectionId,mode])
    await expect(s.imports!.apply(s.f.grant,subject(s,p.proposalId))).rejects.toThrow()
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
  })
  test.each(['merge','resolution'])('confirmed G after %s preserves Memory-only changes when Git repeats its original content',async mode=>{
    const s=await setup();await s.advanceRule()
    const {proposals:[p],files}=await s.plan();let revision='1'
    if(mode==='resolution') {
      await s.service.resolve(s.f.grant,{...s.request,files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:p.inputs,
        resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable:{statement:'Resolved local statement',structuredContent:{value:null,flags:['strict'],retries:10}}}})
      revision='2'
    }
    const request={...subject(s,p.proposalId),expectedRevision:revision}
    await s.imports!.review(s.f.skill.reviewer.grant,{...request,decision:'approve'})
    const applied=await s.imports!.apply(s.f.skill.publisher.grant,request)
    const base=(await pool.query('SELECT git_document FROM memory_git_confirmed_bases')).rows[0].git_document
    expect(base.asset.editable).toEqual({statement:'Governed Git edit',structuredContent:{value:null,flags:['strict'],retries:7}})
    s.request.headCommit='d'.repeat(40)
    const {proposals:[again]}=await s.plan(files,null)
    expect(again.result).toMatchObject({kind:'export',asset:{asset:{editable:{statement:mode==='resolution'?'Resolved local statement':'Governed Git edit',structuredContent:{retries:mode==='resolution'?10:9}}}}})
    const confirmed=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,again.proposalId))
    expect(confirmed).toMatchObject({outcome:'linked',versionId:applied.versionId})
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,again.proposalId))).resolves.toEqual(confirmed)
    expect((await pool.query(`SELECT b.git_document,l.version_id,l.commit_sha FROM memory_git_confirmed_bases b
      JOIN memory_git_revision_links l USING(link_id) WHERE l.link_id=$1`,[confirmed.linkId])).rows[0])
      .toEqual({git_document:base,version_id:applied.versionId,commit_sha:s.request.headCommit})
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(3)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_original_authors WHERE proposal_id=$1',[again.proposalId])).rows[0].n).toBe(0)
    for(const table of ['memory_git_import_outcomes','memory_git_revision_links','memory_git_confirmed_bases'])
      expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(2)
    expect((await pool.query('SELECT v.structured_content FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=$1',[s.f.rule.claimId])).rows[0].structured_content.retries).toBe(mode==='resolution'?10:9)
  })
  test('partial batch advances only the confirmed asset baseline',async()=>{
    const s=await setup(['rule','skill']),files=s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.statement='Allowed rule';if(v.key?.kind==='skill')v.editable.document.title='Unreviewed skill'})
    const {proposals}=await s.plan(files),rule=proposals.find(p=>p.key.kind==='rule')!,skill=proposals.find(p=>p.key.kind==='skill')!
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,rule.proposalId),decision:'approve'})
    const result=await s.imports!.applyBatch(s.f.skill.publisher.grant,[subject(s,rule.proposalId),subject(s,skill.proposalId)])
    expect(result).toMatchObject([{ok:true,result:{outcome:'published'}},{ok:false,code:'git_quorum_failed'}])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_confirmed_bases')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT state FROM memory_git_import_proposals WHERE proposal_id=$1',[skill.proposalId])).rows[0].state).toBe('awaiting_review')
  })
  test('verified fixture worker handoff admits the real provider actor after finalizer and then governs application',async()=>{
    const s=await setup(),{createGitInboxService}=await import('../git-sync/inbox-service.js'),{createGitSyncWorker}=await import('../git-sync/worker.js')
    const {loadGitSyncConfig}=await import('../git-sync/config.js'),{createJobRepository}=await import('../jobs/repository.js')
    const deps={...s.deps,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),scopeMode:async()=> 'enabled' as const}
    const inbox=createGitInboxService(deps),base={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId}
    await inbox.enroll(s.f.grant,base)
    const queued=await inbox.receive(base,{source:'webhook',eventId:'fixture-worker-import',changeNumber:'7'})
    const files=s.edit(s.bundle.files,v=>{if(v.key)v.editable.statement='Verified worker edit'})
    const worker=createGitSyncWorker({...deps,reads:{resolve:async()=>({kind:'fixture',target:{provider:'github',providerRepositoryId:'123',branch:'main',origin:'https://api.github.com'},
      request:async(r:any)=>({status:200,body:r.operation==='merge'?{providerRepositoryId:'123',number:'7',baseBranch:'main',merged:true,mergeCommit:'b'.repeat(40),
        exportId:s.bundle.exportId,actorId:'synthetic-exact-edit-author'}:r.operation==='commit'?{sha:'b'.repeat(40),tree:'c'.repeat(40)}:
        {commit:'b'.repeat(40),tree:'c'.repeat(40),files,nextCursor:null}})})}})
    // Keep unrelated index jobs ineligible; only invoke the queued Git job.
    await pool.query("UPDATE memory_jobs SET available_at=NOW()+INTERVAL '1 hour' WHERE job_id<>$1",[queued.jobId])
    const [job]=await createJobRepository(pool).claimJobs({workerId:'import-chain',limit:1,leaseMs:30000})
    await worker.handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'import-chain',claimEpoch:job.claim_epoch}})
    const p=(await pool.query('SELECT proposal_id,provider_actor_id,run_id FROM memory_git_import_proposals WHERE run_id=$1',[queued.runId])).rows[0]
    expect(p).toMatchObject({provider_actor_id:'synthetic-exact-edit-author',run_id:queued.runId})
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposal_id),decision:'approve'})
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposal_id))).resolves.toMatchObject({outcome:'published'})
    expect((await pool.query('SELECT author_membership_id FROM memory_git_original_authors WHERE proposal_id=$1',[p.proposal_id])).rows[0].author_membership_id).toBe(s.originalAuthor.membershipId)
  })
  async function waitBlocked(pid:number) {
    for(let i=0;i<100;i++) {
      if((await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting)return
      await pool.query('SELECT pg_sleep(0.01)')
    }
    throw new Error('fixture_expected_database_wait')
  }
  test.each(['author','head'])('external %s writer wins before apply and no connection lock is acquired while it waits',async resource=>{
    const s=await setup(),{proposals:[p]}=await s.plan()
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const writer=await pool.connect(),probe=await pool.connect();let pending:Promise<unknown>|undefined
    try {
      await writer.query('BEGIN')
      await writer.query(resource==='author'?'SELECT 1 FROM memory_scope_memberships WHERE membership_id=$1 FOR UPDATE':'SELECT 1 FROM knowledge_claims WHERE claim_id=$1 FOR UPDATE',[resource==='author'?s.originalAuthor.membershipId:s.f.rule.claimId])
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending=s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId)).then(value=>({value}),error=>({error}))
      await waitBlocked(pid)
      await probe.query('BEGIN');await probe.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE NOWAIT',[s.f.connectionId]);await probe.query('ROLLBACK')
      await writer.query(resource==='author'?'UPDATE memory_scope_memberships SET membership_revision=membership_revision+1 WHERE membership_id=$1':'UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[resource==='author'?s.originalAuthor.membershipId:s.f.rule.claimId])
      await writer.query('COMMIT')
      expect(await pending).toHaveProperty('error')
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
    }finally{await writer.query('ROLLBACK');await probe.query('ROLLBACK');await pending;writer.release();probe.release()}
  })
  test('apply wins head/member locks before connection wait and external domain writer cannot retain a shared head',async()=>{
    const s=await setup(),{proposals:[p]}=await s.plan()
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const blocker=await pool.connect(),writer=await pool.connect();let pending:Promise<unknown>|undefined
    try {
      await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE',[s.f.connectionId])
      const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending=s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId)).then(value=>({value}),error=>({error}))
      await waitBlocked(pid)
      await writer.query('BEGIN')
      await expect(writer.query('SELECT 1 FROM knowledge_claims WHERE claim_id=$1 FOR SHARE NOWAIT',[s.f.rule.claimId])).rejects.toMatchObject({code:'55P03'})
      await writer.query('ROLLBACK');await writer.query('BEGIN')
      await expect(writer.query('SELECT 1 FROM memory_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[s.originalAuthor.membershipId])).rejects.toMatchObject({code:'55P03'})
      await writer.query('ROLLBACK');await blocker.query('COMMIT')
      expect(await pending).toMatchObject({value:{outcome:'published'}})
    }finally{await blocker.query('ROLLBACK');await writer.query('ROLLBACK');await pending;blocker.release();writer.release()}
  })
  test('revision keeps typed original Evidence and immutable author/review history after a new resolution',async()=>{
    const s=await setup(),{proposals:[p],files}=await s.plan()
    const first=await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    await s.service.resolve(s.f.grant,{...s.request,files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:p.inputs,
      resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable:{...s.bundle.assets[0].asset.editable,statement:'Revised candidate'}}})
    expect((await pool.query('SELECT decision_id FROM memory_git_revision_reviews')).rows).toEqual([{decision_id:first.decisionId}])
    await expect(s.imports!.apply(s.f.skill.publisher.grant,{...subject(s,p.proposalId),expectedRevision:'2'})).rejects.toThrow('git_quorum_failed')
    await expect(pool.query("UPDATE memory_git_original_authors SET provider_actor_id='bot' WHERE proposal_id=$1",[p.proposalId])).rejects.toThrow('git_snapshot_immutable')
    const exists=(await pool.query("SELECT to_regclass('memory_git_revision_evidence') AS name")).rows[0].name
    const evidence=exists?(await pool.query('SELECT evidence_id FROM memory_git_revision_evidence')).rows:[]
    expect(evidence).toEqual([{evidence_id:s.bundle.assets[0].asset.immutable.evidence[0].evidenceId}])
  })
  test('domain Skill rejection leaves durable outer Git and Skill denials after all savepoints roll back',async()=>{
    const s=await setup(['skill']),files=s.edit(s.bundle.files,v=>{if(v.key)v.editable.document.title='Rejected large draft'})
    const {proposals:[p]}=await s.plan(files)
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const {createGitImportService}=await import('../git-sync/import-service.js')
    const service=createGitImportService({...s.deps,skill:{...s.deps.skill,context:{...s.deps.skill.context,config:{...s.deps.skill.context.config,maxCandidateChars:1}}},applicationMode:async()=> 'enabled'})
    await expect(service.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow('size_exceeded')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='apply' AND outcome='denied'")).rows[0].n).toBe(1)
    expect((await pool.query("SELECT count(*)::int n FROM memory_skill_audit_events WHERE action='edit' AND outcome='denied' AND code='size_exceeded'")).rows[0].n).toBe(1)
  })
  test.each([false,true])('Wiki manual content/key edits obey current lock=%s and retain earlier manual version',async unlocked=>{
    const s=await setup(['wiki'],unlocked),{encodeAsset}=await import('../git-sync/codec.js')
    const asset=structuredClone(s.bundle.assets[0].asset) as WikiAsset
    Object.assign(asset.editable.pages[0].sections[1],{sectionKey:'renamed-manual',heading:'Revised manual heading',markdown:'Revised manual body',coverage:'partial'})
    const changed=encodeAsset(asset),paths=new Set(changed.map(f=>f.path)),files=[...s.bundle.files.filter(f=>!paths.has(f.path)),...changed]
    const {proposals:[p]}=await s.plan(files)
    if(!unlocked) {
      expect(p.result.kind).toBe('conflict')
      await expect(s.imports!.apply(s.f.grant,subject(s,p.proposalId))).rejects.toThrow('git_proposal_terminal')
      expect((await pool.query('SELECT active_version_id FROM memory_wiki_heads WHERE wiki_id=$1',[s.f.wiki.wikiId])).rows[0].active_version_id).toBe(s.f.wiki.versionId)
      return
    }
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const result=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect((await pool.query(`SELECT s.heading,s.markdown,s.coverage,v.previous_version_id FROM memory_wiki_sections s
      JOIN memory_wiki_manual_section_heads h ON h.installation_id=s.installation_id AND h.section_key=s.section_key
      JOIN memory_wiki_manual_section_versions v ON v.manual_version_id=h.current_version_id WHERE s.wiki_version_id=$1 AND s.section_key='renamed-manual'`,[result.versionId])).rows[0])
      .toEqual({heading:'Revised manual heading',markdown:'Revised manual body',coverage:'partial',previous_version_id:s.f.manualVersionId})
    expect((await pool.query('SELECT 1 FROM memory_wiki_manual_section_versions WHERE manual_version_id=$1',[s.f.manualVersionId])).rowCount).toBe(1)
  })
  test.each(['rule','skill'])('governed %s deletion revokes through domain without resurrecting content',async kind=>{
    const s=await setup([kind]),path=s.bundle.assets[0].asset.path
    const {proposals:[p]}=await s.plan(s.bundle.files.filter(f=>f.path!==path))
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const confirmed=await s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))
    expect(confirmed.outcome).toBe('revoked')
    const retry={...subject(s,p.proposalId),expectedGeneration:(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation}
    await expect(s.imports!.apply(s.f.skill.publisher.grant,retry)).resolves.toEqual(confirmed)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_retained_outcomes')).rows[0].n).toBe(1)
    const table=kind==='rule'?'knowledge_claims':'memory_skill_heads',key=kind==='rule'?'claim_id':'skill_id'
    expect((await pool.query(`SELECT state FROM ${table} WHERE ${key}=$1`,[s.bundle.assets[0].asset.key.id])).rows[0].state).toBe('revoked')
    expect((await pool.query('SELECT git_document FROM memory_git_confirmed_bases')).rowCount).toBe(0)
    await expect(s.service.plan(s.f.grant,{...s.request,headCommit:'d'.repeat(40)})).rejects.toThrow()
    await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.skill.publisher.membershipId])
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow('git_forbidden')
  })
  test('late outside-binding namespace collision rejects apply after valid review',async()=>{
    const s=await setup(),{proposals:[p],files}=await s.plan()
    const path='.pocketctl/knowledge/claims/occupied.yaml/child.yaml'
    await s.service.resolve(s.f.grant,{...s.request,files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:p.inputs,
      resolution:{path,deleted:false,editable:{...s.bundle.assets[0].asset.editable,statement:'Rename and edit'}}})
    const request={...subject(s,p.proposalId),expectedRevision:'2'}
    await s.imports!.review(s.f.skill.reviewer.grant,{...request,decision:'approve'})
    await pool.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,skill_id,path)
      VALUES(gen_random_uuid(),$1,$2,$3,'skill',$4,'.pocketctl/knowledge/claims/occupied.yaml')`,[s.f.installationId,s.f.connectionId,s.f.repositoryId,s.f.skill.reviewed.skillId])
    await expect(s.imports!.apply(s.f.skill.publisher.grant,request)).rejects.toThrow('git_resolution_conflict')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
  })
  test('M=G content edit records an exact link without requiring a fictitious Git author or new version',async()=>{
    const s=await setup(),currentVersion=await s.advanceRule(),files=s.edit(s.bundle.files,v=>{if(v.key)v.editable.structuredContent.retries=9})
    const {proposals:[p]}=await s.plan(files,null)
    expect(p.result.kind).toBe('noop')
    await expect(s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).resolves.toMatchObject({outcome:'linked',versionId:currentVersion})
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(2)
  })
  test('Wiki domain import publication requires transaction-bound governance approval',async()=>{
    const s=await setup(['wiki']),{createGitExportService}=await import('../git-sync/export-service.js')
    const {createWikiPublicationService}=await import('../wiki/publication-service.js'),{createTransactionBoundPool}=await import('../api/transaction-bound-pool.js')
    const base={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId}
    await expect(createGitExportService(s.deps).withApplyBase(s.f.skill.publisher.grant,base,async context=>{
      const current=context.current[0].asset as WikiAsset,proposed=structuredClone(current);proposed.editable.pages[0].title='Ungoverned title'
      return createWikiPublicationService(createTransactionBoundPool(context.client)).publishRevision({grant:s.f.skill.publisher.grant,targetInstallationId:s.f.installationId,
        current,proposed,sourceContext:context.sourceContext} as any)
    })).rejects.toThrow('git_governance_required')
  })
  test('Wiki build-run writer is awaited before mutable Wiki head and connection ownership',async()=>{
    const s=await setup(['wiki']),{encodeAsset}=await import('../git-sync/codec.js'),asset=structuredClone(s.bundle.assets[0].asset) as WikiAsset
    asset.editable.pages[0].title='Governed concurrent title'
    const changed=encodeAsset(asset),paths=new Set(changed.map(f=>f.path)),{proposals:[p]}=await s.plan([...s.bundle.files.filter(f=>!paths.has(f.path)),...changed])
    await s.imports!.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    const writer=await pool.connect(),probe=await pool.connect();let pending:Promise<unknown>|undefined
    try {
      await writer.query('BEGIN');await writer.query('SELECT 1 FROM memory_wiki_build_runs WHERE run_id=$1 FOR UPDATE',[s.f.runId])
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending=s.imports!.apply(s.f.skill.publisher.grant,subject(s,p.proposalId)).then(value=>({value}),error=>({error}))
      await waitBlocked(pid)
      await probe.query('BEGIN')
      await probe.query('SELECT 1 FROM memory_wikis WHERE wiki_id=$1 FOR UPDATE NOWAIT',[s.f.wiki.wikiId])
      await probe.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE NOWAIT',[s.f.connectionId])
      await probe.query('ROLLBACK');await writer.query('COMMIT')
      expect(await pending).toMatchObject({value:{outcome:'published'}})
    }finally{await writer.query('ROLLBACK');await probe.query('ROLLBACK');await pending;writer.release();probe.release()}
  })
})
