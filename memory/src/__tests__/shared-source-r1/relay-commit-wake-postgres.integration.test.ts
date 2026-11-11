import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {setTimeout as delay} from 'node:timers/promises'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createRelayCommitWakeListener} from '../../sources/relay-commit-wake.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
const url=process.env.TASK21_DATABASE_URL,suite=url?describe:describe.skip
async function until(check:()=>Promise<boolean>,ms:number){const end=performance.now()+ms;while(!await check()){if(performance.now()>=end)throw Error('relay_commit_wake_fixture_deadline');await delay(10)}}
suite('existing Relay notification is a hint after actual PostgreSQL COMMIT',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 afterAll(async()=>{await f?.close()})
 test('uncommitted and rolled-back pulses never wake; committed duplicate pulse wakes once; stop closes subscription',async()=>{
  const wakes:number[]=[],errors:unknown[]=[],listener=createRelayCommitWakeListener({pool:f.runtime,signal:new AbortController().signal,wake:()=>wakes.push(performance.now()),onError:e=>errors.push(e)}),writer=await f.publisher.connect()
  try{
   await listener.start();wakes.length=0
   await writer.query('BEGIN');await writer.query("SELECT pg_notify('pocketctl_realtime','ignored-not-authority')");await delay(50);expect(wakes).toEqual([]);await writer.query('ROLLBACK');await delay(50);expect(wakes).toEqual([])
   await writer.query('BEGIN');for(let n=0;n<3;n++)await writer.query("SELECT pg_notify('pocketctl_realtime','ignored-not-authority')");await delay(50);expect(wakes).toEqual([]);await writer.query('COMMIT');await until(async()=>wakes.length===1,1000)
   await writer.query("SELECT pg_notify('foreign_channel','ignored')");await delay(50);expect(wakes).toHaveLength(1)
   await listener.stop();await writer.query("SELECT pg_notify('pocketctl_realtime','late')");await delay(50);expect(wakes).toHaveLength(1);expect(errors).toEqual([]);expect(f.runtime.totalCount).toBeLessThanOrEqual(5)
  }finally{await writer.query('ROLLBACK').catch(()=>undefined);writer.release();await listener.stop()}
 })
 test('a destroyed real listener reconnects once inside the same existing pool',async()=>{
  const wakes:number[]=[],errors:unknown[]=[],listener=createRelayCommitWakeListener({pool:f.runtime,signal:new AbortController().signal,wake:()=>wakes.push(performance.now()),onError:e=>errors.push(e)})
  const backends=async()=>(await f.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename='direct_launch_memory' AND query='LISTEN pocketctl_realtime'")).rows
  try{
   await listener.start();const before=await backends();expect(before).toHaveLength(1);await f.pool.query('SELECT pg_terminate_backend($1)',[before[0].pid]);await until(async()=>{const now=await backends();return now.length===1&&now[0].pid!==before[0].pid},3500)
   const n=wakes.length;await f.publisher.query("SELECT pg_notify('pocketctl_realtime','ignored')");await until(async()=>wakes.length===n+1,1000);expect(errors).toHaveLength(1);expect(f.runtime.totalCount).toBeLessThanOrEqual(5)
  }finally{await listener.stop()}
 })
 test('existing committed hint wakes fresh original SQL work before the periodic fallback',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source),signal=new AbortController().signal,errors:unknown[]=[]
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'relay-hint-jobs',signal,onError:e=>errors.push(e)})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'relay-hint-source',signal,listenForRelay:true,onDispatch:()=>queue.wake(),onError:e=>errors.push(e)})
  queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0,onReady:r=>scheduler.wake(r)}),{branch:'canonical'})
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  await f.event(source);await f.event(source,true)
  queue.start();scheduler.start()
  try{
   await until(async()=>(await f.pool.query(`SELECT processed_revision>=revision AND lease_token IS NULL
    AND(SELECT count(*) FROM memory.source_events WHERE installation_id=$2)=2
    AND(SELECT count(*) FROM memory.work_episodes WHERE installation_id=$2 AND state='ready')=1 AS done FROM shared.memory_source_work WHERE root_key=$1`,[root,installation])).rows[0]?.done===true,10000)
   await delay(50)
   const next={...source,session:source.session+'-notified'}
   await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[next.session,source.daemon,source.owner])
   const nextRoot=f.root(next),id=await f.event(next),revision=(await f.pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[nextRoot])).rows[0].revision,began=performance.now()
   // The native event/journal is already committed. This component uses the
   // existing channel directly; the four-process A21 proves its Relay producer.
   await f.publisher.query("SELECT pg_notify('pocketctl_realtime','ignored')")
   await until(async()=>{const w=(await f.pool.query('SELECT processed_revision::text,claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[nextRoot])).rows[0];return BigInt(w.processed_revision)>=BigInt(revision)||w.claimed_revision!==null&&BigInt(w.claimed_revision)>=BigInt(revision)},750)
   expect(performance.now()-began).toBeLessThan(750)
   await until(async()=>(await f.runtime.query('SELECT 1 FROM source_events WHERE installation_id=$1 AND canonical_key=$2',[installation,id])).rowCount===1,10000)
   expect(errors).toEqual([]);expect(f.runtime.totalCount).toBeLessThanOrEqual(5)
  }finally{await scheduler.stop({releaseOwnedClaims:true});await queue.stop()}
 },25000)
})
