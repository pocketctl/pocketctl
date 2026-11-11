import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {claimSourceWork} from '../../sources/shared-work.js'
import {stepSourceDistribution,recoverSourceDistributionClaim} from '../../sources/source-distribution.js'
import {randomUUID} from 'node:crypto'
const url=process.env.TASK21_DATABASE_URL,suite=url?describe:describe.skip
suite('Task21 native claim progress preserves immutable selected scope seals',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 afterAll(async()=>{await f?.close()})
 test('waiting advances the exact live claim to a native durable revision without rewriting its old seal',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task21-seal',signal:new AbortController().signal,onError:e=>errors.push(e)})
  try{for(let n=0;n<64;n++){await scheduler.runOnce();if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root])).rowCount)break;if(n===63)throw Error('task21_seal_missing')}}finally{await scheduler.stop()}
  expect(errors).toEqual([])
  const readSeal=async()=>({distribution:(await f.pool.query('SELECT to_jsonb(d) AS row FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0].row,targets:(await f.pool.query('SELECT to_jsonb(t) AS row FROM shared.memory_source_distribution_targets t JOIN shared.memory_source_distributions d USING(scan_id) WHERE d.root_key=$1 ORDER BY t.cursor_key',[root])).rows.map(r=>r.row)})
  const seal=await readSeal();expect(seal.distribution.dispatch_complete).toBe(true)
  expect((await f.pool.query("SELECT count(*)::int AS n FROM memory.memory_jobs WHERE job_type='project_shared_source' AND payload->>'distribution_scan'=$1 AND state='pending'",[seal.distribution.scan_id])).rows[0].n).toBeGreaterThan(0)
  await f.event(source);const claim=(await claimSourceWork(f.runtime,'task21-waiting',30,1))[0];expect(claim.rootKey).toBe(root)
  await f.event(source,true)
  const before=(await f.pool.query('SELECT to_jsonb(w) AS row FROM shared.memory_source_work w WHERE root_key=$1',[root])).rows[0].row
  expect(BigInt(before.revision)).toBeGreaterThan(BigInt(claim.claimedRevision))
  const result=await stepSourceDistribution(f.runtime,claim)
  expect(result).toMatchObject({waiting:true,scanId:seal.distribution.scan_id,workRevision:String(seal.distribution.work_revision),claimedRevision:String(before.revision)})
  const after=(await f.pool.query('SELECT to_jsonb(w) AS row FROM shared.memory_source_work w WHERE root_key=$1',[root])).rows[0].row
  expect(after).toEqual({...before,claimed_revision:before.revision});expect(await readSeal()).toEqual(seal)
  // Non-NULL ordinary resume remains exact. NULL is explicit read-only
  // same-token recovery after a successful COMMIT whose reply was lost.
  const args=[claim.kind,claim.rootKey,claim.token,claim.workerId]
  await expect(f.runtime.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,$5)',[...args,claim.claimedRevision])).rejects.toThrow('source_lease_lost')
  const recovered=(await f.runtime.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,NULL) AS result',args)).rows[0].result
  expect(recovered).toEqual({claimedRevision:String(before.revision)})
  expect((await f.pool.query('SELECT to_jsonb(w) AS row FROM shared.memory_source_work w WHERE root_key=$1',[root])).rows[0].row).toEqual(after)
  await expect(f.runtime.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,NULL)',[...args.slice(0,3),'wrong-owner'])).rejects.toThrow('source_lease_lost')
 })
 test.each(['before','after'])('scheduler recovers %s-COMMIT transport loss before strict renewal',async loss=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task21-loss-'+loss,signal:new AbortController().signal,onError:e=>errors.push(e)})
  const originals=new Map<any,any>();let armed=false,injected=false
  const instrument=(client:any)=>{
   if(originals.has(client))return
   const original=client.query;originals.set(client,original);let waiting=false
   client.query=function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
    if(sql==='COMMIT'&&waiting&&armed&&!injected){
     injected=true;waiting=false
     if(loss==='before')return Promise.reject(Object.assign(Error('Connection terminated unexpectedly'),{code:'ECONNRESET'}))
     return original.apply(client,args).then(()=>{throw Object.assign(Error('Connection terminated unexpectedly'),{code:'ECONNRESET'})})
    }
    const result=original.apply(client,args)
    if(sql.includes('shared.step_memory_source_distribution(')&&result?.then)return result.then((r:any)=>{waiting=r.rows[0]?.result?.waiting===true;return r})
    if(sql==='ROLLBACK'||sql==='COMMIT')waiting=false
    return result
   }
  }
  try{
   for(let n=0;n<128;n++){await scheduler.runOnce();if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root])).rowCount)break;if(n===127)throw Error('task21_loss_seal_missing')}
   const seal=(await f.pool.query('SELECT to_jsonb(d) AS row,d.xmin::text FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0]
   await f.event(source);await scheduler.runOnce()
   const prior=(await f.pool.query('SELECT to_jsonb(w) AS row FROM shared.memory_source_work w WHERE root_key=$1',[root])).rows[0].row
   await f.event(source,true)
   const latest=(await f.pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0].revision
   f.runtime.on('acquire',instrument);armed=true
   await scheduler.runOnce();expect(injected).toBe(true)
   const uncertain=(await f.pool.query('SELECT claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0].claimed_revision
   expect(uncertain).toBe(loss==='before'?String(prior.claimed_revision):latest)
   await scheduler.runOnce()
   const recovered=(await f.pool.query('SELECT to_jsonb(w) AS row FROM shared.memory_source_work w WHERE root_key=$1',[root])).rows[0].row
   expect(String(recovered.claimed_revision)).toBe(latest);expect(recovered.lease_token).toBe(prior.lease_token)
   expect(recovered.attempt).toBe(prior.attempt);expect(recovered.processed_revision).toBe(prior.processed_revision)
   expect((await f.pool.query('SELECT to_jsonb(d) AS row,d.xmin::text FROM shared.memory_source_distributions d WHERE root_key=$1',[root])).rows[0]).toEqual(seal)
   expect(errors).toEqual([])
  }finally{f.runtime.off('acquire',instrument);for(const [client,query]of originals)client.query=query;await scheduler.stop()}
 })
 test('recovery is read-only exact-token CAS and denies expired, stolen and dead claims',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const claim=(await claimSourceWork(f.runtime,'task21-negative',30,256)).find(c=>c.rootKey===root)!
  expect(claim).toBeDefined();expect(await recoverSourceDistributionClaim(f.runtime,claim)).toEqual({claimedRevision:claim.claimedRevision})
  const c=await f.pool.connect(),args=[claim.kind,root,claim.token,claim.workerId]
  try{for(const mutation of [
   {sql:"UPDATE shared.memory_source_work SET lease_until=clock_timestamp()-interval '1 second' WHERE root_key=$1",args:[root]},
   {sql:'UPDATE shared.memory_source_work SET lease_token=$2 WHERE root_key=$1',args:[root,randomUUID()]},
   {sql:"UPDATE shared.memory_source_work SET dead_at=clock_timestamp() WHERE root_key=$1",args:[root]},
  ]){
   await c.query('BEGIN');await c.query(mutation.sql,mutation.args)
   await expect(c.query('SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,NULL)',args)).rejects.toThrow('source_lease_lost');await c.query('ROLLBACK')
  }}finally{await c.query('ROLLBACK');c.release()}
  expect(await recoverSourceDistributionClaim(f.runtime,claim)).toEqual({claimedRevision:claim.claimedRevision})
 })

 test('acknowledged native pages reuse only their frontier receipt while every page renews the actual lease',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id,root=f.root(source)
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installation]);await f.event(source)
  const errors:unknown[]=[],scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'known-frontier',signal:new AbortController().signal,onError:e=>errors.push(e)})
  const originals=new Map<any,any>(),units:{operation:string;txid:string}[]=[],counts={recovery:0,renew:0,step:0,dispatch:0}
  const instrument=(client:any)=>{if(originals.has(client))return;const original=client.query;originals.set(client,original)
   client.query=function(...args:any[]){const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[]
    if(values[1]===root){if(sql.includes('shared.resume_memory_source_distribution(')&&values[4]==null)counts.recovery++;if(sql.includes('shared.renew_memory_source_lease('))counts.renew++;if(sql.includes('shared.step_memory_source_distribution('))counts.step++;if(sql.includes('shared.dispatch_memory_source_distribution('))counts.dispatch++}
    if(values[1]===root&&values[4]!=null&&/shared\.(renew_memory_source_lease|resume_memory_source_distribution|step_memory_source_distribution|dispatch_memory_source_distribution)\(/.test(sql)){
     return original.call(client,'SELECT txid_current()::text AS txid').then((r:any)=>{units.push({operation:sql.match(/shared\.(\w+)/)![1],txid:r.rows[0].txid});return original.apply(client,args)})
    }
    return original.apply(client,args)
   }
  }
  f.runtime.on('acquire',instrument)
  try{
   for(let n=0;n<64;n++){await scheduler.runOnce();if((await f.pool.query('SELECT 1 FROM shared.memory_source_distributions WHERE root_key=$1 AND dispatch_complete',[root])).rowCount)break;if(n===63)throw Error('known_frontier_dispatch_deadline')}
   expect(counts.recovery).toBe(1);expect(counts.renew).toBeGreaterThanOrEqual(3);expect(counts.step).toBeGreaterThanOrEqual(2);expect(counts.dispatch).toBe(2)
   // Each renewal, current checkpoint and single page is one actual physical
   // transaction. A later page must open a different one; no long body/job TX.
   expect(units.length).toBe(counts.renew*3)
   const pageTransactions=new Set<string>()
   for(let n=0;n<units.length;n+=3){
    expect(units.slice(n,n+3).map(u=>u.operation)).toEqual(['renew_memory_source_lease','resume_memory_source_distribution',expect.stringMatching(/^(step|dispatch)_memory_source_distribution$/)])
    expect(new Set(units.slice(n,n+3).map(u=>u.txid)).size).toBe(1);pageTransactions.add(units[n].txid)
   }
   expect(pageTransactions.size).toBe(counts.renew)
   const work=(await f.pool.query('SELECT revision::text,processed_revision::text,lease_token,attempt FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0]
   expect(work.processed_revision).toBe(work.revision);expect(work.lease_token).toBeNull();expect(errors).toEqual([])
  }finally{f.runtime.off('acquire',instrument);for(const[client,query]of originals)client.query=query;await scheduler.stop()}
 })

})
