import pg from 'pg'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {performance} from 'node:perf_hooks'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {createNativeInstallationDiscovery} from '../../installations/native-discovery.js'

const url=process.env.TASK15_DATABASE_URL,suite=url?describe:describe.skip
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>Promise<boolean>,timeout=8000){const start=performance.now();while(!await check()){if(performance.now()-start>timeout)throw Error('task15_condition_timeout');await pause(10)}}
/** Preserve both pg query completion protocols, including Pool.query's callback
 * checkout. Observation happens after real SQL completion, never fabricated rows. */
function observe(pool:pg.Pool,done:(sql:string,args:unknown[],result:pg.QueryResult)=>void,attempt?:(sql:string,args:unknown[])=>void){
 const connect=pool.connect.bind(pool),originals=new Map<pg.PoolClient,pg.PoolClient['query']>()
 const instrument=(client:pg.PoolClient)=>{
  if(originals.has(client))return client
  const original=client.query;originals.set(client,original)
  client.query=function(...args:any[]){
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[]
   attempt?.(sql,values)
   const last=args.length-1,callback=typeof args[last]==='function'?args[last]:undefined
   if(callback){args[last]=(error:unknown,result:pg.QueryResult)=>{if(!error)done(sql,values,result);callback(error,result)};return (original as any).apply(client,args)}
   const result=(original as any).apply(client,args)
   return result&&typeof result.then==='function'?result.then((value:pg.QueryResult)=>{done(sql,values,value);return value}):result
  } as any
  return client
 }
 pool.connect=((callback?:any)=>callback?connect((error,client,release)=>callback(error,client?instrument(client):client,release)):connect().then(instrument)) as any
 return ()=>{pool.connect=connect as any;for(const [client,query] of originals)client.query=query}
}
suite('Task15 default-start bounded metadata progress on native PostgreSQL',()=>{
 let projectionJobs:ReturnType<typeof createJobWorker>
 let f:DirectLaunchFixture,nativeSources:Awaited<ReturnType<DirectLaunchFixture['source']>>[]=[]
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  const {applyRelayControlCapture}=await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)
  await applyRelayControlCapture(f.pool)
  await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
  // Selected-source distribution now retains old pending projection seals.
  // Run the real fenced handlers during setup/drain; never mark jobs complete
  // or expire source leases to manufacture current-content readiness.
  projectionJobs=createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'task24-bounded-fixture',signal:new AbortController().signal})
  projectionJobs.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0}),{branch:'canonical'})
  projectionJobs.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
 },60000)
 afterAll(async()=>{await projectionJobs?.stop();await f?.close()})
 const pending=async()=>Number((await f.pool.query('SELECT (SELECT count(*) FROM shared.memory_source_control_work WHERE processed_revision<revision)+(SELECT count(*) FROM shared.memory_source_work WHERE processed_revision<revision) AS n')).rows[0].n)
 async function drain(){const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-drain',signal:new AbortController().signal});try{for(let n=0;n<512&&await pending();n++){await scheduler.runOnce();await projectionJobs.tick()}expect(await pending()).toBe(0)}finally{await scheduler.stop()}}
 test('default 1000ms start claims four eligible native roots within five seconds with real dispatch',async()=>{
  const sources:Awaited<ReturnType<DirectLaunchFixture['source']>>[]=[],installations:string[]=[]
  for(let n=0;n<4;n++)sources.push(await f.source())
  nativeSources=sources
  for(const source of sources)installations.push((await f.install(source,'retained_history')).inst.installation_id)
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  for(const installation of installations)await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation])
  const setup=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-setup',signal:new AbortController().signal})
  try{for(let n=0;n<256;n++){await setup.runOnce();await projectionJobs.tick();if(!(await f.pool.query('SELECT 1 FROM shared.memory_source_control_work WHERE processed_revision<revision UNION ALL SELECT 1 FROM shared.memory_source_work WHERE processed_revision<revision')).rowCount)break}}finally{await setup.stop()}
  const jobsBefore=(await f.pool.query("SELECT count(*)::int AS n FROM memory.memory_jobs WHERE job_type='project_shared_source'")).rows[0].n
  const committed=new Map<string,number>(),claims:{root:string;revision:string;ms:number}[]=[],errors:unknown[]=[]
  for(const source of sources){await f.event(source);await f.event(source,true);committed.set(f.root(source),performance.now())}
  const restore=observe(f.runtime,(sql,_args,result)=>{if(sql.includes('shared.claim_memory_source_work('))for(const row of result.rows)claims.push({root:row.root_key,revision:String(row.claimed_revision),ms:performance.now()})})
  const controller=new AbortController(),discovery=createNativeInstallationDiscovery({pool:f.runtime,signal:controller.signal})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-default',signal:controller.signal,refreshInstallations:()=>discovery.discoverOnce(),onError:e=>errors.push(e)})
  try{
   scheduler.start() // Deliberately omit intervalMs and pageSize.
   await until(async()=>sources.every(s=>claims.some(c=>c.root===f.root(s))),22000)
   const native=claims.filter(c=>committed.has(c.root)),delays=sources.map(s=>{const claim=native.find(c=>c.root===f.root(s));expect(claim).toBeDefined();return claim!.ms-committed.get(f.root(s))!}).sort((a,b)=>a-b)
   console.log(JSON.stringify({task15:'default-native',roots:sources.length,claimSamples:native.length,claims:native,eligibleToClaimMs:delays,p95Ms:delays[Math.ceil(delays.length*.95)-1]}))
   expect(native.length).toBeGreaterThanOrEqual(4);expect(delays[Math.ceil(delays.length*.95)-1]).toBeLessThanOrEqual(5000)
   await until(async()=>(await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_progress WHERE dispatched_revision>0')).rows[0].n===4,10000)
   await until(async()=>{await projectionJobs.tick();return (await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_work WHERE processed_revision<revision')).rows[0].n===0},15000)
   expect((await f.pool.query("SELECT count(*)::int AS n FROM memory.memory_jobs WHERE job_type='project_shared_source'")).rows[0].n).toBeGreaterThanOrEqual(jobsBefore+4)
   const nextClaims=claims.length
   for(const source of sources){await f.event(source);committed.set(f.root(source),performance.now())}
   await until(async()=>sources.every(source=>claims.slice(nextClaims).some(c=>c.root===f.root(source))))
   const revised=claims.slice(nextClaims).map(c=>c.ms-committed.get(c.root)!).sort((a,b)=>a-b)
   expect(revised).toHaveLength(4);expect(revised[3]).toBeLessThanOrEqual(5000)
   await until(async()=>{await projectionJobs.tick();return await pending()===0})
   console.log(JSON.stringify({task15:'native-r-plus-one',samples:revised.length,eligibleToClaimMs:revised,p95Ms:revised[3]}))
   expect(errors).toEqual([])
  }finally{console.log(JSON.stringify({task15:'final-observation',claims,errors:errors.map(String),work:(await f.pool.query('SELECT source_kind,root_key,revision::text,processed_revision::text,lease_owner,last_error_code FROM shared.memory_source_work')).rows}));await scheduler.stop();await discovery.stop();restore()}
 },35000)

 test('strictly bounded automatic bursts release transactions, preserve non-overlap, and default-yield after empty probe',async()=>{
  await drain()
  for(let n=0;n<36;n++)await f.pool.query("SELECT shared.mark_memory_source_dirty('legacy_archive',$1)",['task15-burst-'+n])
  const ackTimes:number[]=[],activationTimes:number[]=[],errors:unknown[]=[]
  let transactions=0,maxTransactions=0
  // The scheduler's metadata transactions are sequential even when start and
  // runOnce are called concurrently; all use the real physical pool (max 5).
  const restore=observe(f.runtime,(sql)=>{
   if(sql==='BEGIN'){transactions++;maxTransactions=Math.max(maxTransactions,transactions)}
   if(sql==='COMMIT'||sql==='ROLLBACK')transactions--
   if(sql.includes('shared.ack_memory_source_work('))ackTimes.push(performance.now())
   if(sql.includes('SELECT activation_ready'))activationTimes.push(performance.now())
  })
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-burst',signal:new AbortController().signal,onError:e=>errors.push(e)})
  try{
   scheduler.start();scheduler.start()
   await Promise.all([scheduler.runOnce(),scheduler.runOnce()])
   await until(async()=>ackTimes.length===36,12000)
   expect(maxTransactions).toBe(1);expect(transactions).toBe(0);expect(errors).toEqual([])
   const groups:number[][]=[]
   for(const time of ackTimes){if(!groups.length||time-groups.at(-1)!.at(-1)!>=900)groups.push([]);groups.at(-1)!.push(time)}
   // One explicit runOnce above can precede the automatic 16-round burst.
   expect(groups[0].length).toBeLessThanOrEqual(17)
   for(const group of groups.slice(1))expect(group.length).toBeLessThanOrEqual(16)
   expect(groups.length).toBeGreaterThanOrEqual(3)
   await pause(50);const idle=activationTimes.length
   await pause(250);expect(activationTimes.length).toBe(idle)
   console.log(JSON.stringify({task15:'finite-burst',acks:ackTimes.length,groupSizes:groups.map(g=>g.length),maxTransactions,emptyProbeIdleQueries:activationTimes.length-idle}))
  }finally{await scheduler.stop();restore()}
 },20000)
 test.each(['inactive','empty','error'])('%s keeps the actual default idle/error cadence',async mode=>{
  await drain();if(mode==='inactive')await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=FALSE')
  let contracts=0,withdrawals=0
  const errors:unknown[]=[],restore=observe(f.runtime,sql=>{if(sql.includes('SELECT activation_ready'))contracts++})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-idle-'+mode,signal:new AbortController().signal,refreshWithdrawals:async()=>{withdrawals++;if(mode==='error')throw Error('task15-withdrawal-failure')},onError:e=>errors.push(e)})
  try{
   scheduler.start();await until(async()=>contracts===1)
   await pause(250);expect(contracts).toBe(1)
   await pause(850);expect(contracts).toBe(2)
   expect(errors.length).toBe(mode==='error'?2:0);expect(withdrawals).toBe(mode==='inactive'?0:2)
   console.log(JSON.stringify({task15:'idle-yield',mode,contracts,errors:errors.length}))
  }finally{await scheduler.stop();restore();await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')}
 })
 test('sustained real 55P03 retains the cached lease and backs off instead of chaining claims',async()=>{
  await drain();const root=f.root(nativeSources[0]),locker=await f.pool.connect(),errors:unknown[]=[]
  await f.event(nativeSources[0])
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-busy',signal:new AbortController().signal,pageSize:1,onError:e=>errors.push(e)})
  let leaseChecks=0,claims=0;const checkedTokens:string[]=[],checkedAt:number[]=[]
  // Either first-use recovery or strict renewal crosses the same actual
  // FOR UPDATE NOWAIT lease gate. A known receipt can omit only the former.
  const restore=observe(f.runtime,()=>{},(sql,args)=>{if(sql.includes('shared.resume_memory_source_distribution(')&&sql.includes('NULL) AS recovery')||sql.includes('shared.renew_memory_source_lease(')){leaseChecks++;checkedTokens.push(String(args[2]));checkedAt.push(performance.now())}if(sql.includes('shared.claim_memory_source_work('))claims++})
  try{
   await scheduler.runOnce()
   const lease=(await f.pool.query('SELECT lease_token::text,attempt FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]
   expect(lease.attempt).toBe(1)
   await locker.query('BEGIN');await locker.query('SELECT 1 FROM shared.memory_source_work WHERE root_key=$1 FOR UPDATE',[root])
   const beforeChecks=leaseChecks,beforeClaims=claims
   scheduler.start();await until(async()=>leaseChecks===beforeChecks+1)
   await pause(1300)
   expect(leaseChecks).toBe(beforeChecks+2);expect(claims-beforeClaims).toBeLessThanOrEqual(2);expect(checkedTokens.slice(beforeChecks)).toEqual([lease.lease_token,lease.lease_token]);expect(checkedAt[beforeChecks+1]-checkedAt[beforeChecks]).toBeGreaterThanOrEqual(1000)
   expect((await f.pool.query('SELECT lease_token::text,attempt FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]).toEqual(lease)
   await locker.query('COMMIT')
   await until(async()=>{await projectionJobs.tick();return await pending()===0},8000)
   expect(errors).toEqual([])
   console.log(JSON.stringify({task15:'typed-busy',leaseChecks,claims,retainedToken:lease.lease_token!==null}))
  }finally{await locker.query('ROLLBACK');locker.release();await scheduler.stop();restore();await f.pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key=$1 AND lease_token IS NOT NULL",[root]);await drain()}
 },15000)
 test('busy control wins over successful source progress and forces default continuation backoff',async()=>{
  await drain()
  await f.pool.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
  for(let n=0;n<4;n++)await f.pool.query("SELECT shared.mark_memory_source_dirty('legacy_archive',$1)",['task15-control-busy-'+n])
  const locker=await f.pool.connect(),errors:unknown[]=[]
  let renewals=0,progress=0
  const restore=observe(f.runtime,sql=>{if(sql.includes('shared.ack_memory_source_work(')||sql.includes('shared.step_memory_source_distribution('))progress++},sql=>{if(sql.includes('shared.renew_memory_control_lease('))renewals++})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-control-busy',signal:new AbortController().signal,pageSize:1,onError:e=>errors.push(e)})
  try{
   await scheduler.runOnce()
   const lease=(await f.pool.query("SELECT lease_token::text FROM shared.memory_source_control_work WHERE control_kind='provider' AND control_key='pocketctl-memory'")).rows[0].lease_token
   expect(lease).not.toBeNull()
   await locker.query('BEGIN');await locker.query("SELECT 1 FROM shared.memory_source_control_work WHERE control_kind='provider' AND control_key='pocketctl-memory' FOR UPDATE")
   const before=renewals,priorProgress=progress;scheduler.start()
   await until(async()=>renewals>before);await pause(250)
   expect(renewals).toBe(before+1);expect(progress).toBeGreaterThan(priorProgress)
   await pause(850);expect(renewals).toBe(before+2);expect(errors).toEqual([])
   console.log(JSON.stringify({task15:'control-busy-wins',busyRenewals:renewals-before,sourceProgress:progress-priorProgress}))
   await locker.query('COMMIT')
   await until(async()=>{await projectionJobs.tick();return await pending()===0})
  }finally{await locker.query('ROLLBACK');locker.release();await scheduler.stop();restore();await f.pool.query("UPDATE shared.memory_source_control_work SET lease_until=clock_timestamp()-interval '1 second' WHERE lease_token IS NOT NULL");await f.pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE lease_token IS NOT NULL");await drain()}
 })
 test.each(['expired','stolen'])('automatic continuation refuses a genuinely %s token; only an ordinary expired reclaim admits later pages',async mode=>{
  await drain();const root=f.root(nativeSources[0]);await f.event(nativeSources[0])
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-'+mode,signal:new AbortController().signal,pageSize:1})
  let pages=0;const pageTokens:string[]=[],claimedTokens:string[]=[]
  const restore=observe(f.runtime,(sql,args,result)=>{if(sql.includes('shared.step_memory_source_distribution(')||sql.includes('shared.dispatch_memory_source_distribution(')){pages++;pageTokens.push(String(args[2]))}if(sql.includes('shared.claim_memory_source_work('))for(const row of result.rows)claimedTokens.push(row.lease_token)})
  try{
   await scheduler.runOnce();expect(pages).toBe(1);const oldToken=pageTokens[0]
   await f.pool.query(mode==='expired'?"UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key=$1":"UPDATE shared.memory_source_work SET lease_owner='task15-replacement',lease_token=gen_random_uuid() WHERE root_key=$1 AND lease_token IS NOT NULL",[root])
   scheduler.start();await pause(250);expect(pageTokens.filter(token=>token===oldToken)).toHaveLength(1);if(mode==='stolen')expect(pages).toBe(1);else{expect(pages).toBeGreaterThan(1);expect(pageTokens.slice(1).every(token=>token!==oldToken&&claimedTokens.includes(token))).toBe(true)}
   const row=(await f.pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]
   if(mode==='stolen')expect(BigInt(row.processed_revision)).toBeLessThan(BigInt(row.revision));else expect(BigInt(row.processed_revision)).toBeLessThanOrEqual(BigInt(row.revision))
  }finally{await scheduler.stop();restore();await f.pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key=$1 AND lease_token IS NOT NULL",[root]);await drain()}
 })
 test('abort between renewal and the next page closes admission while stop drains the current transaction',async()=>{
  await drain();const root=f.root(nativeSources[0]);await f.event(nativeSources[0])
  const controller=new AbortController(),afterAbort:string[]=[],errors:unknown[]=[]
  let aborted=false
  const restore=observe(f.runtime,sql=>{if(sql.includes('shared.renew_memory_source_lease(')){aborted=true;controller.abort()}},sql=>{if(aborted)afterAbort.push(sql)})
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-abort',signal:controller.signal,onError:e=>errors.push(e)})
  try{
   scheduler.start();await until(async()=>aborted);await scheduler.stop()
   expect(afterAbort).toEqual(['COMMIT']);expect(errors).toEqual([])
   const count=afterAbort.length;await pause(150);expect(afterAbort.length).toBe(count)
   expect((await f.pool.query('SELECT processed_revision<revision AS pending FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0].pending).toBe(true)
   console.log(JSON.stringify({task15:'abort-stop',afterAbort,errors:errors.length}))
  }finally{await scheduler.stop();restore();await f.pool.query("UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key=$1 AND lease_token IS NOT NULL",[root]);await drain()}
 })
 test('control pages progress first through a large native-root scan; durable source resume and r+1 catch up',async()=>{
  await drain();const source=nativeSources[0]
  for(let n=0;n<20;n++){const extra={...source,session:source.session+'-paged-'+n};await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[extra.session,extra.daemon,extra.owner]);await f.event(extra)}
  await drain();await f.event(source)
  const root=f.root(source),errors:unknown[]=[],operations:string[]=[],resets:boolean[]=[]
  const restore=observe(f.runtime,(sql,_args,result)=>{
   if(sql.includes('shared.step_memory_control_bootstrap('))operations.push('control')
   if(sql.includes('shared.step_memory_source_distribution(')){operations.push('source');resets.push(Boolean(result.rows[0].result.reset))}
  })
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task15-paged',signal:new AbortController().signal,pageSize:1,onError:e=>errors.push(e)})
  try{
   await scheduler.runOnce();await scheduler.runOnce()
   const checkpoint=(await f.pool.query('SELECT scan_id,cursor_key,state FROM shared.memory_source_distributions WHERE root_key=$1',[root])).rows[0]
   expect(checkpoint.state).toBe('scanning');expect(checkpoint.cursor_key).not.toBe('')
   await f.event(source)
   await f.pool.query("SELECT shared.mark_memory_control_dirty('provider','pocketctl-memory')")
   const boundary=operations.length;scheduler.start()
   await until(async()=>{await projectionJobs.tick();return await pending()===0},25000)
   expect(operations[boundary]).toBe('control');expect(resets.some(Boolean)).toBe(true)
   const state=(await f.pool.query('SELECT revision::text,processed_revision::text,lease_token FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]
   expect(state.processed_revision).toBe(state.revision);expect(state.lease_token).toBeNull()
   expect((await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_progress WHERE root_key=$1',[root])).rows[0].n).toBe(1)
   expect(errors).toEqual([]);expect(operations.filter(o=>o==='control').length).toBeGreaterThan(16)
   console.log(JSON.stringify({task15:'paged-control-r-plus-one',sourcePages:operations.filter(o=>o==='source').length,controlPages:operations.filter(o=>o==='control').length,resets:resets.filter(Boolean).length,nativeRoots:24,sourceTargets:1}))
  }finally{await scheduler.stop();restore()}
 },35000)
})
