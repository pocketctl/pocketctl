import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitProposalService, type GitProposal } from '../git-sync/proposal-service.js'
import { changeMetadata } from '../testing/phase6-fixtures.js'
import { skillFixtureDocument } from '../testing/skill-fixture.js'
import type { RepositoryFile } from '../git-sync/types.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
// Preserve signed controls byte-for-byte; the generic codec fixture intentionally
// reserializes every YAML file and therefore is not a whole-bundle edit helper.
const editFiles=(files:RepositoryFile[],edit:(value:any)=>void)=>files.map(file=>file.path.endsWith('/manifest.yaml')?file:changeMetadata([file],edit)[0])
db('Phase 6 registered three-way proposals',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function setup(kinds=['rule'],beforeExport?:(fixture:Awaited<ReturnType<typeof gitExportFixture>>)=>Promise<void>) {
    const f=await gitExportFixture(pool),key=attestationFixture(),deps={pool,keys:key.registry,skill:{context:f.skill.context,cases:f.skill.cases}},exports=createGitExportService(deps),service=createGitProposalService(deps)
    await beforeExport?.(f)
    const bundle=await exports.export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>kinds.includes(k.kind))})
    const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:bundle.exportId,headCommit:'b'.repeat(40),files:bundle.files}
    const files=editFiles(bundle.files,v=>{if(v.key?.kind==='rule')v.editable.statement='Git statement'})
    return {f,key,bundle,service,request,files}
  }
  async function review(s:Awaited<ReturnType<typeof setup>>,proposal:GitProposal) {
    await pool.query(`INSERT INTO memory_git_review_decisions(decision_id,installation_id,proposal_id,proposal_revision,base_revision,proposed_hash,policy_hash,membership_id,membership_revision,authorization_epoch,decision)
      SELECT $1,installation_id,proposal_id,revision,base_revision,proposed_hash,policy_hash,$3,1,authorization_epoch,'approve' FROM memory_git_import_proposals WHERE proposal_id=$2`,[randomUUID(),proposal.proposalId,s.f.membershipId])
  }
  async function advanceRule(f:Awaited<ReturnType<typeof gitExportFixture>>,statement:string,retries:number) {
    const id=randomUUID()
    await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,source_promotion_candidate_id)
      SELECT $1,installation_id,claim_id,2,$3,$4,authority,confidence,source_promotion_candidate_id FROM knowledge_versions WHERE version_id=$2`,
      [id,f.rule.versionId,statement,{value:null,flags:['strict'],retries}])
    await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
      SELECT $1,installation_id,$2,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility FROM knowledge_evidence WHERE version_id=$3`,[randomUUID(),id,f.rule.versionId])
    await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
      SELECT $1,installation_id,$2,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash FROM memory_authority_records WHERE version_id=$3`,[randomUUID(),id,f.rule.versionId])
    await pool.query('UPDATE knowledge_claims SET current_version_id=$2,revision=revision+1 WHERE claim_id=$1',[f.rule.claimId,id])
    return id
  }
  test('persists signed-B edited-G proposal once, independent merged doc; never writes domain versions',async()=>{
    const s=await setup(),{f}=s
    await advanceRule(f,'Synthetic statement',9)
    const [p]=await s.service.plan(f.grant,{...s.request,files:s.files})
    expect(p).toMatchObject({revision:'1',state:'awaiting_review',result:{kind:'proposal',asset:{asset:{editable:{statement:'Git statement',structuredContent:{value:null,flags:['strict'],retries:9}}}}}})
    const [again]=await s.service.plan(f.grant,{...s.request,files:s.files})
    expect(again.proposalId).toBe(p.proposalId)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[f.rule.versionId])).rows[0].statement).toBe('Synthetic statement')
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions')).rows[0].n).toBe(3)
  })
  test('old published Skill B compares to newer current draft M, yielding explicit conflict',async()=>{
    const s=await setup(['skill']),{f}=s
    await f.skill.review.execute(f.skill.author,{action:'edit',skillId:f.skill.reviewed.skillId,expectedRevision:f.skill.reviewed.revision,document:{...skillFixtureDocument(),title:'Memory draft'}})
    const files=editFiles(s.bundle.files,v=>{if(v.key)v.editable.document.title='Git title'})
    const [p]=await s.service.plan(f.grant,{...s.request,files})
    expect(p).toMatchObject({state:'conflicted',result:{kind:'conflict',conflicts:[{field:'editable.document.title',reason:'both_modified'}]}})
    expect((await pool.query('SELECT field FROM memory_git_conflicts WHERE proposal_id=$1',[p.proposalId])).rows).toEqual([{field:'editable.document.title'}])
  })
  test('resolution increments revision, binds all input digests, clears countable review and leaves Active unchanged',async()=>{
    const s=await setup(),{f}=s
    const currentVersion=await advanceRule(f,'Memory statement',7)
    const [p]=await s.service.plan(f.grant,{...s.request,files:s.files});await review(s,p)
    const resolved=await s.service.resolve(f.grant,{...s.request,files:s.files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:p.inputs,
      resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable:{statement:'Resolved statement',structuredContent:{value:null,flags:['strict'],retries:7}}}})
    expect(resolved).toMatchObject({proposalId:p.proposalId,revision:'2',state:'awaiting_review',inputs:p.inputs,result:{kind:'proposal',asset:{asset:{editable:{statement:'Resolved statement'}}}}})
    expect((await pool.query('SELECT 1 FROM memory_git_review_decisions WHERE proposal_id=$1',[p.proposalId])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_git_conflicts WHERE proposal_id=$1',[p.proposalId])).rowCount).toBe(0)
    expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[currentVersion])).rows[0].statement).toBe('Memory statement')
  })
  test.each(['revision','source','git','base_digest','proposal_revision','generation','revoked_key','missing_base','expired_source','authority'])('resolution fails closed after %s changes',async mode=>{
    const s=await setup(),{f}=s,[p]=await s.service.plan(f.grant,{...s.request,files:s.files});await review(s,p)
    const input={...s.request,files:s.files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:{...p.inputs},resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable:{statement:'Resolution',structuredContent:{value:null,flags:['strict'],retries:7}}}}
    if(mode==='revision')await pool.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[f.rule.claimId])
    if(mode==='source')await pool.query("UPDATE knowledge_evidence SET locator='{}' WHERE version_id=$1",[f.rule.versionId])
    if(mode==='git')input.files=editFiles(s.files,v=>{if(v.key)v.editable.statement='Other Git'})
    if(mode==='base_digest')input.expectedInputs.base='0'.repeat(64)
    if(mode==='proposal_revision')input.expectedRevision='2'
    if(mode==='generation')await pool.query('UPDATE memory_git_connections SET generation=2 WHERE connection_id=$1',[f.connectionId])
    if(mode==='revoked_key')s.key.keys.get('test-1')!.state='revoked'
    if(mode==='missing_base')await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    if(mode==='expired_source')await pool.query("UPDATE knowledge_versions SET valid_until=NOW()-INTERVAL '1 second' WHERE version_id=$1",[f.rule.versionId])
    if(mode==='authority')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[f.membershipId])
    const code=['generation','missing_base','expired_source'].includes(mode)?'git_export_unregistered':mode==='revoked_key'?'git_attestation_invalid':mode==='authority'?'git_forbidden':mode==='proposal_revision'?'git_revision_conflict':'git_input_changed'
    await expect(s.service.resolve(f.grant,input)).rejects.toThrow(code)
    if(['generation','expired_source','authority'].includes(mode)) {
      // Migration44 removes the body projection immediately; pure planning had
      // no canonical receipt, but its durable asset denominator still exists.
      expect((await pool.query('SELECT 1 FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])).rowCount).toBe(0)
      expect((await pool.query('SELECT 1 FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rowCount).toBe(0)
      expect((await pool.query('SELECT 1 FROM memory_git_proposal_identities WHERE proposal_id=$1',[p.proposalId])).rowCount).toBe(1)
      expect((await pool.query('SELECT 1 FROM memory_git_run_receipts WHERE installation_id=$1',[f.installationId])).rowCount).toBe(0)
    } else if(mode!=='missing_base')expect((await pool.query('SELECT revision::text FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].revision).toBe('1')
  })
  test.each(['manifest','attestation','unknown','immutable','duplicate','partial_wiki'])('whole-tree validation rejects %s before any proposal is persisted',async mode=>{
    const s=await setup(['rule','wiki']);let files:RepositoryFile[]=s.files
    if(mode==='manifest'||mode==='attestation')files=files.map(f=>f.path.includes(mode==='manifest'?'manifest.yaml':'attestations/')?{...f,bytes:Buffer.from('{}')}:f)
    if(mode==='unknown')files=[...files,{path:'.pocketctl/knowledge/unknown.txt',mode:'100644',bytes:Buffer.from('new')}]
    if(mode==='immutable')files=editFiles(files,v=>{if(v.key)v.sourceDigest='e'.repeat(64)})
    if(mode==='duplicate')files=[...files,{...files.find(f=>f.path.includes('/rules/'))!,path:'.pocketctl/knowledge/rules/duplicate.yaml'}]
    if(mode==='partial_wiki')files=files.filter(f=>!f.path.endsWith('overview.md'))
    const code=mode==='manifest'||mode==='attestation'?'git_control_file_changed':mode==='duplicate'?'duplicate_asset_id':mode==='immutable'?'immutable_field_changed':mode==='partial_wiki'?'wiki_page_missing':'unmanaged_file'
    await expect(s.service.plan(s.f.grant,{...s.request,files})).rejects.toThrow(code)
    expect((await pool.query('SELECT 1 FROM memory_git_import_proposals')).rowCount).toBe(0)
  })
  test('same-change no-op and whole-file deletion are persisted outcomes, not domain writes',async()=>{
    const s=await setup(),[noop]=await s.service.plan(s.f.grant,s.request)
    expect(noop).toMatchObject({state:'noop',result:{kind:'noop'}})
    const [deletion]=await s.service.plan(s.f.grant,{...s.request,headCommit:'c'.repeat(40),files:s.bundle.files.filter(f=>!f.path.includes('/rules/'))})
    expect(deletion).toMatchObject({state:'awaiting_review',result:{kind:'proposal',asset:{deleted:true}}})
    expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE claim_id=$1',[s.f.rule.claimId])).rowCount).toBe(1)
  })
  test('fresh planning updates the same proposal revision and clears review when current source changes',async()=>{
    const s=await setup(),[first]=await s.service.plan(s.f.grant,{...s.request,files:s.files});await review(s,first)
    await pool.query('UPDATE knowledge_claims SET revision=revision+1 WHERE claim_id=$1',[s.f.rule.claimId])
    const [second]=await s.service.plan(s.f.grant,{...s.request,files:s.files})
    expect(second).toMatchObject({proposalId:first.proposalId,revision:'2',state:'awaiting_review'})
    expect(second.inputs.memory).not.toBe(first.inputs.memory)
    expect(second.inputs.base).toBe(first.inputs.base)
    expect((await pool.query('SELECT 1 FROM memory_git_review_decisions WHERE proposal_id=$1',[first.proposalId])).rowCount).toBe(0)
  })
  test('concurrent planning deduplicates and concurrent resolution permits exactly one revision CAS',async()=>{
    const s=await setup(),[a,b]=await Promise.all([s.service.plan(s.f.grant,{...s.request,files:s.files}),s.service.plan(s.f.grant,{...s.request,files:s.files})])
    expect(a[0].proposalId).toBe(b[0].proposalId)
    const request={...s.request,files:s.files,proposalId:a[0].proposalId,expectedRevision:'1',expectedInputs:a[0].inputs,resolution:{path:s.bundle.assets[0].asset.path,deleted:false,editable:{statement:'Resolved',structuredContent:{value:null,flags:['strict'],retries:7}}}}
    const results=await Promise.allSettled([s.service.resolve(s.f.grant,request),s.service.resolve(s.f.grant,request)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
  })
  test.each(['manifest.yaml','manifest.yaml/child.yaml','attestations/other.yaml'])('resolution cannot overwrite reserved control namespace %s',async path=>{
    const s=await setup(),[p]=await s.service.plan(s.f.grant,{...s.request,files:s.files})
    await expect(s.service.resolve(s.f.grant,{...s.request,files:s.files,proposalId:p.proposalId,expectedRevision:'1',expectedInputs:p.inputs,
      resolution:{path:`.pocketctl/knowledge/${path}`,deleted:false,editable:{statement:'Resolved',structuredContent:{value:null,flags:['strict'],retries:7}}}})).rejects.toThrow('git_resolution_conflict')
  })
  test('Memory binding rename and Git physical rename conflict even though content hash is unchanged',async()=>{
    const s=await setup(),path='.pocketctl/knowledge/rules/memory.yaml'
    await pool.query('UPDATE memory_git_asset_bindings SET path=$2 WHERE asset_id=$1',[s.f.rule.claimId,path])
    const files=s.bundle.files.map(f=>f.path.includes('/rules/')?{...f,path:'.pocketctl/knowledge/rules/git.yaml'}:f)
    const [p]=await s.service.plan(s.f.grant,{...s.request,files})
    expect(p).toMatchObject({state:'conflicted',result:{kind:'conflict',conflicts:[{field:'path',reason:'rename_collision'}]}})
  })
  test.each(['source','reviewer','publisher'])('final source fence rejects %s expiry while waiting on the connection lock',async mode=>{
    const s=await setup(mode==='source'?['rule']:['skill'],mode==='source'?async f=>{
      // Set expiry before this export. A later UPDATE intentionally invalidates
      // the projection and cannot prove the final natural-clock fence.
      await pool.query("UPDATE knowledge_versions SET valid_until=clock_timestamp()+INTERVAL '2 seconds' WHERE version_id=$1",[f.rule.versionId])
    }:undefined),blocker=await pool.connect()
    try {
      const member=mode==='reviewer'?s.f.skill.reviewer.membershipId:s.f.skill.publisher.membershipId
      if(mode==='source')expect((await pool.query('SELECT valid_until>clock_timestamp() AS alive FROM knowledge_versions WHERE version_id=$1',[s.f.rule.versionId])).rows[0].alive).toBe(true)
      else await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+INTERVAL '1 second' WHERE membership_id=$1",[member])
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE',[s.f.connectionId])
      const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending=s.service.plan(s.f.grant,{...s.request,files:s.files}).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
      let waiting=false
      for(let i=0;i<100;i++) {
        waiting=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting
        if(waiting)break
        await pool.query('SELECT pg_sleep(0.01)')
      }
      expect(waiting).toBe(true)
      if(mode==='source')await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM valid_until-clock_timestamp())+0.05)) FROM knowledge_versions WHERE version_id=$1',[s.f.rule.versionId])
      else await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM valid_until-clock_timestamp())+0.05)) FROM memory_scope_memberships WHERE membership_id=$1',[member])
      await blocker.query('COMMIT')
      expect((await pending).error?.message).toBe('git_source_stale')
      expect((await pool.query('SELECT 1 FROM memory_git_import_proposals')).rowCount).toBe(0)
    } finally {await blocker.query('ROLLBACK');blocker.release()}
  })
  test('unrelated expired membership does not invalidate a governed proposal',async()=>{
    const s=await setup(['skill']),member=randomUUID()
    await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,membership_revision,valid_until) VALUES($1,$2,ARRAY['reviewer'],1,clock_timestamp()-INTERVAL '1 second')",[s.f.installationId,member])
    await expect(s.service.plan(s.f.grant,s.request)).resolves.toMatchObject([{state:'noop'}])
  })
  test('whole Wiki directory rename is a proposal with unchanged semantic content',async()=>{
    const s=await setup(['wiki']),old=s.bundle.assets[0].asset.path.slice(0,-'/metadata.yaml'.length),next='.pocketctl/knowledge/wiki/renamed'
    const files=s.bundle.files.map(f=>f.path.startsWith(`${old}/`)?{...f,path:f.path.replace(old,next)}:f)
    const [p]=await s.service.plan(s.f.grant,{...s.request,files})
    expect(p).toMatchObject({state:'awaiting_review',result:{kind:'proposal',asset:{contentHash:s.bundle.assets[0].contentHash,asset:{path:`${next}/metadata.yaml`}}}})
  })
  test('standalone Wiki page-file rename is rejected even with a matching valid pageId marker',async()=>{
    const s=await setup(['wiki']),files=s.bundle.files.map(f=>f.path.endsWith('/overview.md')?{...f,path:f.path.replace('/overview.md','/renamed.md')}:f)
    await expect(s.service.plan(s.f.grant,{...s.request,files})).rejects.toThrow('git_wiki_page_path_changed')
    expect((await pool.query('SELECT 1 FROM memory_git_import_proposals')).rowCount).toBe(0)
  })
  async function bindOutside(s:Awaited<ReturnType<typeof setup>>,path:string) {
    await pool.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,skill_id,path)
      VALUES($1,$2,$3,$4,'skill',$5,$6)`,[randomUUID(),s.f.installationId,s.f.connectionId,s.f.repositoryId,s.f.skill.reviewed.skillId,path])
  }
  function resolveRequest(s:Awaited<ReturnType<typeof setup>>,p:GitProposal,files:RepositoryFile[],path:string) {
    const asset=s.bundle.assets.find(a=>a.asset.key.id===p.key.id)!.asset
    return {...s.request,files,proposalId:p.proposalId,expectedRevision:p.revision,expectedInputs:p.inputs,
      resolution:{path,deleted:false,editable:{...asset.editable,statement:'Resolved statement'}}}
  }
  test('outside-binding collision fallback reserves Memory paths until every sibling is safe',async()=>{
    const s=await setup(['claim','rule']),[A,B]=s.bundle.assets,outside='.pocketctl/knowledge/claims/outside.yaml'
    await bindOutside(s,outside)
    const files=s.bundle.files.map(f=>f.path===A.asset.path?{...f,path:B.asset.path}:f.path===B.asset.path?{...f,path:outside}:f)
    const plans=await s.service.plan(s.f.grant,{...s.request,files})
    expect(plans.map(p=>p.result.kind)).toEqual(['conflict','conflict'])
    expect((await s.service.plan(s.f.grant,{...s.request,files})).map(p=>({id:p.proposalId,revision:p.revision,result:p.result})))
      .toEqual(plans.map(p=>({id:p.proposalId,revision:p.revision,result:p.result})))
  })
  test('sequential sibling resolution and repeated planning retain saved sibling paths',async()=>{
    const s=await setup(['claim','rule']),files=editFiles(s.bundle.files,v=>{if(v.key)v.editable.statement='Git statement'})
    const [A,B]=await s.service.plan(s.f.grant,{...s.request,files}),shared='.pocketctl/knowledge/claims/shared.yaml'
    const first=await s.service.resolve(s.f.grant,resolveRequest(s,A,files,shared))
    await expect(s.service.resolve(s.f.grant,resolveRequest(s,B,files,shared))).rejects.toThrow('git_resolution_conflict')
    const second=await s.service.resolve(s.f.grant,resolveRequest(s,B,files,'.pocketctl/knowledge/claims/second.yaml'))
    const repeated=await s.service.plan(s.f.grant,{...s.request,files})
    expect(repeated).toEqual([first,second])
    expect(repeated.map(p=>p.result.kind==='conflict'?'conflict':p.result.asset.asset.path)).toEqual([shared,'.pocketctl/knowledge/claims/second.yaml'])
  })
  test('idempotent planning revalidates saved sibling resolutions against new outside bindings',async()=>{
    const s=await setup(['claim','rule']),files=editFiles(s.bundle.files,v=>{if(v.key)v.editable.statement='Git statement'})
    const [A,B]=await s.service.plan(s.f.grant,{...s.request,files}),outside='.pocketctl/knowledge/claims/new-outside.yaml'
    const movedB=await s.service.resolve(s.f.grant,resolveRequest(s,B,files,outside))
    const oldBPath=s.bundle.assets.find(a=>a.asset.key.id===B.key.id)!.asset.path
    const movedA=await s.service.resolve(s.f.grant,resolveRequest(s,A,files,oldBPath))
    await review(s,movedA);await review(s,movedB);await bindOutside(s,outside)
    const replanned=await s.service.plan(s.f.grant,{...s.request,files})
    expect(replanned.map(p=>({revision:p.revision,kind:p.result.kind}))).toEqual([{revision:'3',kind:'conflict'},{revision:'3',kind:'conflict'}])
    expect((await pool.query('SELECT 1 FROM memory_git_review_decisions')).rowCount).toBe(0)
    expect(await s.service.plan(s.f.grant,{...s.request,files})).toEqual(replanned)
  })
  test('resolution rejects a normalized descendant of an occupied outside file',async()=>{
    const s=await setup(),[p]=await s.service.plan(s.f.grant,{...s.request,files:s.files})
    await bindOutside(s,'.pocketctl/knowledge/claims/occupied.yaml')
    await expect(s.service.resolve(s.f.grant,resolveRequest(s,p,s.files,'.pocketctl/knowledge/claims/OCCUPIED.yaml/child.yaml'))).rejects.toThrow('git_resolution_conflict')
    expect((await pool.query('SELECT revision::text FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].revision).toBe('1')
  })
  async function parentPolicy(s:Awaited<ReturnType<typeof setup>>) {
    const installationId=randomUUID(),scopeId=randomUUID(),policyId=randomUUID(),versionId=randomUUID()
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installationId])
    await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$2)",[installationId,scopeId])
    await pool.query('INSERT INTO memory_review_policy_sets(policy_id,installation_id) VALUES($1,$2)',[policyId,installationId])
    await pool.query(`INSERT INTO memory_review_policy_versions(policy_version_id,policy_id,version_number,document,content_hash)
      SELECT $1,$2,1,v.document,v.content_hash FROM memory_review_policy_sets s JOIN memory_review_policy_heads h USING(policy_id)
      JOIN memory_review_policy_versions v ON v.policy_version_id=h.active_version_id WHERE s.installation_id=$3`,[versionId,policyId,s.f.installationId])
    await pool.query('INSERT INTO memory_review_policy_heads(policy_id,active_version_id,revision) VALUES($1,$2,1)',[policyId,versionId])
    await pool.query('UPDATE memory_owner_scopes SET parent_organization_id=$2 WHERE installation_id=$1',[s.f.installationId,scopeId])
    return {installationId,scopeId,policyId,versionId}
  }
  test.each(['policy_change','parent_revoke'])('prelocks inherited parent %s before taking connection ownership',async mode=>{
    const s=await setup(),parent=await parentPolicy(s),[first]=await s.service.plan(s.f.grant,{...s.request,files:s.files})
    expect(s.f.grant.scopeBindings.some(b=>b.installation_id===parent.installationId)).toBe(false)
    const writer=await pool.connect(),probe=await pool.connect()
    let pending:Promise<{value:GitProposal[]|undefined;error:Error|undefined}>|undefined
    try {
      await writer.query('BEGIN')
      if(mode==='policy_change')await writer.query('SELECT 1 FROM memory_review_policy_heads WHERE policy_id=$1 FOR UPDATE',[parent.policyId])
      else await writer.query('SELECT 1 FROM memory_owner_scopes WHERE installation_id=$1 FOR UPDATE',[parent.installationId])
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending=s.service.plan(s.f.grant,{...s.request,files:s.files}).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
      let waiting=false
      for(let i=0;i<100;i++) {
        waiting=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting
        if(waiting)break
        await pool.query('SELECT pg_sleep(0.01)')
      }
      expect(waiting).toBe(true)
      await probe.query('BEGIN')
      const available=await probe.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE NOWAIT',[s.f.connectionId]).then(()=>true,()=>false)
      await probe.query('ROLLBACK')
      expect(available).toBe(true)
      if(mode==='policy_change') {
        const next=randomUUID()
        await writer.query(`INSERT INTO memory_review_policy_versions(policy_version_id,policy_id,version_number,document,content_hash)
          SELECT $1,policy_id,2,document||'{"minimum_approvals":3}'::jsonb,repeat('a',64) FROM memory_review_policy_versions WHERE policy_version_id=$2`,[next,parent.versionId])
        await writer.query('UPDATE memory_review_policy_heads SET active_version_id=$2,revision=2 WHERE policy_id=$1',[parent.policyId,next])
      } else await writer.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=$1",[parent.installationId])
      await writer.query('COMMIT')
      const outcome=await pending
      if(mode==='policy_change') {
        expect(outcome.error).toBeUndefined()
        expect(outcome.value![0].revision).toBe('2')
        expect(outcome.value![0].policyHash).not.toBe(first.policyHash)
      } else expect(outcome.error?.message).toBe('git_policy_scope_stale')
    } finally {await writer.query('ROLLBACK');await probe.query('ROLLBACK');await pending;writer.release();probe.release()}
  })
})
