import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { Registry } from 'prom-client'
import { afterAll,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import { applyMemorySchema,MEMORY_MIGRATIONS } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitImportFixture } from '../testing/phase6-import-fixture.js'
import { createGitImportService } from '../git-sync/import-service.js'
import * as metricsModule from '../metrics.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Phase 6 canonical metrics survive source projection cleanup',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function snapshot(){expect(metricsModule.createPhase6Metrics).toBeTypeOf('function');const registry=new Registry(),metrics=metricsModule.createPhase6Metrics(registry);await metricsModule.updatePhase6Gauges(pool,metrics);return registry.getMetricsAsJSON()}
  const value=(rows:any[],stage:string,state:string,provenance='fixture')=>rows.flatMap(r=>r.values).find(v=>v.labels.stage===stage&&v.labels.state===state&&v.labels.provenance===provenance)?.value??0
  const operational=(rows:any[],name:string,labels:Record<string,string>={})=>rows.find(r=>r.name===`pocketctl_memory_git_${name}`)?.values.find((v:any)=>Object.entries(labels).every(([k,x])=>v.labels[k]===x))?.value
  test.each(['source','connection','direct'])('%s cleanup records local duration after FK projection cleanup',async cause=>{
    const s=await gitImportFixture(pool),{proposals:[p]}=await s.plan()
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    const service=createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const}),input={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'}
    await service.review(s.f.skill.reviewer.grant,{...input,decision:'approve'})
    await service.apply(s.f.skill.publisher.grant,input)
    await pool.query(`CREATE FUNCTION fixture_measure_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM memory_git_snapshot_assets WHERE export_id=OLD.export_id)
        OR EXISTS(SELECT 1 FROM memory_git_snapshot_sources WHERE export_id=OLD.export_id)
        OR EXISTS(SELECT 1 FROM memory_git_import_proposals WHERE export_id=OLD.export_id)
        OR NOT EXISTS(SELECT 1 FROM memory_git_projection_invalidations WHERE export_id=OLD.export_id AND finished_at IS NOT NULL)
        THEN RAISE EXCEPTION 'measurement_before_cleanup'; END IF; RETURN OLD; END $$`)
    await pool.query('CREATE TRIGGER memory_git_99_check_measurement AFTER DELETE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION fixture_measure_cleanup()')
    try{
      if(cause==='source')await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
      else if(cause==='connection')await pool.query("UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id=$1",[s.f.connectionId])
      else await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    }finally{await pool.query('DROP TRIGGER memory_git_99_check_measurement ON memory_git_snapshots; DROP FUNCTION fixture_measure_cleanup()')}
    const rows=await snapshot()
    expect(operational(rows,'projection_invalidation_seconds_count')).toBe(1)
    expect(operational(rows,'projection_invalidation_seconds_sum')).toBeGreaterThan(0)
    expect(operational(rows,'measurement_available',{measurement:'projection_invalidation'})).toBe(1)
    expect(operational(rows,'reviews',{decision:'approve'})).toBe(1)
    expect(operational(rows,'review_duration_seconds_count',{decision:'approve'})).toBe(1)
    expect(operational(rows,'operational_rows',{stage:'proposal',state:'applied'})).toBe(1)
    expect(value(rows,'asset_outcome','published')).toBe(1)
  })
  test('late delete failure rolls back local measurement with projection and generation',async()=>{
    const s=await gitImportFixture(pool)
    await pool.query(`CREATE FUNCTION fixture_late_measure_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_late_failure'; END $$`)
    await pool.query('CREATE TRIGGER memory_git_99_late_failure AFTER DELETE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION fixture_late_measure_failure()')
    try{await expect(pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])).rejects.toThrow('fixture_late_failure')}
    finally{await pool.query('DROP TRIGGER memory_git_99_late_failure ON memory_git_snapshots; DROP FUNCTION fixture_late_measure_failure()')}
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_projection_invalidations')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].generation).toBe('1')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshot_assets WHERE export_id=$1',[s.bundle.exportId])).rows[0].n).toBe(1)
    expect(operational(await snapshot(),'measurement_available',{measurement:'projection_invalidation'})).toBe(0)
  })
  test('backwards wall clock sample stays missing without blocking local revocation',async()=>{
    const s=await gitImportFixture(pool)
    await pool.query(`CREATE FUNCTION fixture_backwards_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE memory_git_projection_invalidations SET started_at=clock_timestamp()+INTERVAL '1 hour' WHERE export_id=OLD.export_id;
      RETURN OLD; END $$`)
    await pool.query('CREATE TRIGGER memory_git_00z_backwards_clock BEFORE DELETE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION fixture_backwards_clock()')
    try{await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])}
    finally{await pool.query('DROP TRIGGER memory_git_00z_backwards_clock ON memory_git_snapshots; DROP FUNCTION fixture_backwards_clock()')}
    expect((await pool.query('SELECT duration_seconds,finished_at IS NOT NULL AS finished FROM memory_git_projection_invalidations')).rows).toEqual([{duration_seconds:null,finished:true}])
    const rows=await snapshot()
    expect(operational(rows,'measurement_available',{measurement:'projection_invalidation'})).toBe(0)
    expect(operational(rows,'measurement_missing_rows',{measurement:'projection_invalidation'})).toBe(1)
    expect(operational(rows,'projection_invalidation_seconds_sum')).toBeUndefined()
  })
  test('operational conflict review cleanup and unsettled measurements use distinct durable denominators',async()=>{
    const s=await gitImportFixture(pool),{proposals:[p],runId}=await s.plan()
    await pool.query(`INSERT INTO memory_git_request_reservations(reservation_id,installation_id,run_id,attempt,job_id,claim_epoch,operation)
      VALUES(gen_random_uuid(),$1,$2,1,gen_random_uuid(),1,'merge')`,[s.f.installationId,runId])
    await pool.query(`INSERT INTO memory_git_remote_cleanup(installation_id,connection_id,export_id,old_run_id,generation,provider,provider_repository_id,target_branch,remote_branch)
      VALUES($1,$2,$3,$4,1,'github','123','main','pocketctl/export/fixture')`,[s.f.installationId,s.f.connectionId,s.bundle.exportId,runId])
    const stepStates=['pending','dispatching','reconciling','completed','conflicted']
    for(const [step,state] of stepStates.entries())await pool.query(`INSERT INTO memory_git_retained_steps(installation_id,connection_id,export_id,outbox_id,step,operation,state)
      VALUES($1,$2,$3,$4,$5,'tree',$6)`,[s.f.installationId,s.f.connectionId,s.bundle.exportId,runId,step,state])
    const service=createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const}),request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'}
    await service.review(s.f.skill.reviewer.grant,{...request,decision:'request_changes'})
    const other=await gitImportFixture(pool);await other.advanceRule()
    const {proposals:[conflicted]}=await other.plan(other.edit(other.bundle.files,v=>{if(v.key)v.editable.structuredContent.retries=11}))
    expect(conflicted.state).toBe('conflicted')
    const before=await snapshot()
    expect(operational(before,'operational_rows',{stage:'proposal',state:'conflicted'})).toBe(1)
    expect(operational(before,'reviews',{decision:'request_changes'})).toBe(1)
    expect(operational(before,'cleanup_rows',{state:'pending_unrecognized'})).toBe(1)
    for(const state of stepStates)expect(operational(before,'operational_rows',{stage:'outbox_step',state})).toBe(1)
    expect(operational(before,'oldest_seconds',{stage:'reserved_request'})).toBeGreaterThan(0)
    expect(operational(before,'budget_runs',{unit:'requests',state:'unknown'})).toBe(2)
    expect(operational(before,'request_rows',{operation:'merge',state:'reserved'})).toBe(1)
    expect(operational(before,'measurement_missing_rows',{measurement:'request_duration'})).toBe(1)
    expect(operational(before,'measurement_available',{measurement:'request_duration'})).toBe(0)
    expect(operational(before,'request_duration_seconds_sum',{operation:'merge',state:'reserved'})).toBeUndefined()
    await pool.query('UPDATE memory_git_remote_cleanup SET recognized_at=NOW() WHERE export_id=$1',[s.bundle.exportId])
    await pool.query('DELETE FROM memory_git_snapshots WHERE export_id=$1',[s.bundle.exportId])
    const after=await snapshot()
    expect(operational(after,'cleanup_rows',{state:'pending_recognized'})).toBe(1)
    expect(operational(after,'reviews',{decision:'request_changes'})).toBe(1)
    expect(operational(after,'request_rows',{operation:'merge',state:'reserved'})).toBe(1)
    expect(operational(after,'operational_rows',{stage:'proposal',state:'purged_unfinished'})).toBe(1)
    for(const state of stepStates)expect(operational(after,'operational_rows',{stage:'outbox_step',state})).toBe(1)
  })
  test('two assets one confirmed links yield one partial change before and after purge with no duplicated outcome',async()=>{
    const s=await gitImportFixture(pool,['rule','claim']),{proposals,runId}=await s.plan(s.bundle.files,null)
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    const service=createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const}),p=proposals[0]
    await service.apply(s.f.skill.publisher.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'})
    const before=await snapshot()
    expect(value(before,'canonical_change','partial')).toBe(1)
    expect(value(before,'asset_outcome','linked')).toBe(1);expect(value(before,'asset_outcome','unfinished')).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_original_authors')).rows[0].n).toBe(0)
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    const after=await snapshot()
    expect(value(after,'canonical_change','partial')).toBe(1)
    expect(value(after,'asset_outcome','linked')).toBe(1);expect(value(after,'asset_outcome','unfinished')).toBe(1)
    expect((await pool.query('SELECT run_id FROM memory_git_proposal_runs WHERE installation_id=$1',[s.f.installationId])).rows.map(r=>r.run_id)).toEqual([runId,runId])
  })
  test('bindings are atomic, immutable and tenant-bound',async()=>{
    expect((await pool.query("SELECT to_regclass('memory_git_proposal_runs') AS name")).rows[0].name).toBe('memory_git_proposal_runs')
    const s=await gitImportFixture(pool),planned=await s.service.plan(s.f.grant,s.request),p=planned[0]
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_proposal_runs')).rows[0].n).toBe(0)
    const client=await pool.connect()
    try{await client.query('BEGIN');await expect(client.query('UPDATE memory_git_import_proposals SET run_id=$2 WHERE proposal_id=$1',[p.proposalId,randomUUID()])).rejects.toBeDefined();await client.query('ROLLBACK')}finally{client.release()}
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_proposal_runs')).rows[0].n).toBe(0)
    const {runId}=await s.plan(s.bundle.files,null)
    await expect(pool.query('UPDATE memory_git_proposal_runs SET run_id=$2 WHERE proposal_id=$1',[p.proposalId,randomUUID()])).rejects.toThrow('git_proposal_run_immutable')
    const other=await gitImportFixture(pool),{proposals:[otherP]}=await other.plan()
    await expect(pool.query('INSERT INTO memory_git_proposal_runs VALUES($1,$2,$3,$4)',[s.f.installationId,s.f.connectionId,otherP.proposalId,runId])).rejects.toBeDefined()
  })
  test('44 to 45 upgrade attributes provable completed links and retains legacy unfinished as unattributed',async()=>{
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    for(const migration of MEMORY_MIGRATIONS.filter(m=>m.version<=44)){const client=await pool.connect();try{await client.query('BEGIN');for(const statement of migration.statements)await client.query(statement);await client.query('INSERT INTO memory_schema_migrations(version) VALUES($1)',[migration.version]);await client.query('COMMIT')}finally{client.release()}}
    const s=await gitImportFixture(pool,['rule','claim']),{proposals}=await s.plan(s.bundle.files,null)
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    await createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const}).apply(s.f.skill.publisher.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:proposals[0].proposalId,expectedRevision:'1'})
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    await applyMemorySchema(pool);await applyMemorySchema(pool)
    expect((await pool.query('SELECT max(version) version FROM memory_schema_migrations')).rows[0].version).toBe(46)
    const rows=await snapshot()
    expect(value(rows,'asset_outcome','linked')).toBe(1)
    expect(value(rows,'asset_outcome','unfinished','unattributed')).toBe(1)
    expect(value(rows,'canonical_change','completed')).toBe(0)
  })
  async function bindAnother(s:Awaited<ReturnType<typeof gitImportFixture>>,originalRun:string,proposalId:string,head:string,client:Pick<pg.Pool,'query'>=pool) {
    const runId=randomUUID(),hash=runId.replaceAll('-','').repeat(2)
    await client.query(`INSERT INTO memory_git_runs(run_id,installation_id,connection_id,generation,direction,mode,outcome_kind,state,membership_id,membership_revision,authorization_epoch,config_version,request_hash,export_id,merge_commit,tree_sha)
      SELECT $2,installation_id,connection_id,generation,direction,mode,outcome_kind,'planned',membership_id,membership_revision,authorization_epoch,config_version,$3,export_id,$4,tree_sha FROM memory_git_runs WHERE run_id=$1`,[originalRun,runId,hash,head])
    await client.query(`INSERT INTO memory_git_run_receipts(installation_id,connection_id,generation,run_id,request_hash,admission_hash,outcome_kind,state,eligible,unfinished)
      VALUES($1,$2,1,$3,$4,$4,'fixture','planned',true,false)`,[s.f.installationId,s.f.connectionId,runId,hash])
    await client.query('INSERT INTO memory_git_merge_receipts VALUES($1,$2,1,$3,$4,$5)',[s.f.installationId,s.f.connectionId,head,runId,'c'.repeat(40)])
    await client.query('UPDATE memory_git_import_proposals SET run_id=$2 WHERE proposal_id=$1',[proposalId,runId])
    return runId
  }
  test('different merges of the same export remain two changes; duplicate deliveries do not add a canonical change',async()=>{
    const s=await gitImportFixture(pool),{runId}=await s.plan(s.bundle.files,null)
    const [second]=await s.service.plan(s.f.grant,{...s.request,headCommit:'d'.repeat(40)})
    const secondRun=await bindAnother(s,runId,second.proposalId,'d'.repeat(40))
    const duplicate=randomUUID(),hash=duplicate.replaceAll('-','').repeat(2)
    await pool.query(`INSERT INTO memory_git_run_receipts(installation_id,connection_id,generation,run_id,canonical_run_id,request_hash,admission_hash,outcome_kind,state,eligible,unfinished)
      VALUES($1,$2,1,$3,$4,$5,$5,'fixture','duplicate',false,false)`,[s.f.installationId,s.f.connectionId,duplicate,runId,hash])
    expect(value(await snapshot(),'canonical_change','unfinished')).toBe(2)
    expect(value(await snapshot(),'observation','completed')).toBe(3)
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    expect(value(await snapshot(),'canonical_change','unfinished')).toBe(2)
    expect((await pool.query('SELECT DISTINCT run_id FROM memory_git_proposal_runs ORDER BY run_id')).rows.map(r=>r.run_id)).toEqual([runId,secondRun].sort())
  })
  test('late binding rolls back with the worker transaction; failed eligible work remains after purge',async()=>{
    const s=await gitImportFixture(pool),{runId}=await s.plan(s.bundle.files,null)
    const [second]=await s.service.plan(s.f.grant,{...s.request,headCommit:'e'.repeat(40)})
    const client=await pool.connect()
    try{await client.query('BEGIN');await bindAnother(s,runId,second.proposalId,'e'.repeat(40),client)
      expect((await client.query('SELECT count(*)::int n FROM memory_git_proposal_runs')).rows[0].n).toBe(2)
      await client.query('ROLLBACK')
    }finally{client.release()}
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_proposal_runs')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_run_receipts')).rows[0].n).toBe(1)
    await pool.query("UPDATE memory_git_run_receipts SET failures=2,state='dead',unfinished=true WHERE run_id=$1",[runId])
    await pool.query("UPDATE memory_git_runs SET failure_count=2,state='dead' WHERE run_id=$1",[runId])
    expect(value(await snapshot(),'canonical_change','failed')).toBe(1)
    await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
    expect(value(await snapshot(),'canonical_change','failed')).toBe(1)
    expect(value(await snapshot(),'observation','failed')).toBe(1)
  })
})
