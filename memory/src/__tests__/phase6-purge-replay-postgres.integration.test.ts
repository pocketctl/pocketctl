import pg from 'pg'
import { afterAll,beforeAll,beforeEach,describe,expect,test,vi } from 'vitest'
import * as gitCoauthors from '../skills/git-coauthors.js'
import { applyMemorySchema,MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitImportFixture } from '../testing/phase6-import-fixture.js'
import { createGitImportService } from '../git-sync/import-service.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createSharedClaimLifecycle } from '../governance/publication-service.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { createClaimRevisionService } from '../governance/revision-service.js'
import { lockImportProposal,prepareGovernedImport,requireImportQuorum } from '../git-sync/governance-adapter.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { loadGitSyncConfig } from '../git-sync/config.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 whole projection lifecycle',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:12});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function setup(kinds=['rule']) {
    const s=await gitImportFixture(pool,kinds,true)
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    return {...s,imports:createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const})}
  }
  const subject=(s:Awaited<ReturnType<typeof setup>>,proposalId:string,generation='1')=>({installationId:s.f.installationId,
    connectionId:s.f.connectionId,exportId:s.bundle.exportId,expectedGeneration:generation,proposalId,expectedRevision:'1'})
  async function clean(s:Awaited<ReturnType<typeof setup>>) {
    for(const table of ['memory_git_snapshot_assets','memory_git_import_proposals','memory_git_conflicts','memory_git_confirmed_bases','memory_git_outbox'])
      expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE installation_id=$1`,[s.f.installationId])).rows[0].n,table).toBe(0)
    expect(BigInt((await pool.query('SELECT generation FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation)).toBeGreaterThan(1n)
  }
  // A missing whole-document invalidation leaves both its evidence excerpts and
  // pending Git edits readable after removal of just one original Evidence.
  test('one Evidence removal erases the entire export and pending proposal, retaining denominator',async()=>{
    const s=await setup(),{runId}=await s.plan()
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    await clean(s)
    expect((await pool.query('SELECT eligible,unfinished FROM memory_git_run_receipts WHERE run_id=$1',[runId])).rows[0]).toEqual({eligible:true,unfinished:false})
    await expect(s.service.plan(s.f.grant,s.request)).rejects.toThrow()
  })
  test.each(['delete','identity_update'])('Wiki binding %s invalidates the complete two-binding projection and retains the run denominator',async change=>{
    const s=await setup(['wiki'])
    await pool.query(`INSERT INTO memory_wiki_source_bindings(wiki_version_id,installation_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha)
      SELECT wiki_version_id,installation_id,section_id,gen_random_uuid(),source_kind,source_token,source_snapshot_id,commit_sha
      FROM memory_wiki_source_bindings WHERE wiki_version_id=$1`,[s.f.wiki.versionId])
    const exports=createGitExportService(s.deps),bundle=await exports.export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,
      expectedGeneration:'1',baseCommit:'c'.repeat(40),purpose:'external_export',assets:s.f.keys.filter(k=>k.kind==='wiki')})
    const request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:bundle.exportId}
    const inbox=createGitInboxService({...s.deps,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),scopeMode:async()=> 'enabled' as const})
    await inbox.enroll(s.f.grant,request)
    const queued=await inbox.receive(request,{source:'export',eventId:'two-binding-export',changeNumber:'1'})
    await s.service.plan(s.f.grant,{...s.request,exportId:bundle.exportId,files:bundle.files})
    const bindings=(await pool.query('SELECT binding_id FROM memory_wiki_source_bindings WHERE wiki_version_id=$1 ORDER BY binding_id',[s.f.wiki.versionId])).rows
    expect(bindings).toHaveLength(2)
    await pool.query('UPDATE memory_wiki_source_bindings SET created_at=NOW(),source_token=source_token WHERE wiki_version_id=$1',[s.f.wiki.versionId])
    await expect(exports.loadRegisteredBase(s.f.grant,request)).resolves.toMatchObject({exportId:bundle.exportId})
    if(change==='delete')await pool.query('DELETE FROM memory_wiki_source_bindings WHERE wiki_version_id=$1 AND binding_id=$2',[s.f.wiki.versionId,bindings[0].binding_id])
    else await pool.query("UPDATE memory_wiki_source_bindings SET source_token='replacement-source' WHERE wiki_version_id=$1 AND binding_id=$2",[s.f.wiki.versionId,bindings[0].binding_id])
    await clean(s)
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('2')
    expect((await pool.query('SELECT count(*)::int n FROM memory_wiki_source_bindings WHERE wiki_version_id=$1',[s.f.wiki.versionId])).rows[0].n).toBe(change==='delete'?1:2)
    expect((await pool.query('SELECT eligible,unfinished FROM memory_git_run_receipts WHERE run_id=$1',[queued.runId])).rows[0]).toEqual({eligible:false,unfinished:true})
    await expect(exports.loadRegisteredBase(s.f.grant,request)).rejects.toThrow('git_export_unregistered')
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_tombstones WHERE kind='wiki'")).rows[0].n).toBe(0)
  })
  test.each(['off','state','explicit'])('direct %s transition advances one lifecycle epoch and requires fresh authorized admission',async transition=>{
    const s=await setup(),config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),inbox=createGitInboxService({...s.deps,config,scopeMode:async()=> 'enabled' as const})
    const request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId}
    await inbox.enroll(s.f.grant,request)
    const queued=await inbox.receive(request,{source:'export',eventId:'before-off',changeNumber:'1'})
    if(transition==='off')await pool.query("UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id=$1",[s.f.connectionId])
    if(transition==='state')await pool.query("UPDATE memory_git_connections SET state='disabled' WHERE connection_id=$1",[s.f.connectionId])
    if(transition==='explicit')await pool.query("UPDATE memory_git_connections SET sync_mode='off',generation=generation+1 WHERE connection_id=$1",[s.f.connectionId])
    await pool.query('UPDATE memory_git_connections SET state=state,sync_mode=sync_mode WHERE connection_id=$1',[s.f.connectionId])
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('2')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_lifecycle_epochs WHERE connection_id=$1',[s.f.connectionId])).rows[0].n).toBe(1)
    await clean(s)
    expect((await pool.query('SELECT state,unfinished FROM memory_git_run_receipts WHERE run_id=$1',[queued.runId])).rows[0]).toEqual({state:'invalidated',unfinished:true})
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled',state='active' WHERE connection_id=$1",[s.f.connectionId])
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    await expect(inbox.enroll(s.f.grant,request)).rejects.toThrow()
    const exports=createGitExportService(s.deps)
    await expect(exports.export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',
      baseCommit:'c'.repeat(40),purpose:'external_export',assets:s.f.keys.filter(k=>k.kind==='rule')})).rejects.toThrow('git_generation_conflict')
    const bundle=await exports.export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:generation,
      baseCommit:'c'.repeat(40),purpose:'external_export',assets:s.f.keys.filter(k=>k.kind==='rule')})
    const current={...request,expectedGeneration:generation,exportId:bundle.exportId}
    await inbox.enroll(s.f.grant,current)
    const fresh=await inbox.receive(current,{source:'export',eventId:'after-off',changeNumber:'1'})
    expect(fresh.runId).not.toBe(queued.runId)
  })
  test.each(['claim','session','snapshot','graph','build_source','repository','scope','installation'] as const)('%s withdrawal clears whole Git copies',async kind=>{
    const s=await setup(kind==='snapshot'||kind==='graph'||kind==='build_source'?['wiki']:['rule']);await s.plan()
    if(kind==='claim')await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[s.f.rule.claimId])
    if(kind==='session')await createPurgeRepository(pool,{hmacKey:'fixture-only'}).purgeSession({installationId:s.f.installationId,sessionId:'shared-governance',reason:'fixture',sourceFeedId:null})
    if(kind==='snapshot')await pool.query("UPDATE memory_source_snapshots SET state='purged' WHERE snapshot_id=(SELECT source_snapshot_id FROM memory_wiki_versions WHERE wiki_version_id=$1)",[s.f.wiki.versionId])
    if(kind==='graph')await pool.query('DELETE FROM memory_code_nodes WHERE node_id=$1',[s.f.nodeId])
    if(kind==='build_source')await pool.query('DELETE FROM memory_wiki_build_sources WHERE run_id=$1',[s.f.runId])
    if(kind==='repository')await pool.query("INSERT INTO memory_repository_tombstones(installation_id,repository_id,reason_code) VALUES($1,$2,'fixture')",[s.f.installationId,s.f.repositoryId])
    if(kind==='scope')await pool.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=$1",[s.f.installationId])
    if(kind==='installation')await pool.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[s.f.installationId])
    await clean(s)
  })
  test.each(['rule','skill','wiki'])('governed %s delete commits revoke and retained same-result retry without body',async kind=>{
    const s=await setup([kind]),files=s.bundle.files.filter(f=>f.path.endsWith('/manifest.yaml')||f.path.includes('/attestations/'))
    const {proposals:[p]}=await s.plan(files),input=subject(s,p.proposalId)
    await s.imports.review(s.f.skill.reviewer.grant,{...input,decision:'approve'})
    const result=await s.imports.apply(s.f.skill.publisher.grant,input)
    expect(result.outcome).toBe('revoked');await clean(s)
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    await expect(s.imports.apply(s.f.skill.publisher.grant,{...input,expectedGeneration:generation})).resolves.toEqual(result)
    await expect(s.imports.apply(s.f.skill.publisher.grant,{...input,expectedGeneration:generation,exportId:s.f.repositoryId})).rejects.toThrow()
    if(kind==='wiki') {
      expect((await pool.query('SELECT state FROM memory_wiki_versions WHERE wiki_version_id=$1',[s.f.wiki.versionId])).rows[0].state).toBe('revoked')
      expect((await pool.query('SELECT count(*)::int n FROM memory_wiki_sections WHERE wiki_version_id=$1',[s.f.wiki.versionId])).rows[0].n).toBe(2)
      await expect(pool.query("UPDATE memory_wikis SET state='active' WHERE wiki_id=$1",[s.f.wiki.wikiId])).rejects.toThrow('wiki_revoked')
      await expect(pool.query("UPDATE memory_wiki_versions SET state='active' WHERE wiki_version_id=$1",[s.f.wiki.versionId])).rejects.toThrow('wiki_revoked')
      await expect(pool.query('UPDATE memory_wiki_heads SET active_version_id=$2 WHERE wiki_id=$1',[s.f.wiki.wikiId,s.f.wiki.versionId])).rejects.toThrow('wiki_revoked')
      await expect(pool.query("UPDATE memory_wiki_build_runs SET state='queued' WHERE run_id=$1",[s.f.runId])).rejects.toThrow('wiki_revoked')
      await expect(createGitExportService(s.deps).export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:generation,
        baseCommit:'c'.repeat(40),purpose:'external_export',assets:s.f.keys.filter(k=>k.kind==='wiki')})).rejects.toThrow()
    }
    await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.skill.publisher.membershipId])
    await expect(s.imports.confirmedOutcome(s.f.skill.publisher.grant,{...input,expectedGeneration:generation})).rejects.toThrow()
  })
  test('unrelated membership changes do not invalidate valid shared exports',async()=>{
    const s=await setup(),other=await s.f.skill.actor(['reader'],['read'])
    await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[other.membershipId])
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('1')
    await expect(s.service.plan(s.f.grant,s.request)).resolves.toHaveLength(1)
  })
  test('direct target identity mutation invalidates old base and pending apply, not scheduler-only metadata',async()=>{
    const s=await setup(),{proposals:[p]}=await s.plan()
    await s.imports.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    await pool.query("UPDATE memory_git_connections SET cursor='fixture-cursor',next_poll_at=clock_timestamp()+interval '1 minute',updated_at=NOW() WHERE connection_id=$1",[s.f.connectionId])
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('1')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets')).rows[0].n).toBe(1)
    await pool.query("UPDATE memory_git_connections SET target_branch='new-branch' WHERE connection_id=$1",[s.f.connectionId])
    await clean(s)
    await expect(s.imports.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow()
    await expect(s.service.plan(s.f.grant,s.request)).rejects.toThrow()
  })
  test('physical connection deletion preserves no-body receipts without rewriting the deleting row',async()=>{
    const s=await setup(),{runId}=await s.plan()
    await pool.query('DELETE FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT eligible FROM memory_git_run_receipts WHERE run_id=$1',[runId])).rows[0].eligible).toBe(true)
  })
  test.each(['scope_tombstone','wiki_version_revoke','wiki_commit_tombstone','skill_disable','replay_session','session_delete','member_valid_from'])('%s invalidates its exact source projection',async change=>{
    const s=await setup(change.startsWith('wiki')?['wiki']:change.startsWith('skill')||change==='replay_session'||change==='session_delete'?['skill']:['rule'])
    if(change==='scope_tombstone')await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('team',$1,1,'fixture')",[s.f.installationId])
    if(change==='wiki_version_revoke')await pool.query("UPDATE memory_wiki_versions SET state='revoked' WHERE wiki_version_id=$1",[s.f.wiki.versionId])
    if(change==='wiki_commit_tombstone')await pool.query(`INSERT INTO memory_source_snapshot_tombstones(installation_id,repository_id,snapshot_id,commit_sha,reason_code)
      SELECT installation_id,repository_id,gen_random_uuid(),commit_sha,'fixture' FROM memory_source_snapshots WHERE snapshot_id=(SELECT source_snapshot_id FROM memory_wiki_versions WHERE wiki_version_id=$1)`,[s.f.wiki.versionId])
    if(change==='skill_disable')await pool.query("UPDATE memory_skill_publication_heads SET state='disabled' WHERE skill_id=$1",[s.f.skill.reviewed.skillId])
    if(change==='replay_session')await createPurgeRepository(pool,{hmacKey:'fixture'}).purgeSession({installationId:s.f.installationId,sessionId:s.f.skill.sessionId,reason:'fixture',sourceFeedId:null})
    if(change==='session_delete')await pool.query('DELETE FROM source_sessions WHERE installation_id=$1 AND session_id=$2',[s.f.installationId,s.f.skill.sessionId])
    if(change==='member_valid_from')await pool.query("UPDATE memory_scope_memberships SET valid_from=clock_timestamp()+interval '1 day' WHERE membership_id=$1",[s.f.membershipId])
    await clean(s)
  })
  test('a Wiki lock change invalidates the old projection without permanently retiring its identity',async()=>{
    const s=await setup(['wiki'])
    await pool.query('UPDATE memory_wiki_manual_section_heads SET locked=true WHERE wiki_id=$1',[s.f.wiki.wikiId])
    await clean(s)
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    expect((await pool.query("SELECT count(*)::int n FROM memory_git_tombstones WHERE kind='wiki'")).rows[0].n).toBe(0)
    // Reflect the domain lock in the current generated view, as its ordinary
    // publisher does; a new export is permitted under the new generation.
    await pool.query("UPDATE memory_wiki_sections SET authority='locked' WHERE wiki_version_id=$1 AND section_key='manual'",[s.f.wiki.versionId])
    const bundle=await createGitExportService(s.deps).export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:generation,
      baseCommit:'d'.repeat(40),purpose:'external_export',assets:s.f.keys.filter(k=>k.kind==='wiki')})
    expect(bundle.assets[0].asset.key.id).toBe(s.f.wiki.wikiId)
  })
  test.each(['domain','final','mode'])('%s failure after confirmation rolls revoke, generation and retained metadata back atomically',async failure=>{
    const s=await setup(),{proposals:[p]}=await s.plan(s.bundle.files.filter(f=>f.path.endsWith('/manifest.yaml')||f.path.includes('/attestations/')))
    await s.imports.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    if(failure==='domain') {
      await pool.query("CREATE FUNCTION fixture_revoke_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_revoke_failure'; END $$")
      await pool.query("CREATE TRIGGER z_fixture_revoke_fail AFTER UPDATE OF state ON knowledge_claims FOR EACH ROW WHEN (NEW.state='revoked') EXECUTE FUNCTION fixture_revoke_fail()")
    } else if(failure==='final') {
      await pool.query(`CREATE FUNCTION fixture_revoke_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id='${s.originalAuthor.membershipId}'; RETURN NEW; END $$`)
      await pool.query("CREATE TRIGGER z_fixture_revoke_fail AFTER UPDATE OF state ON knowledge_claims FOR EACH ROW WHEN (NEW.state='revoked') EXECUTE FUNCTION fixture_revoke_fail()")
    } else {
      await pool.query(`CREATE FUNCTION fixture_revoke_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id='${s.f.connectionId}'; RETURN NEW; END $$`)
      await pool.query("CREATE TRIGGER z_fixture_revoke_fail AFTER UPDATE OF state ON knowledge_claims FOR EACH ROW WHEN (NEW.state='revoked') EXECUTE FUNCTION fixture_revoke_fail()")
    }
    try{await expect(s.imports.apply(s.f.skill.publisher.grant,subject(s,p.proposalId))).rejects.toThrow()}
    finally{await pool.query('DROP TRIGGER z_fixture_revoke_fail ON knowledge_claims; DROP FUNCTION fixture_revoke_fail()')}
    expect((await pool.query('SELECT state,current_version_id FROM knowledge_claims WHERE claim_id=$1',[s.f.rule.claimId])).rows[0]).toEqual({state:'active',current_version_id:s.f.rule.versionId})
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('1')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_retained_outcomes')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
  })
  test('whole-export cleanup preserves the successful sibling Claim typed authority and exact outcome',async()=>{
    const s=await setup(['rule','wiki']),files=s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.statement='Sibling result'})
      .filter(f=>!f.path.includes('/wiki/'))
    const {proposals}=await s.plan(files),rule=proposals.find(p=>p.key.kind==='rule')!,wiki=proposals.find(p=>p.key.kind==='wiki')!
    await s.imports.review(s.f.skill.reviewer.grant,{...subject(s,rule.proposalId),decision:'approve'})
    const result=await s.imports.apply(s.f.skill.publisher.grant,subject(s,rule.proposalId))
    await s.imports.review(s.f.skill.reviewer.grant,{...subject(s,wiki.proposalId),decision:'approve'})
    await s.imports.apply(s.f.skill.publisher.grant,subject(s,wiki.proposalId))
    await clean(s)
    expect((await pool.query('SELECT version_id FROM memory_git_claim_authority WHERE version_id=$1',[result.versionId])).rows).toEqual([{version_id:result.versionId}])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_claim_authority_decisions WHERE version_id=$1',[result.versionId])).rows[0].n).toBe(1)
    const generation=(await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation
    await expect(s.imports.confirmedOutcome(s.f.skill.publisher.grant,subject(s,rule.proposalId,generation))).resolves.toEqual(result)
    await pool.query('UPDATE knowledge_claims SET current_version_id=NULL WHERE claim_id=$1',[s.f.rule.claimId])
    await pool.query('DELETE FROM knowledge_versions WHERE version_id=$1',[result.versionId])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_claim_authority WHERE version_id=$1',[result.versionId])).rows[0].n).toBe(0)
  })
  test.each(['state','domain','purge'].flatMap(kind=>['delete_first','apply_first'].map(order=>({kind,order}))))('$kind $order serializes withdrawal and edit application without restoring content',async({kind,order})=>{
    const s=await setup(),{proposals:[p]}=await s.plan(),input=subject(s,p.proposalId)
    await s.imports.review(s.f.skill.reviewer.grant,{...input,decision:'approve'})
    const client=await pool.connect();await client.query('BEGIN')
    let apply:Promise<unknown>|undefined,remove:Promise<unknown>|undefined
    const withdraw=async(bound?:pg.PoolClient)=>{
      if(kind==='state')return (bound??pool).query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[s.f.rule.claimId])
      if(kind==='purge')return createPurgeRepository(pool,{hmacKey:'fixture'}).purgeSession({installationId:s.f.installationId,sessionId:'shared-governance',reason:'fixture',sourceFeedId:null},bound)
      const target=bound?createTransactionBoundPool(bound):pool
      // Revision is fixed by the two explicitly orchestrated serialization orders.
      return createSharedClaimLifecycle(target).revokeSharedClaim({grant:s.f.skill.publisher.grant,targetInstallationId:s.f.installationId,
        claimId:s.f.rule.claimId,reason:'fixture',expectedRevision:order==='delete_first'?1:2})
    }
    try {
      if(order==='delete_first') {
        if(kind==='purge')await client.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':shared-governance',0))",[s.f.installationId])
        else await client.query('SELECT 1 FROM knowledge_claims WHERE claim_id=$1 FOR UPDATE',[s.f.rule.claimId])
        apply=s.imports.apply(s.f.skill.publisher.grant,input).then(()=> 'applied',()=> 'denied')
        await client.query('SELECT pg_sleep(0.03)')
        await withdraw(client)
        await client.query('COMMIT');expect(await apply).toBe('denied')
      } else {
        await client.query('SELECT 1 FROM memory_git_connections WHERE connection_id=$1 FOR UPDATE',[s.f.connectionId])
        apply=s.imports.apply(s.f.skill.publisher.grant,input)
        // Wait for the importer to own its source head before starting purge.
        for(let n=0;n<100;n++) {
          const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT %memory_git_connections%FOR UPDATE%'")
          if(waiting.rowCount)break
          await pool.query('SELECT pg_sleep(0.01)')
        }
        remove=withdraw()
        await client.query('COMMIT');expect(await apply).toMatchObject({outcome:'published'});await remove
      }
      await clean(s)
      await expect(s.service.plan(s.f.grant,s.request)).rejects.toThrow()
    }finally{await client.query('ROLLBACK');client.release();await apply?.catch(()=>undefined);await remove?.catch(()=>undefined)}
  })
  test('deleting the complete installation retains metadata receipts while clearing all Git bodies',async()=>{
    const s=await setup(),{runId}=await s.plan()
    await createPurgeRepository(pool,{hmacKey:'fixture'}).purgeInstallation({installationId:s.f.installationId,requestId:s.f.repositoryId,reason:'fixture'})
    expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[s.f.installationId])).rows[0].local_status).toBe('purged')
    expect((await pool.query('SELECT eligible FROM memory_git_run_receipts WHERE run_id=$1',[runId])).rows[0].eligible).toBe(true)
    for(const table of ['memory_git_snapshot_assets','memory_git_import_proposals','memory_git_confirmed_bases'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
  })
  async function legacy43(){
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await pool.query('CREATE TABLE memory_schema_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ DEFAULT NOW())')
    const client=await pool.connect()
    try{for(const migration of MEMORY_MIGRATIONS.filter(m=>m.version<44)){
      await client.query('BEGIN');for(const statement of migration.statements)await client.query(statement)
      await client.query('INSERT INTO memory_schema_migrations(version) VALUES($1)',[migration.version]);await client.query('COMMIT')
    }}finally{client.release()}
  }
  // These upgrade fixtures seed an ordinary dependency Skill using schema43's
  // live-only authorship semantics. This is not production old-schema support:
  // restore before any lifecycle mutation, migration, or current-schema check.
  async function setupLegacy43(){
    const authors=vi.spyOn(gitCoauthors,'loadGitSkillCoauthors').mockImplementation(async(client,installationId,versionId)=>{
      expect((await client.query('SELECT max(version) AS version FROM memory_schema_migrations')).rows[0].version).toBe(43)
      expect((await client.query("SELECT to_regclass('memory_git_retained_outcomes') AS name")).rows[0].name).toBeNull()
      const result=await client.query<{resolver_membership_id:string}>(`SELECT DISTINCT a.resolver_membership_id
        FROM memory_git_revision_links l JOIN memory_git_import_outcomes o USING(installation_id,connection_id,link_id,binding_id)
        JOIN memory_skill_versions v ON v.installation_id=l.installation_id AND v.skill_id=l.skill_id AND v.version_id=l.skill_version_id
        JOIN memory_git_resolution_authors a ON a.installation_id=l.installation_id AND a.connection_id=l.connection_id
          AND a.proposal_id=o.proposal_id AND a.proposal_revision<=o.proposal_revision
        WHERE l.installation_id=$1 AND l.skill_version_id=$2`,[installationId,versionId])
      return new Set(result.rows.map(row=>row.resolver_membership_id))
    })
    try{return await setup()}finally{authors.mockRestore();expect(vi.isMockFunction(gitCoauthors.loadGitSkillCoauthors)).toBe(false)}
  }
  async function upgradeLegacy43(s:Awaited<ReturnType<typeof setup>>){
    await applyMemorySchema(pool)
    await expect(gitCoauthors.loadGitSkillCoauthors(pool,s.f.installationId,s.f.skill.reviewed.versionId)).resolves.toEqual(new Set())
  }
  test.each(['member','claim','evidence'])('migration44 removes legacy43 %s invalidated bodies without requiring another source event',async loss=>{
    await legacy43()
    const s=await setupLegacy43(),{runId}=await s.plan()
    if(loss==='member')await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.membershipId])
    if(loss==='claim')await pool.query("UPDATE knowledge_claims SET state='revoked' WHERE claim_id=$1",[s.f.rule.claimId])
    if(loss==='evidence')await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets')).rows[0].n).toBe(1)
    await upgradeLegacy43(s);await clean(s)
    expect((await pool.query('SELECT eligible FROM memory_git_run_receipts WHERE run_id=$1',[runId])).rows[0].eligible).toBe(true)
  })
  test('migration44 backfills live43 proposal provenance and exact source deletion protection',async()=>{
    await legacy43()
    const s=await setupLegacy43(),{proposals:[p]}=await s.plan()
    await s.imports.review(s.f.skill.reviewer.grant,{...subject(s,p.proposalId),decision:'approve'})
    // Seed a real43 domain publication through its original governed boundary;
    // no Task8 metadata tables or historical authorization fabrication.
    const published=await createGitExportService(s.deps).withApplyBase(s.f.skill.publisher.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,
      expectedGeneration:'1',exportId:s.bundle.exportId},async context=>{
      const proposal=await lockImportProposal(context,subject(s,p.proposalId)),governed=await prepareGovernedImport(context,proposal,true)
      await requireImportQuorum(context,governed)
      return createClaimRevisionService(createTransactionBoundPool(context.client)).append({grant:s.f.skill.publisher.grant,installationId:s.f.installationId,governed})
    })
    await upgradeLegacy43(s)
    expect((await pool.query('SELECT proposal_id FROM memory_git_proposal_identities')).rows).toEqual([{proposal_id:p.proposalId}])
    expect((await pool.query('SELECT version_id FROM memory_git_claim_authority WHERE version_id=$1',[published.versionId])).rows).toEqual([{version_id:published.versionId}])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_claim_authority_decisions WHERE version_id=$1',[published.versionId])).rows[0].n).toBe(1)
    await clean(s)
    await expect(createGitExportService(s.deps).loadRegisteredBase(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,
      expectedGeneration:'1',exportId:s.bundle.exportId})).rejects.toThrow('git_export_unregistered')
    const fresh=await createGitExportService(s.deps).export(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'2',
      baseCommit:'c'.repeat(40),purpose:'external_export',assets:s.f.keys.filter(k=>k.kind==='rule')})
    expect(fresh.exportId).not.toBe(s.bundle.exportId)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_sources WHERE export_id=$1',[fresh.exportId])).rows[0].n).toBeGreaterThan(0)
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[published.versionId])
    await clean(s)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_governed_revisions')).rows[0].n).toBe(1)
  })
  test('migration44 cleanup failure rolls schema, generation and content back to43',async()=>{
    await legacy43();const s=await setupLegacy43()
    await pool.query("CREATE FUNCTION fixture_upgrade_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_upgrade_failure'; END $$")
    await pool.query('CREATE TRIGGER zz_fixture_upgrade_fail BEFORE DELETE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION fixture_upgrade_fail()')
    try{await expect(applyMemorySchema(pool)).rejects.toThrow('fixture_upgrade_failure')}
    finally{await pool.query('DROP TRIGGER zz_fixture_upgrade_fail ON memory_git_snapshots; DROP FUNCTION fixture_upgrade_fail()')}
    expect((await pool.query('SELECT max(version) AS n FROM memory_schema_migrations')).rows[0].n).toBe(43)
    expect((await pool.query("SELECT to_regclass('memory_git_retained_outcomes') AS name")).rows[0].name).toBeNull()
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('1')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets')).rows[0].n).toBe(1)
    await upgradeLegacy43(s);await clean(s)
  })
})
