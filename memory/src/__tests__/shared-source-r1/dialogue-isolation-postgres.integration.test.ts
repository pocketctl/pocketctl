import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {SharedSourceReader} from '@pocketctl/session-source'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'

const url=process.env.DIALOGUE_ISOLATION_TEST_DATABASE_URL
;(url?describe:describe.skip)('native failure isolation with real producer, worker and scoped roles',()=>{
  let f:DirectLaunchFixture
  beforeAll(async()=>{f=await directLaunchFixture(url!,{captureRelayControls:true,failureIsolation:true})},120000)
  afterAll(async()=>{await f?.close()})
  test('fences changed turns, accepts unrelated appends and probes isolated contention after restart', async()=>{
    const source=await f.source()
    const {inst}=await f.install(source,'retained_history'), install=inst.installation_id
    const otherSource=await f.source()
    const {inst:other}=await f.install(otherSource,'retained_history')
    await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[other.installation_id])
    await f.pool.query('INSERT INTO shared.memory_dialogue_installations(installation_id) VALUES($1) ON CONFLICT DO NOTHING',[other.installation_id])
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[install])
    await f.pool.query('INSERT INTO shared.memory_dialogue_installations(installation_id) VALUES($1) ON CONFLICT DO NOTHING',[install])
    const journal=(await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)).createPostgresExtensionJournalSink({sharedHeaders:true})
    async function emit(turn:string,type:string,fields:Record<string,unknown>,target=source){
      const eventId=randomUUID(),payload={type,turn_id:turn,event_id:eventId,actor_scope:'root',...fields}
      const e=(await f.publisher.query(`INSERT INTO public.events(session_id,user_id,event_type,payload,event_hash,effect_status)
        VALUES($1,$2,$3,$4,$5,'completed') RETURNING id::text`,[target.session,target.owner,type,payload,eventId.replaceAll('-','')])).rows[0]
      await journal.appendCanonicalEvent(f.publisher,{sourceEventId:e.id,ownerUserId:target.owner,sessionId:target.session,eventType:type,payload})
    }
    const dispatch=()=>f.runtime.query('SELECT shared.dispatch_turn_dialogues()')
    const close=async(turn:string,target=source)=>{
      await emit(turn,'user_text',{text:'I use the train for this trip.'},target)
      await emit(turn,'agent_text',{text:'Travel preference recorded.',message_phase:'final_answer'},target)
      await emit(turn,'turn_status',{turn_status:'completed'},target)
      await dispatch()
    }
    const receipts=async(turn:string,installationId=install)=>(await f.runtime.query(`SELECT status,reason,attempts,closed_at IS NOT NULL AS closed FROM memory_dialogue_compile_receipts
      WHERE installation_id=$1 AND turn_id=$2 ORDER BY generation`,[installationId,turn])).rows
    const jobs=createJobRepository(f.runtime,{nativeSourcesOnly:true})
    const worker=()=>{
      const queue=createJobWorker({pool:f.runtime,jobs,workerId:randomUUID(),signal:new AbortController().signal,claimLimit:1})
      queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
      return queue
    }
    const cleanTurn=randomUUID(),noisyTurn=randomUUID(),unchanged=randomUUID(),lockedTurn=randomUUID()
    // One corrupt legacy queue payload cannot roll back a later turn's
    // dispatch. The source-captured generation replaces that queue metadata.
    await f.runtime.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload,state)
      VALUES(gen_random_uuid(),$1,'compile_episode','dialogue:'||encode(sha256(convert_to(jsonb_build_array($2::text,$3::text)::text,'UTF8')),'hex'),
       80,jsonb_build_object('dialogue_session',$2::text,'turn',$3::text,'dialogue_generation','9223372036854775808'),'completed')`,[install,source.session,cleanTurn])
    await close(cleanTurn)
    const original=SharedSourceReader.prototype.resolveBodies
    let hook:undefined|(()=>Promise<void>)=async()=>{await emit(noisyTurn,'user_text',{text:'unrelated append'})}
    const read=vi.spyOn(SharedSourceReader.prototype,'resolveBodies').mockImplementation(async function(this:SharedSourceReader,...args){
      const mutate=hook;hook=undefined
      await mutate?.()
      return original.apply(this,args)
    })
    try{
      await worker().tick()
      expect(await receipts(cleanTurn)).toMatchObject([{status:'published',attempts:0}])
      await close(unchanged)
      hook=async()=>{await emit(unchanged,'tool_call',{tool:'lookup',call_meta:{tool_kind:'mcp'}})}
      await worker().tick()
      expect(await receipts(unchanged)).toMatchObject([{status:'superseded'}])
      await dispatch();await worker().tick()
      expect(await receipts(unchanged)).toMatchObject([{status:'superseded'},{status:'not_admitted',reason:'operational_turn'}])
    }finally{read.mockRestore()}
    await close(lockedTurn)
    const keeper=await f.pool.connect()
    try{
      await keeper.query('BEGIN')
      await keeper.query("SELECT pg_advisory_xact_lock(hashtextextended('turn-dialogue:'||$1::text||':'||$2||':'||$3,0))",[install,source.session,lockedTurn])
      for(let i=0;i<4;i++){
        await f.runtime.query("UPDATE memory_jobs SET available_at=now() WHERE installation_id=$1 AND payload->>'turn'=$2",[install,lockedTurn])
        await worker().tick()
      }
      expect(await receipts(lockedTurn)).toMatchObject([{status:'failed',reason:'lock_conflict',attempts:4,closed:true}])
      // Simulate thirteen due probe intervals with the same transaction still
      // holding the lock. Both independent inputs must finish during contention.
      const sibling=randomUUID(),otherTurn=randomUUID()
      await close(sibling);await close(otherTurn,otherSource)
      for(let probe=0;probe<13;probe++){
        await f.runtime.query('UPDATE memory_dialogue_compile_receipts SET next_probe_at=now() WHERE installation_id=$1 AND turn_id=$2',[install,lockedTurn])
        await dispatch()
        if(probe<2)await worker().tick()
      }
      expect(await receipts(sibling)).toMatchObject([{status:'published'}])
      expect(await receipts(otherTurn,other.installation_id)).toMatchObject([{status:'published'}])
      expect(await receipts(lockedTurn)).toMatchObject([{status:'failed',attempts:4}])
    }finally{await keeper.query('ROLLBACK');keeper.release()}
    await f.runtime.query('UPDATE memory_dialogue_compile_receipts SET next_probe_at=now() WHERE installation_id=$1 AND turn_id=$2',[install,lockedTurn])
    await close(randomUUID())
    await worker().tick();await worker().tick()
    expect(await receipts(lockedTurn)).toMatchObject([{status:'published',attempts:4}])
    expect((await f.runtime.query("SELECT COUNT(*)::int AS n FROM memory_dead_letters WHERE installation_id=$1",[install])).rows[0].n).toBe(0)
    // Pre-upgrade dead rows carry no generation. The explicit manifest must
    // match this exact failure (including its original JSON.stringify hash).
    const legacyTurn=randomUUID(),legacyJob=randomUUID()
    await emit(legacyTurn,'user_text',{text:'Compare heating costs.'})
    await emit(legacyTurn,'agent_text',{message_phase:'final_answer',text:'Here is the estimate.'})
    await emit(legacyTurn,'turn_status',{turn_status:'completed'})
    await f.pool.query('DELETE FROM shared.memory_dialogue_pending WHERE installation_id=$1 AND turn_id=$2',[install,legacyTurn])
    const dead=(await f.runtime.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,payload,state,
      attempts,claim_epoch,last_error_code,completed_at,priority) VALUES($1,$2,'compile_episode',
       'dialogue:'||encode(sha256(convert_to(jsonb_build_array($3::text,$4::text)::text,'UTF8')),'hex'),
       jsonb_build_object('dialogue_session',$3::text,'turn',$4::text),'dead',12,12,'postgres_error',now(),80)
       RETURNING payload`,[legacyJob,install,source.session,legacyTurn])).rows[0]
    const hash=createHash('sha256').update(JSON.stringify(dead.payload)).digest()
    await f.runtime.query(`INSERT INTO memory_dead_letters(job_id,installation_id,job_type,attempts,error_code,payload_hash,dead_at)
      SELECT job_id,installation_id,job_type,attempts,last_error_code,$2,completed_at FROM memory_jobs WHERE job_id=$1`,[legacyJob,hash])
    const {recoverLegacyDialogueJobs}=await import('../../episodes/legacy-dialogue-repair.js')
    const key={installationId:install,jobId:legacyJob}
    const plan=await recoverLegacyDialogueJobs(f.runtime,[key])
    expect(plan).toMatchObject([{state:'verified'}])
    const manifest=plan[0].manifest!
    expect(await recoverLegacyDialogueJobs(f.runtime,[{...manifest,attempts:11}],true)).toMatchObject([{state:'unverified'}])
    const legacyLock=await f.pool.connect()
    try{
      await legacyLock.query('BEGIN')
      await legacyLock.query("SELECT pg_advisory_xact_lock(hashtextextended('turn-dialogue:'||$1::text||':'||$2||':'||$3,0))",[install,source.session,legacyTurn])
      expect(await recoverLegacyDialogueJobs(f.runtime,[manifest,{...manifest,jobId:randomUUID()}],true))
        .toMatchObject([{state:'busy'},{state:'unverified'}])
    }finally{await legacyLock.query('ROLLBACK');legacyLock.release()}
    expect(await recoverLegacyDialogueJobs(f.runtime,[manifest],true)).toMatchObject([{state:'enrolled'}])
    expect(await recoverLegacyDialogueJobs(f.runtime,[manifest],true)).toMatchObject([{state:'already_enrolled'}])
    await worker().tick()
    expect(await receipts(legacyTurn)).toMatchObject([{status:'published'}])

  },60000)
  test('closes an exhausted native rebuild, waits for a dependency change and accepts its actual page receipt',async()=>{
    const src=await f.source(),{inst}=await f.install(src,'retained_history'),install=inst.installation_id
    await f.pool.query("UPDATE shared.memory_source_contract SET activation_ready=TRUE")
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[install])
    const repository=createJobRepository(f.runtime,{nativeSourcesOnly:true})
    await repository.enqueueJob({installationId:install,jobType:'rebuild_claim_index',idempotencyKey:'rebuild:stage-recovery',payload:{}})
    const id=(await f.runtime.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND job_type='rebuild_claim_index'",[install])).rows[0].job_id
    async function tick(fail:boolean){
      const queue=createJobWorker({pool:f.runtime,jobs:repository,workerId:randomUUID(),signal:new AbortController().signal,claimLimit:1})
      const {createClaimIndexer}=await import('../../retrieval/indexer.js')
      const index=createClaimIndexer({pool:f.runtime})
      queue.register('rebuild_claim_index',fail?async()=>{throw Error('synthetic processing fault')}:index.handleRebuildClaimIndex.bind(index))
      await queue.tick()
    }
    for(let n=0;n<4;n++){
      await f.runtime.query('UPDATE memory_jobs SET available_at=now() WHERE job_id=$1',[id]);await tick(true)
    }
    const disposition=async()=>(await f.runtime.query('SELECT status,attempts FROM memory_stage_dispositions WHERE job_id=$1',[id])).rows[0]
    expect(await disposition()).toMatchObject({status:'isolated',attempts:4})
    const {recoverDueStageJobs}=await import('../../jobs/stage-recovery.js')
    const due=async()=>{
      await f.runtime.query('UPDATE memory_stage_dispositions SET next_probe_at=now() WHERE job_id=$1',[id])
      return recoverDueStageJobs(f.runtime)
    }
    expect(await due()).toMatchObject({probed:1,queued:0})
    await f.runtime.query(`INSERT INTO memory_feature_settings(installation_id) VALUES($1) ON CONFLICT(installation_id) DO UPDATE SET revision=memory_feature_settings.revision+1`,[install])
    expect(await due()).toMatchObject({queued:1})
    await tick(false)
    expect((await f.runtime.query('SELECT dispatched_count FROM memory_index_rebuild_page_receipts WHERE job_id=$1',[id])).rows[0]).toEqual({dispatched_count:0})
    expect(await due()).toMatchObject({resolved:1})
    expect(await disposition()).toMatchObject({status:'resolved',attempts:4})
    expect((await f.runtime.query('SELECT 1 FROM memory_dead_letters WHERE job_id=$1',[id])).rowCount).toBe(0)
    const blockedKey='rebuild:stage-probe-lock'
    await repository.enqueueJob({installationId:install,jobType:'rebuild_claim_index',idempotencyKey:blockedKey,payload:{}})
    const blocked=(await f.runtime.query("SELECT job_id FROM memory_jobs WHERE installation_id=$1 AND idempotency_key=$2",[install,blockedKey])).rows[0].job_id
    const lock=await f.pool.connect()
    try{
      await lock.query('BEGIN')
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1::text,0))",[install])
      for(let n=0;n<4;n++){
        await f.runtime.query('UPDATE memory_jobs SET available_at=now() WHERE job_id=$1',[blocked]);await tick(true)
      }
      await f.runtime.query('UPDATE memory_stage_dispositions SET next_probe_at=now() WHERE job_id=$1',[blocked])
      expect(await recoverDueStageJobs(f.runtime)).toMatchObject({queued:0})
    }finally{await lock.query('ROLLBACK');lock.release()}
    await f.runtime.query('UPDATE memory_stage_dispositions SET next_probe_at=now() WHERE job_id=$1',[blocked])
    expect(await recoverDueStageJobs(f.runtime)).toMatchObject({queued:1})
    await tick(false)

  },30000)
  test('an unexpected consolidation error with a possibly sent window parks the original call',async()=>{
    const src=await f.source(),{inst}=await f.install(src,'retained_history'),install=inst.installation_id
    const bundle=randomUUID(),run=randomUUID(),jobId=randomUUID(),turn=randomUUID(),hash='a'.repeat(64)
    await f.pool.query("UPDATE shared.memory_source_contract SET activation_ready=TRUE")
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[install])
    await f.runtime.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark,dialogue_members)
      VALUES($1,$2,$3,$4,decode($5,'hex'),0,'[]')`,[install,bundle,'dialogue:'+turn,src.session,hash])
    await f.runtime.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
      VALUES($1,$2,'consolidate_task',$3,84,$4)`,[jobId,install,'consolidate:'+bundle+':1',{bundle_id:bundle,bundle_revision:1}])
    await f.runtime.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,
      policy_hash,model_config_hash,mode,state,claimed_by,checkpoint_protocol)
      VALUES($1,$2,$3,1,decode($4,'hex'),1,$4,$4,'enabled','provider_result_unknown',$5,1)`,[install,run,bundle,hash,jobId])
    await f.runtime.query("INSERT INTO memory_curation_calls(installation_id,run_id,window_index,input_digest,state) VALUES($1,$2,0,$3,'possible')",[install,run,hash])
    const repo=createJobRepository(f.runtime,{nativeSourcesOnly:true})
    const queue=createJobWorker({pool:f.runtime,jobs:repo,workerId:randomUUID(),signal:new AbortController().signal,claimLimit:1})
    queue.register('consolidate_task',async()=>{throw Error('fault after possibly sent call')})
    await queue.tick()
    const {rows:[r]}=await f.runtime.query(`SELECT j.state,d.status,d.reason,r.recovery_at IS NOT NULL AS original_run_queued
      FROM memory_jobs j JOIN memory_stage_dispositions d USING(job_id)
      JOIN memory_curation_runs r ON r.claimed_by=j.job_id::text WHERE j.job_id=$1`,[jobId])
    expect(r).toEqual({state:'completed',status:'isolated',reason:'external_result_unconfirmed',original_run_queued:true})
    await f.runtime.query('UPDATE memory_stage_dispositions SET next_probe_at=now() WHERE job_id=$1',[jobId])
    const {recoverDueStageJobs}=await import('../../jobs/stage-recovery.js')
    expect(await recoverDueStageJobs(f.runtime)).toMatchObject({queued:0})
    expect((await f.runtime.query('SELECT state FROM memory_curation_calls WHERE installation_id=$1 AND run_id=$2',[install,run])).rows).toEqual([{state:'possible'}])
  })
  test('reconciles an exact candidate decision and isolates a Team projection with no sealed target',async()=>{
    const source=await f.source(),{inst}=await f.install(source,'retained_history'),install=inst.installation_id
    await f.pool.query("UPDATE shared.memory_source_contract SET activation_ready=TRUE")
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[install])
    const bundle=randomUUID(),run=randomUUID(),candidate=randomUUID(),hash='b'.repeat(64)
    await f.runtime.query(`INSERT INTO memory_task_bundles(installation_id,bundle_id,task_key,session_id,source_digest,watermark,dialogue_members)
      VALUES($1,$2,$3,$4,decode($5,'hex'),0,'[]')`,[install,bundle,'dialogue:'+randomUUID(),source.session,hash])
    await f.runtime.query(`INSERT INTO memory_curation_runs(installation_id,run_id,bundle_id,bundle_revision,source_digest,policy_revision,
      policy_hash,model_config_hash,mode,state) VALUES($1,$2,$3,1,decode($4,'hex'),1,$4,$4,'enabled','completed')`,[install,run,bundle,hash])
    await f.runtime.query(`INSERT INTO memory_candidates(candidate_id,installation_id,ordinal,claim_type,statement,structured_content,normalized_key,
      scope_kind,scope_key,confidence,freshness_at,status,source_kind,bundle_id,curation_run_id,bundle_revision)
      VALUES($1,$2,1,'work_method','fixture','{}',$3,'task',$4::text,1,now(),'validated','task_bundle',$4::uuid,$5,1)`,
      [candidate,install,hash,bundle,run])
    await f.runtime.query(`INSERT INTO memory_curation_decisions(installation_id,run_id,candidate_id,action,idempotency_key,reason_code,state)
      VALUES($1,$2,$3,'skip',$4,'policy_skip','skipped')`,[install,run,candidate,'skip:'+candidate])
    const repo=createJobRepository(f.runtime,{nativeSourcesOnly:true}),candidateKey='curate:'+candidate
    await repo.enqueueJob({installationId:install,jobType:'curate_conclusions',idempotencyKey:candidateKey,payload:{candidate_id:candidate,bundle_id:bundle,run_id:run}})
    const queue=createJobWorker({pool:f.runtime,jobs:repo,workerId:randomUUID(),signal:new AbortController().signal,claimLimit:1})
    queue.register('curate_conclusions',async()=>{throw Error('lost candidate ACK')})
    await queue.tick()
    const read=async(type:string)=>(await f.runtime.query('SELECT status,attempts,reason FROM memory_stage_dispositions WHERE installation_id=$1 AND job_type=$2',[install,type])).rows[0]
    expect(await read('curate_conclusions')).toMatchObject({status:'resolved',attempts:1,reason:'business_receipt'})

    const scan=randomUUID(),cursor='team-fixture',teamKey='shared-source:'+scan+':'+createHash('sha256').update(cursor).digest('hex')
    await repo.enqueueJob({installationId:install,jobType:'project_shared_source',idempotencyKey:teamKey,payload:{
      root:{kind:'team_collaboration',key:randomUUID()},scope:{installationId:install},distribution_scan:scan,target_cursor:cursor}})
    const {createNativeTeamJobHandler}=await import('../../sources/team-semantic-job.js')
    queue.register('project_shared_source',createNativeTeamJobHandler(f.runtime,0),{branch:'canonical'})
    for(let i=0;i<4;i++){
      await f.runtime.query('UPDATE memory_jobs SET available_at=now() WHERE installation_id=$1 AND idempotency_key=$2',[install,teamKey])
      await queue.tick()
    }
    expect(await read('project_shared_source')).toMatchObject({status:'isolated',attempts:4})
    expect((await f.runtime.query('SELECT 1 FROM memory_team_semantic_publications WHERE installation_id=$1',[install])).rowCount).toBe(0)
  },30000)
})
