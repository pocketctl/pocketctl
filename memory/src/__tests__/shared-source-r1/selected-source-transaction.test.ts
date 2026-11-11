import type pg from 'pg'
import {afterEach,describe,expect,test,vi} from 'vitest'
import {runSelectedSourceTransaction,SourceProcessingPins,SelectedSourceLockBusy} from '../../sources/processing-pins.js'
import {bindSourceConnectionAlias} from '../../sources/pool-context.js'
import {JobDeferredError} from '../../jobs/types.js'
const hold=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
function fixture(query?:(sql:string)=>Promise<any>){
 const clients:any[]=[],calls:string[]=[]
 const pool={connect:vi.fn(async()=>{const c={connection:{stream:{destroy:vi.fn()}},release:vi.fn(),query:vi.fn(async(sql:string)=>{calls.push(sql);return query?query(sql):{rows:[{valid:true,state:'current',content_revision:'1',authorization_revision:'1',storage_revision:'1'}]}})};clients.push(c);return c})} as unknown as pg.Pool
 return {pool,clients,calls}
}
afterEach(()=>vi.useRealTimers())
describe('selected physical source transactions share bounded metadata admission',()=>{
 test('selected caller mapping preserves retry eligibility but ordinary deferred waits do not',async()=>{
  const f=fixture();let attempts=0
  await runSelectedSourceTransaction(f.pool,'retry',undefined,async()=>{if(++attempts===1)throw new SelectedSourceLockBusy()})
  expect(attempts).toBe(2);expect(f.calls.filter(s=>s==='ROLLBACK')).toHaveLength(1)
  const wait=new JobDeferredError('source_not_ready',new Date(Date.now()+1000)),callback=vi.fn(async()=>{throw wait})
  await expect(runSelectedSourceTransaction(f.pool,'retry',undefined,callback)).rejects.toBe(wait)
  expect(callback).toHaveBeenCalledOnce()
 })
 test('transient selected SQL lock conflicts retry only after acknowledged rollback and release',async()=>{
  const f=fixture();let attempts=0
  const result=await runSelectedSourceTransaction(f.pool,'retry',undefined,async c=>{
   if(attempts++)expect(f.clients[attempts-2].release).toHaveBeenCalledExactlyOnceWith()
   await c.query('SELECT original_authority_fence')
   if(attempts<3)throw Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'})
   return 'current'
  })
  expect(result).toBe('current');expect(attempts).toBe(3)
  expect(f.calls.filter(s=>s==='ROLLBACK')).toHaveLength(2);expect(f.calls.filter(s=>s==='COMMIT')).toHaveLength(1)
  expect(f.calls.filter(s=>s==='SELECT original_authority_fence')).toHaveLength(3)
 })
 test('persistent selected lock contention stops after four complete physical attempts',async()=>{
  const f=fixture(),busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),callback=vi.fn(async()=>{throw busy})
  await expect(runSelectedSourceTransaction(f.pool,'retry',undefined,callback)).rejects.toBe(busy)
  expect(callback).toHaveBeenCalledTimes(4);expect(f.pool.connect).toHaveBeenCalledTimes(4)
  expect(f.calls.filter(s=>s==='ROLLBACK')).toHaveLength(4);expect(f.calls).not.toContain('COMMIT')
 })
 test.each(['transport','hang'])('lock denial with unacknowledged rollback %s never authorizes another attempt',async cleanup=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),entered=hold(),f=fixture(async sql=>{
   if(sql==='ROLLBACK'){entered.resolve();if(cleanup==='transport')throw Error('socket lost');await new Promise(()=>undefined)}return {rows:[]}
  }),callback=vi.fn(async()=>{throw busy})
  const pending=runSelectedSourceTransaction(f.pool,'retry',undefined,callback).catch(e=>e)
  await entered.promise;if(cleanup==='hang')await vi.advanceTimersByTimeAsync(5001)
  expect(await pending).toBe(busy);expect(callback).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledOnce()
 })
 test('SQL-shaped COMMIT denial is never replayed even when rollback is acknowledged',async()=>{
  const busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),f=fixture(async sql=>{if(sql==='COMMIT')throw busy;return {rows:[]}}),callback=vi.fn(async()=>undefined)
  await expect(runSelectedSourceTransaction(f.pool,'retry',undefined,callback)).rejects.toBe(busy)
  expect(callback).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledOnce()
 })
 test('failed physical release after rollback cannot authorize another attempt',async()=>{
  const f=fixture(),busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),callback=vi.fn(async(c:any)=>{
   c.release.mockImplementation(()=>{throw Error('release failed')});throw busy
  })
  await expect(runSelectedSourceTransaction(f.pool,'retry',undefined,callback)).rejects.toBe(busy)
  expect(callback).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledOnce()
  expect(f.clients[0].connection.stream.destroy).toHaveBeenCalledOnce()
 })
 test('known policy denial survives a failed final client release without retry',async()=>{
  const f=fixture(),denial=Error('source_reference_changed'),callback=vi.fn(async(c:any)=>{
   c.release.mockImplementation(()=>{throw Error('release failed')});throw denial
  })
  await expect(runSelectedSourceTransaction(f.pool,'retry',undefined,callback)).rejects.toBe(denial)
  expect(callback).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledOnce();expect(f.clients[0].connection.stream.destroy).toHaveBeenCalledOnce()
 })
 test('abort during released retry delay prevents subsequent checkout and callback',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const controller=new AbortController(),f=fixture(),busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),callback=vi.fn(async()=>{throw busy})
  const pending=runSelectedSourceTransaction(f.pool,'retry',controller.signal,callback).catch(e=>e)
  await vi.advanceTimersByTimeAsync(1);controller.abort();await vi.advanceTimersByTimeAsync(10)
  expect(await pending).toMatchObject({commitOutcome:'not-dispatched'});expect(f.pool.connect).toHaveBeenCalledOnce();expect(callback).toHaveBeenCalledOnce()
 })
 test('physical retries share the original five-second total deadline',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const f=fixture(),busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),callback=vi.fn(async()=>{
   if(callback.mock.calls.length===1){await new Promise(resolve=>setTimeout(resolve,4000));throw busy}
   await new Promise(()=>undefined)
  }),pending=runSelectedSourceTransaction(f.pool,'retry',undefined,callback).catch(e=>e)
  await vi.advanceTimersByTimeAsync(5001);expect(await pending).toMatchObject({commitOutcome:'not-dispatched'})
  expect(callback).toHaveBeenCalledTimes(2);expect(f.pool.connect).toHaveBeenCalledTimes(2);expect(performance.now()).toBe(5001)
 })
 test('a final released retry delay cannot extend the absolute deadline',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const f=fixture(),busy=Object.assign(Error('source_metadata_lock_busy'),{code:'55P03'}),callback=vi.fn(async()=>{
   await new Promise(resolve=>setTimeout(resolve,4995));throw busy
  });let outcome:unknown='pending'
  const pending=runSelectedSourceTransaction(f.pool,'retry',undefined,callback).catch(e=>{outcome=e})
  await vi.advanceTimersByTimeAsync(5001)
  const observed=outcome;await vi.advanceTimersByTimeAsync(10);await pending
  expect(observed).toMatchObject({commitOutcome:'not-dispatched'});expect(callback).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledOnce()
 })
 test.each([
  Object.assign(Error('other_lock_busy'),{code:'55P03'}),
  Object.assign(Error('source_metadata_lock_busy'),{code:'55000'}),
  Object.assign(Error('source_metadata_scan_changed'),{code:'P0001'}),
  Error('source_reference_changed'),
 ])('other denials retain their original error and never retry: %s',async denial=>{
  const f=fixture(),callback=vi.fn(async()=>{throw denial})
  await expect(runSelectedSourceTransaction(f.pool,'retry',undefined,callback)).rejects.toBe(denial)
  expect(callback).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledOnce()
 })
 test('physical aliases serialize same installation but another installation stays parallel',async()=>{
  const f=fixture(),gate=hold(),entered=hold(),events:string[]=[],alias={connect:f.pool.connect.bind(f.pool)} as unknown as pg.Pool;bindSourceConnectionAlias(alias,f.pool)
  const first=runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{events.push('first');entered.resolve();await gate.promise})
  await entered.promise
  const second=runSelectedSourceTransaction(alias,'a',undefined,async()=>{events.push('second')})
  await runSelectedSourceTransaction(f.pool,'b',undefined,async()=>{events.push('other')})
  expect(events).toEqual(['first','other']);expect(f.pool.connect).toHaveBeenCalledTimes(2)
  gate.resolve();await Promise.all([first,second]);expect(events).toEqual(['first','other','second'])
  expect(f.clients.every(c=>c.release.mock.calls.length===1)).toBe(true)
 })
 test('queued abort performs no checkout or late SQL and does not block the next task',async()=>{
  const f=fixture(),gate=hold(),entered=hold(),controller=new AbortController()
  const first=runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{entered.resolve();await gate.promise});await entered.promise
  const second=runSelectedSourceTransaction(f.pool,'a',controller.signal,async()=>{throw Error('late_callback')}).catch(e=>e)
  controller.abort();expect(await second).toMatchObject({reason:'source_not_ready',commitOutcome:'not-dispatched'});expect(f.pool.connect).toHaveBeenCalledOnce()
  gate.resolve();await first;await runSelectedSourceTransaction(f.pool,'a',undefined,async()=>undefined);expect(f.pool.connect).toHaveBeenCalledTimes(2)
 })
 test('active same-key nesting rejects without deadlock; inherited continuation works after release',async()=>{
  const f=fixture(),later=hold(),continuation=hold<Promise<void>>()
  await runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{
   await expect(runSelectedSourceTransaction(f.pool,'a',undefined,async()=>undefined)).rejects.toThrow('source_metadata_nested_operation')
   continuation.resolve(later.promise.then(()=>runSelectedSourceTransaction(f.pool,'a',undefined,async()=>undefined)))
  })
  later.resolve();await(await continuation.promise);expect(f.pool.connect).toHaveBeenCalledTimes(2)
 })
 test('a current pin retains its original two-second deadline behind selected positive work',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const f=fixture(),gate=hold(),entered=hold(),positive=runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{entered.resolve();await gate.promise});await entered.promise
  const pins=new SourceProcessingPins(f.pool,'execution'),scope={installationId:'a',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'a',authorizationRevision:'1',configVersion:'1',modeGeneration:'1'}
  const protecting=pins.protectCurrent(scope,{kind:'relay_event',key:'1:session'}).catch(e=>e)
  await vi.advanceTimersByTimeAsync(2001);expect(await protecting).toMatchObject({code:'processing_pin_expired_or_unavailable'});expect(f.pool.connect).toHaveBeenCalledOnce()
  gate.resolve();await positive;await pins.close();expect(f.calls.some(s=>s.includes('acquire_memory_source_processing_pin'))).toBe(false)
 })
 test('selected total deadline destroys active transport and forbids callback SQL after expiry',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const f=fixture(),gate=hold(),entered=hold(),work=runSelectedSourceTransaction(f.pool,'a',undefined,async c=>{entered.resolve();await gate.promise;await c.query('SELECT forbidden_late')}).catch(e=>e)
  await entered.promise;await vi.advanceTimersByTimeAsync(5001);expect(await work).toMatchObject({commitOutcome:'not-dispatched'})
  expect(f.clients[0].connection.stream.destroy).toHaveBeenCalledOnce();expect(f.clients[0].release).toHaveBeenCalledExactlyOnceWith(true)
  gate.resolve();await vi.advanceTimersByTimeAsync(0);expect(f.calls).not.toContain('SELECT forbidden_late');expect(f.calls).not.toContain('COMMIT')
 })
 test('lost COMMIT acknowledgement is unknown, with no claimed rollback and safe idempotent replay',async()=>{
  let durable=0,first=true
  const f=fixture(async sql=>{if(sql==='INSERT idempotent')durable=1;if(sql==='COMMIT'&&first){first=false;throw Object.assign(Error('Connection terminated unexpectedly'),{code:'ECONNRESET'})}return {rows:[]}})
  await expect(runSelectedSourceTransaction(f.pool,'a',undefined,async c=>{await c.query('INSERT idempotent')})).rejects.toMatchObject({commitOutcome:'unknown',code:'source_metadata_commit_outcome_unknown'})
  expect(durable).toBe(1);expect(f.calls).not.toContain('ROLLBACK');expect(f.clients[0].release).toHaveBeenCalledExactlyOnceWith(true)
  await runSelectedSourceTransaction(f.pool,'a',undefined,async c=>{await c.query('INSERT idempotent')});expect(durable).toBe(1)
 })
 test('a dispatched COMMIT may finish after deadline and remains explicitly unknown to its caller',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const gate=hold(),entered=hold();let durable=false
  const f=fixture(async sql=>{if(sql==='COMMIT'){entered.resolve();await gate.promise;durable=true}return {rows:[]}})
  const work=runSelectedSourceTransaction(f.pool,'a',undefined,async()=>undefined).catch(e=>e)
  await entered.promise;await vi.advanceTimersByTimeAsync(5001);expect(await work).toMatchObject({commitOutcome:'unknown'})
  gate.resolve();await vi.advanceTimersByTimeAsync(0);expect(durable).toBe(true);expect(f.calls.filter(s=>s==='COMMIT')).toHaveLength(1);expect(f.calls).not.toContain('ROLLBACK')
 })
 test.each(['deadline','abort','transport'])('known predicate and server denials survive rollback %s without becoming deferred',async cleanup=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  for(const serverCommit of [false,true]){
   const denial=serverCommit?Object.assign(Error('source_policy_denied'),{code:'55000'}):Error('source_reference_changed'),controller=new AbortController(),entered=hold()
   const f=fixture(async sql=>{
    if(serverCommit&&sql==='COMMIT')throw denial
    if(sql==='ROLLBACK'){entered.resolve();if(cleanup==='transport')throw Object.assign(Error('socket failure'),{code:'ECONNRESET'});await new Promise(()=>undefined)}
    return {rows:[]}
   })
   const work=runSelectedSourceTransaction(f.pool,'a',controller.signal,async()=>{if(!serverCommit)throw denial}).catch(e=>e)
   await entered.promise
   if(cleanup==='deadline')await vi.advanceTimersByTimeAsync(5001)
   if(cleanup==='abort')controller.abort()
   expect(await work).toBe(denial);expect(f.clients[0].release).toHaveBeenCalledExactlyOnceWith(true)
   expect(f.calls.filter(s=>s==='COMMIT')).toHaveLength(serverCommit?1:0)
   const stopped=f.calls.length;await vi.advanceTimersByTimeAsync(1);expect(f.calls).toHaveLength(stopped)
  }
 })
 test('ordinary predicate and server COMMIT denials retain their original errors',async()=>{
  const denial=Object.assign(Error('source_policy_denied'),{code:'55000'}),f=fixture(async sql=>{if(sql==='COMMIT')throw denial;return {rows:[]}})
  await expect(runSelectedSourceTransaction(f.pool,'a',undefined,async()=>undefined)).rejects.toBe(denial)
  expect(f.calls).toContain('ROLLBACK')
  const original=Error('source_reference_changed')
  await expect(runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{throw original})).rejects.toBe(original)
 })
 test('queue residence consumes selected total budget instead of restarting it at admission',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const f=fixture(),gate=hold(),firstEntered=hold(),secondEntered=hold()
  const first=runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{firstEntered.resolve();await gate.promise});await firstEntered.promise
  await vi.advanceTimersByTimeAsync(1000)
  const second=runSelectedSourceTransaction(f.pool,'a',undefined,async()=>{secondEntered.resolve();await new Promise(()=>undefined)}).catch(e=>e)
  await vi.advanceTimersByTimeAsync(3500);expect(f.pool.connect).toHaveBeenCalledOnce()
  gate.resolve();await first;await secondEntered.promise
  await vi.advanceTimersByTimeAsync(1501);expect(await second).toMatchObject({commitOutcome:'not-dispatched'})
  expect(performance.now()).toBe(6001);expect(f.clients[1].release).toHaveBeenCalledExactlyOnceWith(true)
 })
 test('late selected checkout is evicted without BEGIN or callback dispatch',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance','Date']})
  const gate=hold<any>(),client={query:vi.fn(),release:vi.fn(),connection:{stream:{destroy:vi.fn()}}},callback=vi.fn()
  const work=runSelectedSourceTransaction({connect:()=>gate.promise} as unknown as pg.Pool,'a',undefined,callback).catch(e=>e)
  await vi.advanceTimersByTimeAsync(1001);expect(await work).toMatchObject({commitOutcome:'not-dispatched'})
  gate.resolve(client);await vi.advanceTimersByTimeAsync(0)
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);expect(client.query).not.toHaveBeenCalled();expect(callback).not.toHaveBeenCalled()
 })
 test('callback cannot commit, rollback or create savepoints inside the owned physical transaction',async()=>{
  for(const sql of ['COMMIT','ROLLBACK','SAVEPOINT nested']){
   const f=fixture()
   await expect(runSelectedSourceTransaction(f.pool,'a',undefined,async c=>{await c.query(sql)})).rejects.toThrow('source_metadata_nested_transaction')
   expect(f.calls.filter(s=>s==='ROLLBACK')).toHaveLength(1);expect(f.calls).not.toContain('COMMIT');expect(f.calls).not.toContain('SAVEPOINT nested')
  }
 })

})
