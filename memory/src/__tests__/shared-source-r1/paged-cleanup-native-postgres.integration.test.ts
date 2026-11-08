import {spawn} from 'node:child_process'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {beforeAll,afterAll,describe,test,expect,vi} from 'vitest'
import {createPagedFixture,pagedInstallation,pagedProbe} from './paged-cleanup-fixture.js'
import {pagedMaintenanceTestLifecycle} from './paged-cleanup-fixture.js'
const {planPagedCleanup,applyPagedCleanup,verifyPagedCleanup}=pagedMaintenanceTestLifecycle()
import {openPagedCleanupManifest,readPagedCleanupParts} from '../../migrations/shared-forward/paged-cleanup-manifest.js'
import {inspectPagedCleanupCatalog} from '../../migrations/shared-forward/paged-cleanup-catalog.js'
const url=process.env.SHARED_W4_PAGED_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('v4 actual native effects and bounded final barrier',()=>{
 let f:Awaited<ReturnType<typeof createPagedFixture>>,directory:string
 beforeAll(async()=>{f=await createPagedFixture(url!);directory=await mkdtemp(join(tmpdir(),'paged-native-'))},120000)
 afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true})})
 async function seedSettledSkill(session:string,count:number){
  const repository=randomUUID(),snapshot=randomUUID(),rows=Array.from({length:count},()=>({episode:randomUUID(),task:randomUUID(),run:randomUUID(),generation:randomUUID()}))
  await f.sql('INSERT INTO memory.repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,now(),now())',[pagedInstallation,repository])
  await f.sql("INSERT INTO memory.repo_snapshots(installation_id,repo_snapshot_id,repository_id,commit_sha,observed_at) VALUES($1,$2,$3,repeat('a',40),now())",[pagedInstallation,snapshot,repository])
  for(let i=0;i<rows.length;i+=128){const batch=JSON.stringify(rows.slice(i,i+128))
   await f.sql("INSERT INTO memory.work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,document,evidence_manifest,summary) SELECT $1,r.episode::uuid,$2,r.episode,'invalidated','fixture','{}','{}','{}' FROM jsonb_to_recordset($3::jsonb)r(episode text)",[pagedInstallation,session,batch])
   await f.sql("INSERT INTO memory.memory_generation_runs(run_id,installation_id,operation,subject_kind,subject_key_hash,input_digest,effective_policy_hash,state,provider,model,input_tokens,output_tokens,cost_micros,error_code) SELECT r.generation::uuid,$1,'extract_skill_candidate','episode',sha256(convert_to(r.episode,'UTF8')),decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'failed','text','synthetic',37,19,23,'provider_result_unknown' FROM jsonb_to_recordset($2::jsonb)r(generation text,episode text)",[pagedInstallation,batch])
   await f.sql("INSERT INTO memory.memory_skill_tasks(task_id,installation_id,repository_id,candidate_key,current_generation,state) SELECT r.task::uuid,$1,$2,r.task,1,'cancelled' FROM jsonb_to_recordset($3::jsonb)r(task text)",[pagedInstallation,repository,batch])
   await f.sql("INSERT INTO memory.memory_skill_task_runs(run_id,installation_id,task_id,generation,source_kind,repository_id,repo_snapshot_id,episode_id,source_digest,input_digest,policy_version,owner_scope_kind,authorization_epoch,grant_snapshot,state,generation_run_id,error_code) SELECT r.run::uuid,$1,r.task::uuid,1,'episode',$2,$3,r.episode::uuid,repeat('a',64),repeat('b',64),'fixture','personal',1,'{}','cancelled',r.generation::uuid,'provider_result_unknown' FROM jsonb_to_recordset($4::jsonb)r(run text,task text,episode text,generation text)",[pagedInstallation,repository,snapshot,batch])
  }
  return rows
 }
 test('already-staged >1024 independent fee-required Skill skeletons cause no final task churn',async()=>{
  const session='paged-native-skill-settled';await f.source(session,1)
  const rows=await seedSettledSkill(session,1030)
  const proof=(await f.sql("SELECT count(*)::int AS n,bool_and(e.state='invalidated' AND e.document='{}'::jsonb AND e.evidence_manifest='{}'::jsonb AND e.summary='{}'::jsonb AND t.state='cancelled' AND r.state='cancelled' AND g.error_code='provider_result_unknown' AND g.cost_micros=23) AS staged FROM memory.memory_skill_task_runs r JOIN memory.memory_skill_tasks t USING(installation_id,task_id) JOIN memory.work_episodes e USING(installation_id,episode_id) JOIN memory.memory_generation_runs g ON g.run_id=r.generation_run_id WHERE e.session_id=$1",[session])).rows[0]
  expect(proof).toEqual({n:1030,staged:true})
  const c=new pg.Client({connectionString:url});await c.connect()
  try{await c.query("BEGIN;SET LOCAL search_path=memory,pg_catalog;SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s';SET LOCAL jit=off")
   const baseline=(await c.query("SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int AS n FROM pg_stat_xact_user_tables WHERE schemaname='memory'")).rows[0].n
   await c.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'user_deleted',now())",[pagedInstallation,session])
   const affected=(await c.query("SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int AS n FROM pg_stat_xact_user_tables WHERE schemaname='memory'")).rows[0].n-baseline
   expect(affected).toBeLessThanOrEqual(1024)
   expect((await c.query("SELECT n_tup_upd::int AS n FROM pg_stat_xact_user_tables WHERE schemaname='memory' AND relname='memory_skill_tasks'")).rows[0].n).toBe(0)
  }finally{await c.query('ROLLBACK');await c.end()}
  const target=join(directory,'large-settled-skill-plan'),root={installationId:pagedInstallation,sessionId:session}
  const plan=await planPagedCleanup(f.config,[root],target,{probe:pagedProbe});expect(BigInt(plan.partCount)).toBeLessThan(100n)
  expect((await applyPagedCleanup(f.config,target,{probe:pagedProbe})).privacyCatchupReadyForReopen).toBe(true)
  expect((await f.sql('SELECT count(*)::int AS n FROM memory.memory_skill_task_runs r JOIN memory.work_episodes e USING(installation_id,episode_id) WHERE e.session_id=$1',[session])).rows[0].n).toBe(1030)
 },120000)
 test('v4 finalizes a retained original Skill fee component after native staging',async()=>{
  const session='paged-retained-skill';await f.source(session,1);const rows=await seedSettledSkill(session,1)
  const target=join(directory,'retained-skill-plan');await planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],target,{probe:pagedProbe})
  expect((await applyPagedCleanup(f.config,target,{probe:pagedProbe})).privacyCatchupReadyForReopen).toBe(true)
  expect((await f.sql('SELECT episode_id::text,generation_run_id::text FROM memory.memory_skill_task_runs WHERE run_id=$1',[rows[0].run])).rows[0]).toEqual({episode_id:rows[0].episode,generation_run_id:rows[0].generation})
  const opened=await openPagedCleanupManifest(target);let accountingBound=false
  for await(const page of readPagedCleanupParts(opened))for(const item of page.records)if(item.table==='memory_generation_runs'&&item.key.run_id===rows[0].generation){expect(item.references.accounting_hash).toMatch(/^[0-9a-f]{64}$/);accountingBound=true}
  expect(accountingBound).toBe(true)

  const outputs=(await f.sql("SELECT o FROM shared.memory_forward_cleanup_v4_receipts r CROSS JOIN LATERAL jsonb_array_elements(r.outputs) o WHERE o->>'kind'='native_governance' AND o->'actual'->'key'->>'sequence' IN(SELECT sequence::text FROM memory.memory_governance_migration_changes WHERE entity_kind='source_sessions' AND entity_id::jsonb->>'session_id'=$1)",[session])).rows
  expect(outputs.length).toBeGreaterThan(0)
  const sequence=outputs[0].o.actual.key.sequence
  await f.sql("UPDATE memory.memory_governance_migration_changes SET source_revision='unexpected' WHERE sequence=$1",[sequence])
  await expect(verifyPagedCleanup(f.config,target,{probe:pagedProbe})).rejects.toThrow('paged_native_output_drift')

 },120000)
 test('a native personal grant and active Skill job retain exact fees without paid replay',async()=>{
  const session='paged-active-skill-job';await f.source(session,1);const [row]=await seedSettledSkill(session,1)
  const grant={primaryInstallationId:pagedInstallation,configVersion:'1',scopeBindings:[{installation_id:pagedInstallation,owner_scope_kind:'personal',owner_scope_id:pagedInstallation,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','contribute']}]}
  await f.sql("UPDATE memory.memory_skill_task_runs SET state='running',error_code=NULL,grant_snapshot=$2::jsonb WHERE run_id=$1",[row.run,JSON.stringify(grant)])
  await f.sql("UPDATE memory.memory_generation_runs SET state='running',error_code=NULL WHERE run_id=$1",[row.generation])
  await f.sql("UPDATE memory.memory_skill_tasks SET state='running' WHERE task_id=$1",[row.task])
  const job=randomUUID();await f.sql("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,payload) VALUES($1,$2,'extract_skill_candidate',$3,jsonb_build_object('task_id',$4::text,'generation',1))",[job,pagedInstallation,session,row.task])
  const target=join(directory,'active-skill-job-plan');await planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],target,{probe:pagedProbe})
  expect((await applyPagedCleanup(f.config,target,{probe:pagedProbe})).privacyCatchupReadyForReopen).toBe(true)
  expect((await f.sql('SELECT state,grant_snapshot,generation_run_id::text,episode_id::text FROM memory.memory_skill_task_runs WHERE run_id=$1',[row.run])).rows[0]).toEqual({state:'cancelled',grant_snapshot:grant,generation_run_id:row.generation,episode_id:row.episode})
  expect((await f.sql('SELECT state,input_tokens::text,output_tokens::text,cost_micros::text FROM memory.memory_generation_runs WHERE run_id=$1',[row.generation])).rows[0]).toEqual({state:'cancelled',input_tokens:'37',output_tokens:'19',cost_micros:'23'})
  expect((await f.sql('SELECT state FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0].state).toBe('completed')
 },120000)
 test('unclassified grant body fields refuse without changing the original fee skeleton',async()=>{
  const session='paged-skill-grant-body';await f.source(session,1);const [row]=await seedSettledSkill(session,1)
  const grant={primaryInstallationId:pagedInstallation,configVersion:'1',scopeBindings:[],request:'unclassified private body'}
  await f.sql('UPDATE memory.memory_skill_task_runs SET grant_snapshot=$2::jsonb WHERE run_id=$1',[row.run,JSON.stringify(grant)])
  await expect(planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],join(directory,'skill-grant-body-plan'),{probe:pagedProbe})).rejects.toThrow('paged_skeleton_grant_unclassified')
  expect((await f.sql('SELECT grant_snapshot,generation_run_id::text,episode_id::text FROM memory.memory_skill_task_runs WHERE run_id=$1',[row.run])).rows[0]).toEqual({grant_snapshot:grant,generation_run_id:row.generation,episode_id:row.episode})
 })
 test('unclassified body fields in an otherwise linked native Skill job refuse',async()=>{
  const session='paged-skill-job-body';await f.source(session,1);const [row]=await seedSettledSkill(session,1)
  await f.sql("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,payload) VALUES(gen_random_uuid(),$1,'extract_skill_candidate',$2,jsonb_build_object('task_id',$3::text,'generation',1,'prompt','unclassified private body'))",[pagedInstallation,session,row.task])
  await expect(planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],join(directory,'skill-job-body-plan'),{probe:pagedProbe})).rejects.toThrow('paged_native_job_payload_unclassified')
  expect((await f.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[session])).rows[0].n).toBe(1)
 },120000)
 test.each(['header','access','owner','root-recreation'] as const)('native %s writer after the final page check is fenced through COMMIT',async mutation=>{
  const session='paged-final-'+mutation+'-fence';await f.source(session,1)
  const target=join(directory,'commit-'+mutation+'-plan');await planPagedCleanup(f.config,[{installationId:pagedInstallation,sessionId:session}],target,{probe:pagedProbe})
  const original=pg.Client.prototype.query;let wrote=false,attempted=false,writerCode:string|undefined
  const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]):any{
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text
   if(sql?.startsWith('DELETE FROM "source_events"'))wrote=true
   if(sql==='COMMIT'&&wrote&&!attempted){attempted=true;return(async()=>{
    const peer=new pg.Client({connectionString:url});await peer.connect()
    try{await Reflect.apply(original,peer,["SET lock_timeout='100ms';SET statement_timeout='1s'"])
     try{
      const statement=mutation==='header'?"UPDATE public.events SET canonical_payload_hash=repeat('f',64) WHERE session_id=$1":mutation==='access'?'DELETE FROM public.deleted_sessions WHERE session_id=$1':mutation==='owner'?'UPDATE public.sessions SET user_id=2 WHERE session_id=$1':"DELETE FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key='1:'||$1"
      await Reflect.apply(original,peer,[statement,[session]]);writerCode='committed'
     }catch(error){writerCode=(error as {code:string}).code}
    }finally{await peer.end()}
    return Reflect.apply(original,this,args)
   })()}
   return Reflect.apply(original,this,args)
  })
  let result:unknown,error:unknown
  try{result=await applyPagedCleanup(f.config,target,{probe:pagedProbe})}catch(cause){error=cause}finally{spy.mockRestore()}
  expect(attempted).toBe(true);expect(writerCode).toBe('55P03');expect(error).toBeUndefined();expect(result).toMatchObject({privacyCatchupReadyForReopen:true})
 },120000)
 test.each(['run','generation','job','current-generation'] as const)('native95 locks a cancelled task while its %s effect remains mutable',async effect=>{
  const session='paged-native-mutable-'+effect;await f.source(session,1);const [row]=await seedSettledSkill(session,1)
  if(effect==='run')await f.sql("UPDATE memory.memory_skill_task_runs SET state='running' WHERE run_id=$1",[row.run])
  if(effect==='generation')await f.sql("UPDATE memory.memory_generation_runs SET state='running' WHERE run_id=$1",[row.generation])
  if(effect==='current-generation')await f.sql("UPDATE memory.memory_skill_tasks SET state='candidate' WHERE task_id=$1",[row.task])
  const job=randomUUID()
  if(effect==='job')await f.sql("INSERT INTO memory.memory_jobs(job_id,installation_id,job_type,idempotency_key,payload,state) VALUES($1,$2,'extract_skill_candidate',$1::uuid::text,jsonb_build_object('task_id',$3::text,'generation','1'),'pending')",[job,pagedInstallation,row.task])
  const holder=new pg.Client({connectionString:url}),actor=new pg.Client({connectionString:url});await holder.connect();await actor.connect()
  try{
   await holder.query('BEGIN');await holder.query('SELECT 1 FROM memory.memory_skill_tasks WHERE task_id=$1 FOR UPDATE',[row.task])
   await actor.query("BEGIN;SET LOCAL search_path=memory,pg_catalog;SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s';SET LOCAL jit=off")
   await expect(actor.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'user_deleted',now())",[pagedInstallation,session])).rejects.toMatchObject({code:'55P03'})
   await actor.query('ROLLBACK');await holder.query('ROLLBACK')
   await actor.query("BEGIN;SET LOCAL search_path=memory,pg_catalog;SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s';SET LOCAL jit=off")
   await actor.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'user_deleted',now())",[pagedInstallation,session]);await actor.query('COMMIT')
   const states=(await f.sql("SELECT t.state AS task,r.state AS run,g.state AS generation,g.input_tokens,g.output_tokens,g.cost_micros FROM memory.memory_skill_tasks t JOIN memory.memory_skill_task_runs r USING(installation_id,task_id) JOIN memory.memory_generation_runs g ON g.run_id=r.generation_run_id WHERE t.task_id=$1",[row.task])).rows[0]
   expect(states.task).toBe('cancelled');expect(states.run).toBe('cancelled');expect(states.generation).toBe(effect==='generation'?'cancelled':'failed');expect([states.input_tokens,states.output_tokens,states.cost_micros]).toEqual(['37','19','23'])
   if(effect==='job')expect((await f.sql('SELECT state,claim_expires_at FROM memory.memory_jobs WHERE job_id=$1',[job])).rows[0]).toEqual({state:'completed',claim_expires_at:null})
   const before=(await f.sql('SELECT xmin::text FROM memory.memory_skill_tasks WHERE task_id=$1',[row.task])).rows[0].xmin
   await f.sql("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'user_deleted',now()) ON CONFLICT DO NOTHING",[pagedInstallation,session])
   expect((await f.sql('SELECT xmin::text FROM memory.memory_skill_tasks WHERE task_id=$1',[row.task])).rows[0].xmin).toBe(before)
  }finally{await holder.query('ROLLBACK');await actor.query('ROLLBACK');await holder.end();await actor.end()}
 },30000)
 test('native95 preserves a later task generation while cancelling an older source and deleting its archive',async()=>{
  const session='paged-native-old-generation';await f.source(session,1);const [row]=await seedSettledSkill(session,1),archive=randomUUID()
  await f.sql("UPDATE memory.work_episodes e SET state='ready',outcome='completed',repository_id=r.repository_id,repo_snapshot_id=r.repo_snapshot_id,source_digest=decode(r.source_digest,'hex'),evidence_manifest=jsonb_build_object('episode',jsonb_build_object('kind','episode','excerpt_hash',repeat('e',64),'excerpt_length',1)) FROM memory.memory_skill_task_runs r WHERE e.episode_id=$1 AND r.run_id=$2",[row.episode,row.run])
  const setup=new pg.Client({connectionString:url});await setup.connect();try{await setup.query('BEGIN')
  await setup.query("INSERT INTO memory.memory_skill_archives(archive_id,installation_id,repository_id,repo_snapshot_id,episode_id,task_id,generation,candidate_key,policy_version,source_digest,input_digest,content_hash,document_hash,document) SELECT $1,r.installation_id,r.repository_id,r.repo_snapshot_id,r.episode_id,r.task_id,r.generation,'fixture','fixture',r.source_digest,r.input_digest,repeat('c',64),repeat('d',64),jsonb_build_object('schema_version','skill-candidate.v1','source_tokens',jsonb_build_array('episode')) FROM memory.memory_skill_task_runs r WHERE r.run_id=$2",[archive,row.run])
  await setup.query("INSERT INTO memory.memory_skill_archive_sources(installation_id,archive_id,source_token,evidence_handle,excerpt_hash,evidence_kind) VALUES($1,$2,'episode','episode',repeat('e',64),'episode')",[pagedInstallation,archive]);await setup.query('COMMIT')}finally{await setup.query('ROLLBACK');await setup.end()}
  await f.sql("UPDATE memory.memory_skill_tasks SET current_generation=2,state='candidate' WHERE task_id=$1",[row.task]);await f.sql("UPDATE memory.memory_skill_task_runs SET state='running' WHERE run_id=$1",[row.run])
  const holder=new pg.Client({connectionString:url}),actor=new pg.Client({connectionString:url});await holder.connect();await actor.connect()
  try{await holder.query('BEGIN');await holder.query('SELECT 1 FROM memory.memory_skill_tasks WHERE task_id=$1 FOR UPDATE',[row.task]);await actor.query("BEGIN;SET LOCAL search_path=memory,pg_catalog;SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s'")
   await expect(actor.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'user_deleted',now())",[pagedInstallation,session])).rejects.toMatchObject({code:'55P03'});await actor.query('ROLLBACK');await holder.query('ROLLBACK')
   await f.sql("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'user_deleted',now())",[pagedInstallation,session])
   expect((await f.sql('SELECT 1 FROM memory.memory_skill_archives WHERE archive_id=$1',[archive])).rowCount).toBe(0)
   expect((await f.sql('SELECT current_generation::text,state FROM memory.memory_skill_tasks WHERE task_id=$1',[row.task])).rows[0]).toEqual({current_generation:'2',state:'candidate'})
   expect((await f.sql('SELECT state,generation_run_id::text FROM memory.memory_skill_task_runs WHERE run_id=$1',[row.run])).rows[0]).toEqual({state:'cancelled',generation_run_id:row.generation})
  }finally{await holder.query('ROLLBACK');await actor.query('ROLLBACK');await holder.end();await actor.end()}
 },30000)
 test('a native side effect cannot rewrite original fee or uncertain-provider accounting',async()=>{
  const session='paged-accounting-trigger';await f.source(session,1);const [row]=await seedSettledSkill(session,1)
  const body="BEGIN UPDATE memory.memory_generation_runs SET input_tokens=0,error_code=NULL WHERE run_id='"+row.generation+"'::uuid;RETURN NEW;END"
  await f.sql('CREATE FUNCTION memory.paged_fixture_accounting_mutation() RETURNS trigger LANGUAGE plpgsql AS $test$'+body+'$test$')
  await f.sql("CREATE TRIGGER paged_fixture_accounting_mutation AFTER UPDATE ON memory.work_episodes FOR EACH ROW WHEN(NEW.session_id='paged-accounting-trigger') EXECUTE FUNCTION memory.paged_fixture_accounting_mutation()")
  try{
   expect((await f.sql("SELECT prosrc FROM pg_proc WHERE oid='memory.paged_fixture_accounting_mutation()'::regprocedure")).rows[0].prosrc).toBe(body)
   const c=new pg.Client({connectionString:url});await c.connect();let reviewedCatalogHash:string
   try{await c.query('BEGIN READ ONLY;SET LOCAL search_path=pg_catalog');reviewedCatalogHash=(await inspectPagedCleanupCatalog(c)).hash}finally{await c.query('ROLLBACK');await c.end()}
   const config={...f.config,reviewedCatalogHash},target=join(directory,'accounting-trigger-plan'),root={installationId:pagedInstallation,sessionId:session}
   const header=await planPagedCleanup(config,[root],target,{probe:pagedProbe})
   await expect(applyPagedCleanup(config,target,{probe:pagedProbe})).rejects.toThrow('paged_accounting_invariant_drift')
   expect((await f.sql('SELECT input_tokens::text,error_code FROM memory.memory_generation_runs WHERE run_id=$1',[row.generation])).rows[0]).toEqual({input_tokens:'37',error_code:'provider_result_unknown'})
   expect((await f.sql('SELECT count(*)::int AS n FROM shared.memory_forward_cleanup_v4_receipts WHERE plan_hash=$1',[header.manifestHash])).rows[0].n).toBe(0)
  }finally{await f.sql('DROP TRIGGER paged_fixture_accounting_mutation ON memory.work_episodes;DROP FUNCTION memory.paged_fixture_accounting_mutation()')}
 },120000)
 test('the actual CLI SIGINT cancels a native delayed write and publishes no receipt',async()=>{
  const session='paged-cli-cancel';await f.source(session,1)
  const body='BEGIN PERFORM pg_sleep(3);RETURN OLD;END'
  await f.sql('CREATE FUNCTION memory.paged_fixture_cli_delay() RETURNS trigger LANGUAGE plpgsql AS $test$'+body+'$test$')
  await f.sql("CREATE TRIGGER paged_fixture_cli_delay BEFORE DELETE ON memory.source_events FOR EACH ROW WHEN(OLD.session_id='paged-cli-cancel') EXECUTE FUNCTION memory.paged_fixture_cli_delay()")
  const cliDir=join(directory,'cli'),bin=join(cliDir,'bin');await mkdir(bin,{recursive:true,mode:0o700})
  // Explicit synthetic systemd boundary; actual child process/SQL/cancellation
  // remain real. Root's separate runtime proof owns real systemd acceptance.
  await writeFile(join(bin,'systemctl'),"#!/bin/sh\nprintf '%s\n' 'LoadState=loaded' 'ActiveState=inactive' 'SubState=dead' 'MainPID=0'\n",{mode:0o700})
  const c=new pg.Client({connectionString:url});await c.connect();let reviewedCatalogHash:string
  try{await c.query('BEGIN READ ONLY;SET LOCAL search_path=pg_catalog');reviewedCatalogHash=(await inspectPagedCleanupCatalog(c)).hash}finally{await c.query('ROLLBACK');await c.end()}
  const {tombstoneHmacKeys,database,...rest}=f.config,configFile=join(cliDir,'config.json'),rootsFile=join(cliDir,'roots.json'),manifest=join(cliDir,'manifest'),output=join(cliDir,'interrupted')
  await writeFile(configFile,JSON.stringify({...rest,reviewedCatalogHash,database:{expected:database.expected}}),{mode:0o600})
  await writeFile(rootsFile,JSON.stringify([{installationId:pagedInstallation,sessionId:session}]),{mode:0o600})
  const run=(args:string[])=>{const child=spawn(process.execPath,['--import','tsx',resolve('src/migrations/shared-forward/source-maintenance-cli.ts'),'paged-cleanup',...args],{env:{...process.env,PATH:bin+':'+process.env.PATH,SHARED_MAINTENANCE_URL:url!,SHARED_MAINTENANCE_TOMBSTONE_KEYS:JSON.stringify(tombstoneHmacKeys)},stdio:['ignore','pipe','pipe']});let stderr='',stdout='';child.stderr.on('data',b=>{stderr+=b});child.stdout.on('data',b=>{stdout+=b});const done=new Promise<{code:number|null;stderr:string;stdout:string}>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,stderr,stdout}))});return {child,done}}
  let running:ReturnType<typeof run>|undefined
  const observerUrl=new URL(url!);observerUrl.pathname='/postgres';const observer=new pg.Client({connectionString:observerUrl.toString(),options:'-c default_transaction_read_only=on -c statement_timeout=1000'});await observer.connect()
  try{
   expect((await run(['plan','--config',configFile,'--roots',rootsFile,'--output',manifest]).done).code).toBe(0)
   const header=(await openPagedCleanupManifest(manifest)).header
   running=run(['apply','--config',configFile,'--manifest',manifest,'--output',output]);let pid:number|undefined
   const until=Date.now()+30000
   while(Date.now()<until){const active=(await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name='pocketctl-source-maintenance' AND state='active' AND query LIKE 'DELETE FROM \"source_events\"%'",[database.expected.database])).rows[0];if(active){pid=active.pid;break}await new Promise(resolve=>setTimeout(resolve,25))}
   expect(pid).toBeTypeOf('number');const stoppedAt=Date.now();running.child.kill('SIGINT');const result=await running.done
   expect(result.code).toBe(130);expect(result.stderr).toContain('interrupted');expect(Date.now()-stoppedAt).toBeLessThan(1800)
   expect((await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount).toBe(0)
   expect((await f.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[session])).rows[0].n).toBe(1)
   expect((await f.sql('SELECT count(*)::int AS n FROM shared.memory_forward_cleanup_v4_receipts WHERE plan_hash=$1',[header.manifestHash])).rows[0].n).toBe(0)
  }finally{running?.child.kill('SIGINT');await observer.end();await f.sql('DROP TRIGGER paged_fixture_cli_delay ON memory.source_events;DROP FUNCTION memory.paged_fixture_cli_delay()')}
 },60000)
 test('recognized edge written in a native subtransaction rolls back before page receipt',async()=>{
  const session='paged-subtransaction-source',outside='paged-subtransaction-outside';await f.source(session,1);await f.source(outside,1)
  // Explicit adversarial fixture catalog: this exact reviewed test trigger is
  // installed before planning and its function/trigger definition is asserted.
  // Production unknown DDL still fails against its independent catalog hash.
  const body="BEGIN BEGIN UPDATE memory.source_events SET source_provenance=jsonb_build_object('source_event_id',OLD.source_event_id::text) WHERE session_id='paged-subtransaction-outside'; EXCEPTION WHEN division_by_zero THEN NULL; END; RETURN OLD; END"
  await f.sql('CREATE FUNCTION memory.paged_fixture_subtransaction_edge() RETURNS trigger LANGUAGE plpgsql AS $test$'+body+'$test$')
  await f.sql("CREATE TRIGGER paged_fixture_subtransaction_edge AFTER DELETE ON memory.source_events FOR EACH ROW WHEN(OLD.session_id='paged-subtransaction-source') EXECUTE FUNCTION memory.paged_fixture_subtransaction_edge()")
  try{
   expect((await f.sql("SELECT prosrc FROM pg_proc WHERE oid='memory.paged_fixture_subtransaction_edge()'::regprocedure")).rows[0].prosrc).toBe(body)
   const c=new pg.Client({connectionString:url});await c.connect();let reviewedCatalogHash:string
   try{await c.query('BEGIN READ ONLY;SET LOCAL search_path=pg_catalog');reviewedCatalogHash=(await inspectPagedCleanupCatalog(c)).hash}finally{await c.query('ROLLBACK');await c.end()}
   const config={...f.config,reviewedCatalogHash},target=join(directory,'subtransaction-plan'),root={installationId:pagedInstallation,sessionId:session}
   const header=await planPagedCleanup(config,[root],target,{probe:pagedProbe})
   await expect(applyPagedCleanup(config,target,{probe:pagedProbe})).rejects.toThrow(/paged_(original_json_reference_drift|native_output_unbound)/)
   expect((await f.sql('SELECT count(*)::int AS n FROM memory.source_events WHERE session_id=$1',[session])).rows[0].n).toBe(1)
   expect((await f.sql('SELECT count(*)::int AS n FROM shared.memory_forward_cleanup_v4_receipts WHERE plan_hash=$1',[header.manifestHash])).rows[0].n).toBe(0)
  }finally{await f.sql('DROP TRIGGER paged_fixture_subtransaction_edge ON memory.source_events;DROP FUNCTION memory.paged_fixture_subtransaction_edge()')}
 },120000)
})
