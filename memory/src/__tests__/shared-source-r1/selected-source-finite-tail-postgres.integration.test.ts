import {setTimeout as delay} from 'node:timers/promises'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {observeProjectionCommits} from './helpers/projection-commit-observer.js'
const url=process.env.TASK21_DATABASE_URL,suite=url?describe:describe.skip
suite('finite tail metadata wave actual native publication',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 afterAll(async()=>{await f?.close()})
 test('numeric finite waves survive claims beyond 128 rows and rescan a late smaller ID',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const ids:string[]=[]
  for(const id of [2,9,10,64,100]){await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),$1,FALSE)",[id]);ids.push(await f.event(source))}
  for(let n=0;n<129;n++)ids.push(await f.event(source))
  const upper=ids.at(-1)!,signal=new AbortController().signal,errors:unknown[]=[],waves:any[]=[]
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'wave-scheduler',signal,onError:e=>errors.push(e)})
  const queue=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'wave-worker',signal,onError:e=>errors.push(e)})
  const project=createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0});let late=false,tailLate=false,afterTailLate=false;const tails:any[]=[]
  queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
  let workBefore:any
  const closeObserver=observeProjectionCommits(f.runtime,async event=>{
   if(event.installationId!==installation||event.rootKey!==f.root(source))return
   const before=event.before?.source_version?.metadataWave,p=event.after
   waves.push(structuredClone(p))
   if(before?.phase==='restart'&&before.after!==undefined){
    tails.push({before,after:structuredClone(p)});expect(p.state).toBe('scanning');expect(p.source_version.metadataWave.phase).toBe('restart')
    expect((await f.pool.query('SELECT processed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[f.root(source)])).rows[0]).toEqual(workBefore)
    const next=p.source_version.metadataWave
    if(next.after!==undefined&&!tailLate){await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),4,FALSE)");ids.push(await f.event(source));await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),$1,TRUE)",[next.through]);ids.push(await f.event(source));tailLate=true}
    if(next.after===undefined&&!afterTailLate){const maximum=ids.filter(x=>BigInt(x)>100n).reduce((a,b)=>BigInt(a)>BigInt(b)?a:b);await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),5,FALSE)");ids.push(await f.event(source));await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),$1,TRUE)",[maximum]);afterTailLate=true}
   }
   if(!late){
    expect(p.state).toBe('scanning');expect(p.source_version.metadataWave.through).toBe(upper);expect(BigInt(p.source_version.metadataWave.after)).toBeGreaterThan(100n)
    await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),3,FALSE)");ids.push(await f.event(source))
    await f.pool.query("SELECT setval(pg_get_serial_sequence('public.events','id'),$1,TRUE)",[upper]);for(let n=0;n<140;n++)ids.push(await f.event(source));late=true
   }
  },errors)
  queue.register('project_shared_source',async(...args)=>{
   if(args[0].installation_id===installation)workBefore=(await f.pool.query('SELECT processed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[f.root(source)])).rows[0]
   await project(...args)
  },{branch:'canonical'})
  try{
   for(let n=0;n<250;n++){
    await scheduler.runOnce();await queue.tick();if(errors.length)throw errors[0]
    const progress=(await f.runtime.query('SELECT state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND root_key=$2',[installation,f.root(source)])).rows[0]
    const count=(await f.runtime.query('SELECT count(*)::int AS count FROM source_events WHERE installation_id=$1',[installation])).rows[0].count
    if(progress?.state==='ready'&&count===ids.length)break
    if(n===249)throw Error('wave_drain_timeout');await delay(100)
   }
   expect(late).toBe(true);expect(tailLate).toBe(true);expect(afterTailLate).toBe(true);expect(tails.length).toBeGreaterThanOrEqual(3);const frozen=tails[0].after.source_version.metadataWave.through;expect(tails.slice(1).every(t=>t.before.through===frozen)).toBe(true)
   const first=waves.filter(p=>p.source_version.metadataWave?.through===upper).map(p=>p.source_version.metadataWave)
   expect(first.length).toBeGreaterThanOrEqual(3)
   expect(first.some(w=>w.phase==='scanning'&&BigInt(w.after)>200n)).toBe(true)
   const refs=(await f.runtime.query('SELECT canonical_key,payload FROM source_events WHERE installation_id=$1 ORDER BY canonical_key::bigint',[installation])).rows
   expect(refs.map(r=>r.canonical_key)).toEqual(ids.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1));expect(refs.every(r=>r.payload===null)).toBe(true)
   expect(refs.slice(0,8).map(r=>r.canonical_key)).toEqual(['2','3','4','5','9','10','64','100']);expect(errors).toEqual([])
  }finally{await closeObserver();await scheduler.stop();await queue.stop()}
 },40000)
})
