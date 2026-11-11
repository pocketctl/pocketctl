import {beforeEach,afterEach,test,expect,vi} from 'vitest'
import type pg from 'pg'
const io=vi.hoisted(()=>({advance:vi.fn(),claim:vi.fn(),fail:vi.fn(),recover:vi.fn(),resume:vi.fn(),step:vi.fn(),dispatch:vi.fn(),cleanup:vi.fn(),listener:vi.fn()}))
vi.mock('../../sources/relay-commit-wake.js',()=>({createRelayCommitWakeListener:io.listener}))
vi.mock('../../sources/source-claim-cleanup.js',()=>({releaseCachedSourceClaims:io.cleanup}))
vi.mock('../../sources/shared-work.js',()=>({claimSourceWork:io.claim,failSourceWork:io.fail}))
vi.mock('../../sources/source-distribution.js',()=>({advancePersonalSourceDistribution:io.advance,recoverSourceDistributionClaim:io.recover,resumeSourceDistribution:io.resume,stepSourceDistribution:io.step,dispatchSourceDistribution:io.dispatch,sourceDistributionTransportLost:(e:any)=>e?.code==='ECONNRESET'}))
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {bindSourcePool} from '../../sources/pool-context.js'
let cleanups:(()=>Promise<void>)[]=[]
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});Object.values(io).forEach(f=>f.mockReset());io.listener.mockReturnValue({start:async()=>{},stop:async()=>{}});cleanups=[]})
afterEach(async()=>{for(const stop of cleanups)await stop();vi.useRealTimers()})
function fixture(count=4,extra:Record<string,unknown>={}){
 const waiting=Array.from({length:count},(_,n)=>({kind:'relay_event',rootKey:'1:root-'+n,token:'token-'+n,workerId:'fair-worker',claimedRevision:'1'})),fresh:any[]=[],steps:any[]=[],errors:unknown[]=[],queries:any[]=[],done=new Set<string>(),durable=new Map(waiting.map(c=>[c.rootKey,'2']))
 io.claim.mockImplementation(async()=>{const claim=waiting.shift();if(claim)fresh.push({...claim,at:performance.now()});return claim?[claim]:[]})
 io.recover.mockImplementation(async(_p,c)=>({claimedRevision:durable.get(c.rootKey)}))
 io.resume.mockImplementation(async(_p,c)=>done.has(c.rootKey)?{scanId:'scan-'+c.rootKey,state:'sealed',dispatchCursor:'',dispatchComplete:false}:null)
 io.step.mockImplementation(async(_p,c)=>{steps.push({...c,at:performance.now()});return {waiting:true,scanId:'scan-'+c.rootKey,workRevision:'1',claimedRevision:durable.get(c.rootKey)}})
 io.dispatch.mockResolvedValue({complete:true});io.fail.mockResolvedValue(undefined)
 const client={query:vi.fn(async(sql:string,args:any[])=>{queries.push({sql,args,at:performance.now()});return {rows:sql.includes('activation_ready')?[{activation_ready:true}]:sql.includes('renew_memory_source_lease')?[{valid:true}]:[]}}),release:vi.fn()}
 const pool={connect:vi.fn(async()=>client)} as unknown as pg.Pool;bindSourcePool(pool,{namespace:'memory'})
 io.advance.mockImplementation(async(p,c,limit)=>{
  const valid=(await client.query('SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30) AS valid',[c.kind,c.rootKey,c.token,c.workerId,c.claimedRevision])).rows[0] as {valid?:boolean}
  if(!valid.valid)return {valid:false}
  const checkpoint=await io.resume(p,c)
  return !checkpoint||checkpoint.state==='scanning'?{valid:true,step:await io.step(p,c,checkpoint??undefined,limit)}:{valid:true,dispatched:await io.dispatch(p,c,checkpoint,{cursor:checkpoint.dispatchCursor},limit)}
 })
 const controller=new AbortController(),scheduler=createSharedSourceScheduler({pool,workerId:'fair-worker',signal:controller.signal,onError:e=>errors.push(e),...extra})
 cleanups.push(scheduler.stop)
 return {scheduler,controller,pool,client,fresh,steps,errors,queries,done,durable,waiting}
}
test('explicit graceful stop releases only four cached owned tokens once after admission is closed',async()=>{
 const f=fixture();f.scheduler.start();await vi.advanceTimersByTimeAsync(1500)
 f.controller.abort()
 await f.scheduler.stop({releaseOwnedClaims:true})
 expect(io.cleanup).toHaveBeenCalledOnce()
 const [pool,worker,claims,deadline]=io.cleanup.mock.calls[0]
 expect(pool).toBe(f.pool);expect(worker).toBe('fair-worker');expect(claims).toHaveLength(4)
 expect(new Set(claims.map((c:any)=>c.token))).toEqual(new Set(f.fresh.map(c=>c.token)))
 expect(claims.every((c:any)=>c.claimedRevision==='2')).toBe(true);expect(deadline).toBeLessThanOrEqual(6500)
 const n=f.queries.length;await f.scheduler.stop({releaseOwnedClaims:true});await f.scheduler.runOnce();await vi.advanceTimersByTimeAsync(10000)
 expect(io.cleanup).toHaveBeenCalledOnce();expect(f.queries).toHaveLength(n)
})
test('default stop and abort never opt into cleanup or future token adoption',async()=>{
 const f=fixture();f.scheduler.start();await vi.advanceTimersByTimeAsync(1500);f.controller.abort();await f.scheduler.stop();await f.scheduler.stop({releaseOwnedClaims:true})
 expect(io.cleanup).not.toHaveBeenCalled()
})
test('cleanup failure is reported once and never reopens stopped work admission',async()=>{
 const f=fixture();f.scheduler.start();await vi.advanceTimersByTimeAsync(1500);const failure=Error('source_cleanup_commit_unknown');io.cleanup.mockRejectedValueOnce(failure)
 await f.scheduler.stop({releaseOwnedClaims:true});expect(f.errors).toEqual([failure]);const n=f.queries.length
 await f.scheduler.stop({releaseOwnedClaims:true});await vi.advanceTimersByTimeAsync(10000);expect(io.cleanup).toHaveBeenCalledOnce();expect(f.queries).toHaveLength(n)
})
test('waiting for the current source pass consumes the graceful cleanup deadline',async()=>{
 const f=fixture(1);let unblock!:(x:any)=>void;io.recover.mockImplementationOnce(()=>new Promise(r=>{unblock=r}))
 f.scheduler.start();await vi.advanceTimersByTimeAsync(0);expect(unblock).toBeTypeOf('function')
 const stopping=f.scheduler.stop({releaseOwnedClaims:true});await vi.advanceTimersByTimeAsync(4500);expect(io.cleanup).not.toHaveBeenCalled()
 unblock({claimedRevision:'2'});await stopping;expect(io.cleanup.mock.calls[0][3]).toBe(5000)
})
test('four pending native roots are all physically revisited without one waiting root monopolizing the scheduler',async()=>{
 const f=fixture();f.scheduler.start();await vi.advanceTimersByTimeAsync(4500)
 expect(f.fresh).toHaveLength(4);expect(new Set(f.steps.map(c=>c.rootKey)).size).toBe(4)
 for(const root of f.durable.keys()){const samples=f.steps.filter(c=>c.rootKey===root);expect(samples.length).toBeGreaterThanOrEqual(3);expect(samples[0].at).toBeLessThan(2000);expect(samples.at(-1)!.at).toBeGreaterThanOrEqual(3000)}
 expect(io.fail).not.toHaveBeenCalled();expect(f.errors).toEqual([])
})
test('waiting only rotates through bounded distinct roots and cannot create a zero-delay renewal loop',async()=>{
 const f=fixture();f.scheduler.start();await vi.advanceTimersByTimeAsync(5500)
 expect(f.fresh).toHaveLength(4);for(const root of f.durable.keys()){const visits=f.steps.filter(c=>c.rootKey===root);expect(visits.length).toBeLessThanOrEqual(6);for(let n=1;n<visits.length;n++)expect(visits[n].at-visits[n-1].at).toBeGreaterThanOrEqual(1000)}
 expect(io.claim.mock.calls.length).toBeLessThanOrEqual(12)
})
test('exactly four live lease slots are bounded; fifth is discovered after ordinary completion frees one',async()=>{
 const f=fixture(5);f.scheduler.start();await vi.advanceTimersByTimeAsync(1500);expect(f.fresh).toHaveLength(4);expect(f.waiting).toHaveLength(1)
 f.done.add('1:root-1');await vi.advanceTimersByTimeAsync(2000);expect(f.fresh).toHaveLength(5);expect(io.dispatch).toHaveBeenCalled();expect(io.fail).not.toHaveBeenCalled()
})
test('55P03 retains exact busy token while other roots advance at the original backoff',async()=>{
 const f=fixture();const normal=io.recover.getMockImplementation()!;let once=true;io.recover.mockImplementation(async(p,c)=>{if(c.rootKey==='1:root-0'&&once){once=false;throw Object.assign(Error('busy'),{code:'55P03'})}return normal(p,c)})
 f.scheduler.start();await vi.advanceTimersByTimeAsync(3500);expect(f.fresh).toHaveLength(4);expect(f.steps.some(c=>c.rootKey==='1:root-0')).toBe(true);expect(io.fail).not.toHaveBeenCalled();expect(f.errors).toEqual([]);expect(io.recover.mock.calls.filter(([,c])=>c.rootKey==='1:root-0').every(([,c])=>c.token==='token-0')).toBe(true)
})
test('lost frontier response is reconciled using the original token before strict renewal and next step',async()=>{
 const f=fixture();const normal=io.step.getMockImplementation()!;let once=true;io.step.mockImplementation(async(p,c)=>{if(c.rootKey==='1:root-0'&&once){once=false;f.durable.set(c.rootKey,'3');throw Object.assign(Error('lost response'),{code:'ECONNRESET'})}return normal(p,c)})
 f.scheduler.start();await vi.advanceTimersByTimeAsync(3500);expect(f.fresh).toHaveLength(4);expect(f.steps.find(c=>c.rootKey==='1:root-0')).toMatchObject({token:'token-0',claimedRevision:'3'});expect(io.fail).not.toHaveBeenCalled();expect(f.queries.filter(q=>q.sql.includes('renew_memory_source_lease')&&q.args[1]==='1:root-0').at(-1)?.args[4]).toBe('3')
})
test('policy error remains failure, never waiting or positive progress',async()=>{
 const f=fixture();const normal=io.recover.getMockImplementation()!;io.recover.mockImplementation(async(p,c)=>{if(c.rootKey==='1:root-0')throw Error('source_lease_lost');return normal(p,c)})
 f.scheduler.start();await vi.advanceTimersByTimeAsync(2500);expect(io.fail).toHaveBeenCalledTimes(1);expect(io.fail.mock.calls[0][1]).toMatchObject({rootKey:'1:root-0',token:'token-0'});expect(f.errors).toHaveLength(1);expect(f.steps.every(c=>c.rootKey!=='1:root-0')).toBe(true);expect(f.fresh).toHaveLength(4)
})
test('manual one-pass retries do not wait on automatic-burst deferral',async()=>{
 const f=fixture(1);await f.scheduler.runOnce();await f.scheduler.runOnce();expect(f.steps).toHaveLength(2);expect(f.steps.every(c=>c.token==='token-0')).toBe(true)
})
test('stop and abort close admission without late lease recovery or queries',async()=>{
 const f=fixture();f.scheduler.start();await vi.advanceTimersByTimeAsync(1500);await f.scheduler.stop();const n=f.queries.length,c=io.recover.mock.calls.length;await vi.advanceTimersByTimeAsync(10000);await f.scheduler.runOnce();expect(f.queries).toHaveLength(n);expect(io.recover.mock.calls).toHaveLength(c)
 const g=fixture();g.controller.abort();g.scheduler.start();await vi.advanceTimersByTimeAsync(3000);expect(g.queries).toEqual([])
})

test('ordinary reacquisition of an expired queued root replaces its stale cached token without duplicating a slot',async()=>{
 const f=fixture(3);await f.scheduler.runOnce();await f.scheduler.runOnce();await f.scheduler.runOnce();
 io.claim.mockResolvedValueOnce([{kind:'relay_event',rootKey:'1:root-0',token:'replacement-0',workerId:'fair-worker',claimedRevision:'2'}]);
 await f.scheduler.runOnce();const boundary=f.steps.length;
 for(let n=0;n<6;n++)await f.scheduler.runOnce();
 expect(f.steps.slice(boundary).filter(c=>c.rootKey==='1:root-0').length).toBeGreaterThan(0);
 expect(f.steps.slice(boundary).filter(c=>c.rootKey==='1:root-0').every(c=>c.token==='replacement-0')).toBe(true);expect(io.fail).not.toHaveBeenCalled()
})

test('durable ready hint wakes only a currently held root before its idle timer',async()=>{
 const f=fixture(1);f.scheduler.start();await vi.advanceTimersByTimeAsync(10);const visits=f.steps.length
 f.done.add('1:root-0');(f.scheduler as any).wake({kind:'relay_event',key:'1:root-0'});await vi.advanceTimersByTimeAsync(10)
 expect(io.dispatch).toHaveBeenCalledOnce();expect(f.steps).toHaveLength(visits);expect(performance.now()).toBeLessThan(1000)
})
test('invalid personal root hints and stopped scheduler cannot create source SQL',async()=>{
 const f=fixture(1);f.scheduler.start();await vi.advanceTimersByTimeAsync(10);const before=f.queries.length
 for(let n=0;n<30;n++)(f.scheduler as any).wake({kind:'team_collaboration',key:'1:unknown'});await vi.advanceTimersByTimeAsync(10);expect(f.queries).toHaveLength(before)
 await f.scheduler.stop();(f.scheduler as any).wake({kind:'relay_event',key:'1:root-0'});await vi.advanceTimersByTimeAsync(10);expect(f.queries).toHaveLength(before)
})
test('only acknowledged positive dispatch pages hint the job consumer',async()=>{
 const dispatched=vi.fn(),f=fixture(1,{onDispatch:dispatched});f.done.add('1:root-0');io.dispatch.mockResolvedValueOnce({complete:true,pageCount:1})
 await f.scheduler.runOnce();expect(dispatched).toHaveBeenCalledOnce()
 const g=fixture(1,{onDispatch:dispatched});g.done.add('1:root-0');io.dispatch.mockRejectedValueOnce(Object.assign(Error('lost'),{code:'ECONNRESET'}))
 await g.scheduler.runOnce();expect(dispatched).toHaveBeenCalledOnce()
})

test('a hint arriving during a source pass requests one fresh pass without overlapping SQL',async()=>{
 const f=fixture(1);let release!:(x:any)=>void;io.recover.mockImplementationOnce(()=>new Promise(r=>{release=r}));f.scheduler.start();await vi.advanceTimersByTimeAsync(0)
 expect(release).toBeTypeOf('function');for(let n=0;n<50;n++)(f.scheduler as any).wake({kind:'relay_event',key:'1:root-0'});expect(io.recover).toHaveBeenCalledOnce()
 f.done.add('1:root-0');release({claimedRevision:'2'});await vi.advanceTimersByTimeAsync(10)
 expect(io.dispatch).toHaveBeenCalledOnce();expect(f.queries.filter(q=>q.sql.includes('activation_ready'))).toHaveLength(2);expect(f.errors).toEqual([])
})

test('a durable ready hint after normal source ACK probes new dirty work with a fresh SQL token',async()=>{
 const f=fixture(1);f.done.add('1:root-0');f.scheduler.start();await vi.advanceTimersByTimeAsync(10);expect(io.dispatch).toHaveBeenCalledOnce();expect(f.fresh).toHaveLength(1)
 f.waiting.push({kind:'relay_event',rootKey:'1:root-0',token:'fresh-after-ack',workerId:'fair-worker',claimedRevision:'3'});f.done.delete('1:root-0');f.durable.set('1:root-0','3')
 for(let n=0;n<50;n++)f.scheduler.wake({kind:'relay_event',key:'1:root-0'});await vi.advanceTimersByTimeAsync(10)
 expect(f.fresh).toHaveLength(2);expect(f.steps.at(-1)).toMatchObject({rootKey:'1:root-0',token:'fresh-after-ack',claimedRevision:'3'});expect(f.errors).toEqual([]);expect(performance.now()).toBeLessThan(1000)
})
test('wake storms coalesce to at most one new burst per 100ms without changing idle polling',async()=>{
 const f=fixture(0);f.scheduler.start();await vi.advanceTimersByTimeAsync(1)
 for(let n=0;n<20;n++){f.scheduler.wake({kind:'relay_event',key:'valid-internal-hint'});await vi.advanceTimersByTimeAsync(1)}
 await vi.advanceTimersByTimeAsync(200)
 expect(f.queries.filter(q=>q.sql.includes('activation_ready')).length).toBeLessThanOrEqual(3);expect(f.errors).toEqual([])
})
test('unrelated Relay notifications retain each waiting root until its one-second fallback',async()=>{
 const f=fixture(4,{listenForRelay:true});f.scheduler.start();await vi.advanceTimersByTimeAsync(10)
 expect(f.steps).toHaveLength(4);const notify=io.listener.mock.calls[0][0].wake
 for(let n=0;n<9;n++){notify();await vi.advanceTimersByTimeAsync(100)}
 expect(f.steps).toHaveLength(4)
 for(let n=0;n<4;n++){notify();await vi.advanceTimersByTimeAsync(100)}
 for(const root of f.fresh){const visits=f.steps.filter(s=>s.rootKey===root.rootKey);expect(visits).toHaveLength(2);expect(visits[1].at-visits[0].at).toBeGreaterThanOrEqual(1000)}
 expect(f.errors).toEqual([])
})
test('only a durable root-ready hint releases that waiting root before fallback and admits the next root',async()=>{
 const f=fixture(5,{listenForRelay:true});f.scheduler.start();await vi.advanceTimersByTimeAsync(10)
 const notify=io.listener.mock.calls[0][0].wake;notify();await vi.advanceTimersByTimeAsync(100)
 f.done.add('1:root-0');f.scheduler.wake({kind:'relay_event',key:'1:root-0'});await vi.advanceTimersByTimeAsync(100)
 expect(io.dispatch).toHaveBeenCalledOnce();expect(f.fresh).toHaveLength(5)
 for(const root of ['1:root-1','1:root-2','1:root-3'])expect(f.steps.filter(s=>s.rootKey===root)).toHaveLength(1)
 expect(f.steps.find(s=>s.rootKey==='1:root-4')).toBeDefined();expect(f.errors).toEqual([])
})
test('notifications stopping just before fallback cannot postpone its original deadline',async()=>{
 const f=fixture(4,{listenForRelay:true});f.scheduler.start();await vi.advanceTimersByTimeAsync(10)
 const notify=io.listener.mock.calls[0][0].wake
 for(let n=0;n<9;n++){notify();await vi.advanceTimersByTimeAsync(100)}
 expect(f.steps).toHaveLength(4);await vi.advanceTimersByTimeAsync(110)
 expect(f.steps).toHaveLength(8)
 for(const root of f.fresh){const visits=f.steps.filter(s=>s.rootKey===root.rootKey);expect(visits[1].at-visits[0].at).toBeGreaterThanOrEqual(1000);expect(visits[1].at-visits[0].at).toBeLessThanOrEqual(1010)}
})
test('contention at an expired waiting deadline retains ordinary idle yielding',async()=>{
 const f=fixture(4);f.scheduler.start();await vi.advanceTimersByTimeAsync(10)
 const query=f.client.query.getMockImplementation()!;let busy=true
 f.client.query.mockImplementation(async(sql:string,args:any[])=>{const result=await query(sql,args);if(busy&&sql.includes('renew_memory_source_lease')&&args[1]==='1:root-0'){busy=false;throw Object.assign(Error('busy'),{code:'55P03'})}return result})
 await vi.advanceTimersByTimeAsync(1090)
 expect(f.queries.filter(q=>q.sql.includes('renew_memory_source_lease'))).toHaveLength(5);expect(f.steps).toHaveLength(4);expect(f.errors).toEqual([])
})
test('acknowledged frontier pages need one physical recovery while every revisit still renews through SQL',async()=>{
 const f=fixture(1);await f.scheduler.runOnce();await f.scheduler.runOnce();await f.scheduler.runOnce()
 expect(io.recover).toHaveBeenCalledOnce();expect(f.steps).toHaveLength(3)
 expect(f.queries.filter(q=>q.sql.includes('renew_memory_source_lease'))).toHaveLength(3)
 expect(f.steps.every(s=>s.token==='token-0'&&s.claimedRevision==='2')).toBe(true)
})
test('a lost reply after an acknowledged page requires physical frontier recovery before its next strict renewal',async()=>{
 const f=fixture(1);await f.scheduler.runOnce();io.step.mockImplementationOnce(async(_p,c)=>{f.durable.set(c.rootKey,'3');throw Object.assign(Error('lost response'),{code:'ECONNRESET'})})
 await f.scheduler.runOnce();const before=f.queries.length;await f.scheduler.runOnce()
 expect(io.recover).toHaveBeenCalledTimes(2);expect(io.recover.mock.calls[1][1]).toMatchObject({token:'token-0',claimedRevision:'2'})
 expect(f.queries.slice(before).find(q=>q.sql.includes('renew_memory_source_lease'))?.args[4]).toBe('3')
 expect(f.steps.at(-1)).toMatchObject({token:'token-0',claimedRevision:'3'});expect(io.fail).not.toHaveBeenCalled()
})
test('a known receipt cannot admit an expired lease and a replacement token receives independent recovery',async()=>{
 const f=fixture(1);await f.scheduler.runOnce();const query=f.client.query.getMockImplementation()!
 f.client.query.mockImplementation(async(sql:string,args:any[])=>sql.includes('renew_memory_source_lease')&&args[2]==='token-0'?{rows:[{valid:false}]}:query(sql,args))
 await f.scheduler.runOnce();expect(f.steps).toHaveLength(1)
 f.durable.set('1:root-0','3');io.claim.mockResolvedValueOnce([{kind:'relay_event',rootKey:'1:root-0',token:'replacement',workerId:'fair-worker',claimedRevision:'3'}])
 await f.scheduler.runOnce();expect(io.recover).toHaveBeenCalledTimes(2)
 expect(io.recover.mock.calls[1][1]).toMatchObject({token:'replacement',claimedRevision:'3'});expect(f.steps.at(-1)).toMatchObject({token:'replacement',claimedRevision:'3'})
})
