import type pg from 'pg'
import {describe,expect,test,vi} from 'vitest'
import {SourceProcessingPins,runSelectedSourceTransaction} from '../../sources/processing-pins.js'
import {bindSourceConnectionAlias} from '../../sources/pool-context.js'
const scope={installationId:'10000000-0000-0000-0000-000000000088',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'10000000-0000-0000-0000-000000000088',authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
const root={kind:'relay_event' as const,key:'1:session'},version={content:'1',authorization:'1',storage:'1'}
const never=()=>new Promise<any>(()=>undefined)
describe('actual processing-pin module with unresponsive connected transport',()=>{
 test.each(['BEGIN','SET LOCAL','acquire_memory_source_processing_pin','COMMIT','ROLLBACK'])('bounds a connected %s hang and destroys the socket before returning',async phase=>{
  const destroy=vi.fn(),release=vi.fn(),queries:string[]=[]
  let began!:()=>void;const entered=new Promise<void>(resolve=>{began=resolve})
  const client={connection:{stream:{destroy}},release,query:vi.fn(async(sql:string)=>{
   queries.push(sql)
   if(phase==='ROLLBACK'&&sql.includes('acquire_memory_source_processing_pin'))throw Error('synthetic query error')
   if(sql.startsWith(phase)||sql.includes(phase)){began();return never()}
   return {rows:[{valid:true}]}
  })}
  const pool={connect:vi.fn(async()=>client)} as unknown as pg.Pool,pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088')
  const work=pins.protect(scope,root,version).then(()=>null,error=>error)
  await entered;const started=Date.now()
  await pins.close()
  const error=await work
  expect(error).toBeInstanceOf(Error);expect(Date.now()-started).toBeLessThan(2800)
  expect(destroy).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledExactlyOnceWith(true)
  const stopped=queries.length
  await expect(pins.assertCurrent()).rejects.toThrow('processing_pin_expired_or_unavailable')
  await expect(pins.protect(scope,root,version)).rejects.toThrow('processing_pin_expired_or_unavailable')
  await new Promise(resolve=>setTimeout(resolve,20));expect(queries).toHaveLength(stopped)
 },4000)
 test('late pool acquisition destroys/releases the client and sends no SQL',async()=>{
  let connected!:(value:any)=>void
  const destroy=vi.fn(),release=vi.fn(),query=vi.fn(),client={connection:{stream:{destroy}},release,query}
  const pool={connect:()=>new Promise(resolve=>{connected=resolve})} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088'),work=pins.protect(scope,root,version).then(()=>null,error=>error)
  await new Promise(resolve=>setTimeout(resolve,1100));expect(await work).toBeInstanceOf(Error)
  connected(client);await new Promise(resolve=>setTimeout(resolve,20));await pins.close()
  expect(destroy).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query).not.toHaveBeenCalled()
 },3000)
 test('best-effort release also has a total connected deadline and close is idempotent',async()=>{
  const first={release:vi.fn(),query:vi.fn(async()=>({rows:[{valid:true}]}))}
  const destroy=vi.fn(),release=vi.fn(),second={connection:{stream:{destroy}},release,query:vi.fn(async(sql:string)=>sql.includes('release_memory_source_processing_pins')?never():{rows:[]})}
  const connect=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),pins=new SourceProcessingPins({connect} as unknown as pg.Pool,'20000000-0000-0000-0000-000000000088')
  await pins.protect(scope,root,version)
  const started=Date.now(),closing=pins.close();expect(pins.close()).toBe(closing);await closing
  expect(Date.now()-started).toBeLessThan(2800);expect(destroy).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledExactlyOnceWith(true)
  expect(connect).toHaveBeenCalledTimes(2)
  await expect(pins.assertCurrent()).rejects.toThrow('processing_pin_expired_or_unavailable')
 })

 test('transport failure on renewal permanently fences subsequent admission in the original execution',async()=>{
  const normal=()=>({release:vi.fn(),query:vi.fn(async()=>({rows:[{valid:true}]}))})
  const destroy=vi.fn(),release=vi.fn(),hung={connection:{stream:{destroy}},release,query:vi.fn(async(sql:string)=>sql.includes('acquire_memory_source_processing_pin')?never():{rows:[]})}
  const connect=vi.fn().mockResolvedValue(normal()).mockResolvedValueOnce(normal()).mockResolvedValueOnce(hung)
  const pins=new SourceProcessingPins({connect} as unknown as pg.Pool,'20000000-0000-0000-0000-000000000088')
  await pins.protect(scope,root,version)
  await expect(pins.assertCurrent()).rejects.toThrow('processing_pin_expired_or_unavailable')
  expect(connect).toHaveBeenCalledTimes(2);expect(destroy).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledExactlyOnceWith(true)
  await expect(pins.assertCurrent()).rejects.toThrow('processing_pin_expired_or_unavailable')
  await expect(pins.protect(scope,root,version)).rejects.toThrow('processing_pin_expired_or_unavailable')
  expect(connect).toHaveBeenCalledTimes(2)
  await pins.close();expect(connect).toHaveBeenCalledTimes(3)
 },4000)
 test('false mutex result retries identical metadata only after releasing each transaction',async()=>{
  const events:string[]=[],params:unknown[][]=[];let attempts=0,active=0
  const pool={connect:async()=>{active++;events.push('connect');return {release:()=>{active--;events.push('release')},query:async(sql:string,args:unknown[])=>{
   if(sql.includes('acquire_memory_source_processing_pin')){params.push(args);events.push('pin');return {rows:[{valid:++attempts===4}]}}
   events.push(sql);return {rows:[]}
  }}}} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088')
  const protecting=pins.protect(scope,root,version).then(()=>undefined,error=>error)
  await new Promise(resolve=>setTimeout(resolve,10));expect(active).toBe(0)
  expect(await protecting).toBeUndefined();expect(attempts).toBe(4);expect(params.every(args=>JSON.stringify(args)===JSON.stringify(params[0]))).toBe(true)
  expect(events.filter(x=>x==='release')).toHaveLength(4);expect(pins.count).toBe(1);await pins.close()
 })
 test('close during released retry backoff prohibits every subsequent SQL',async()=>{
  const sqls:string[]=[];let attempts=0,releases=0
  const pool={connect:async()=>({release:()=>{releases++},query:async(sql:string)=>{sqls.push(sql);if(sql.includes('acquire_memory_source_processing_pin'))attempts++;return {rows:[{valid:false}]}}})} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088'),work=pins.protect(scope,root,version).then(()=>null,e=>e)
  await new Promise(resolve=>setTimeout(resolve,10));const count=sqls.length
  await pins.close();expect(await work).toBeInstanceOf(Error);expect(attempts).toBe(1);expect(releases).toBe(1);expect(sqls).toHaveLength(count)
 })
 test('all retries share one total transport deadline including their released backoff',async()=>{
  let attempts=0,destroyed=0
  const pool={connect:async()=>({connection:{stream:{destroy:()=>{destroyed++}}},release:()=>{},query:async(sql:string)=>{
   if(sql.includes('acquire_memory_source_processing_pin')){attempts++;if(attempts===1)await new Promise(resolve=>setTimeout(resolve,1400));else return never()}
   return {rows:[{valid:false}]}
  }})} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088'),started=performance.now()
  await expect(pins.protect(scope,root,version)).rejects.toThrow('processing_pin_expired_or_unavailable')
  expect(attempts).toBe(2);expect(performance.now()-started).toBeLessThan(2250);expect(destroyed).toBe(1);await pins.close()
 },3500)
 test('unexpected SQL error preserves its mapping and rolls back once without retry',async()=>{
  const error=Object.assign(Error('original transport failure'),{code:'08006'}),queries:string[]=[]
  const pool={connect:async()=>({release:()=>{},query:async(sql:string)=>{queries.push(sql);if(sql.includes('acquire_memory_source_processing_pin'))throw error;return {rows:[]}}})} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088')
  await expect(pins.protect(scope,root,version)).rejects.toBe(error)
  expect(queries.filter(sql=>sql==='ROLLBACK')).toHaveLength(1);expect(queries.filter(sql=>sql.includes('acquire_memory_source_processing_pin'))).toHaveLength(1);await pins.close()
 })

 test('an unexpected nonboolean pin response fails once without treating transport corruption as contention',async()=>{
  let attempts=0
  const pool={connect:async()=>({release:()=>{},query:async(sql:string)=>{if(sql.includes('acquire_memory_source_processing_pin'))attempts++;return {rows:[{}]}}})} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,'20000000-0000-0000-0000-000000000088')
  await expect(pins.protect(scope,root,version)).rejects.toThrow('processing_pin_expired_or_unavailable');expect(attempts).toBe(1);await pins.close()
 })

})

describe('metadata-only protection uses the physical installation mutex',()=>{
 const authority={state:'current',content_revision:'7',authorization_revision:'3',storage_revision:'2'}
 test('one execution includes an in-flight renewal serial wait in the invocation deadline',async()=>{
  let connections=0,acquisitions=0,destroyed=0,slow=false
  const pool={connect:async()=>{connections++;return {release:()=>{},connection:{stream:{destroy:()=>{destroyed++}}},query:async(sql:string)=>{
   if(sql.includes('memory_relay_source_authority')){if(slow)await new Promise(r=>setTimeout(r,1400));return {rows:[authority]}}
   if(sql.includes('acquire_memory_source_processing_pin'))acquisitions++
   return {rows:[{valid:true}]}
  }}}} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,crypto.randomUUID());await pins.protectCurrent(scope,root);slow=true
  const first=pins.assertCurrent();await new Promise(r=>setTimeout(r,100));const began=performance.now()
  const second=pins.protectCurrent(scope,{...root,key:'1:second'}).catch(e=>e)
  await first;expect(await second).toBeInstanceOf(Error);expect(performance.now()-began).toBeLessThan(2250)
  expect(connections).toBe(3);expect(acquisitions).toBe(2);expect(destroyed).toBe(1)
  await new Promise(r=>setTimeout(r,850));expect(acquisitions).toBe(2);await pins.close()
 },4500)
 test('a multi-root metadata renewal shares one invocation budget and sends no late pin SQL',async()=>{
  let slow=false,acquisitions=0,destroyed=0
  const pool={connect:async()=>({release:()=>{},connection:{stream:{destroy:()=>{destroyed++}}},query:async(sql:string)=>{
   if(sql.includes('memory_relay_source_authority')){if(slow)await new Promise(r=>setTimeout(r,1250));return {rows:[authority]}}
   if(sql.includes('acquire_memory_source_processing_pin'))acquisitions++
   return {rows:[{valid:true}]}
  }})} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,crypto.randomUUID());await pins.protectCurrent(scope,root);await pins.protectCurrent(scope,{...root,key:'1:second'});slow=true
  const began=performance.now();await expect(pins.assertCurrent()).rejects.toThrow('processing_pin_expired_or_unavailable')
  expect(performance.now()-began).toBeLessThan(2250);expect(acquisitions).toBe(3);expect(destroyed).toBe(1)
  await new Promise(r=>setTimeout(r,650));expect(acquisitions).toBe(3);await pins.close()
 },4000)
 test('close aborts a same-execution queued request before it can check out',async()=>{
  let finish!:()=>void,entered!:()=>void,connections=0,acquisitions=0
  const held=new Promise<void>(r=>{finish=r}),started=new Promise<void>(r=>{entered=r})
  const pool={connect:async()=>{connections++;return {release:()=>{},query:async(sql:string)=>{
   if(sql.includes('memory_relay_source_authority')){entered();await held;return {rows:[authority]}}
   if(sql.includes('acquire_memory_source_processing_pin'))acquisitions++
   return {rows:[{valid:true}]}
  }}}} as unknown as pg.Pool
  const pins=new SourceProcessingPins(pool,crypto.randomUUID()),first=pins.protectCurrent(scope,root).catch(e=>e)
  await started;const second=pins.protectCurrent(scope,{...root,key:'1:second'}).catch(e=>e),closing=pins.close();finish()
  expect(await first).toBeInstanceOf(Error);expect(await second).toBeInstanceOf(Error);await closing;expect(connections).toBe(1);expect(acquisitions).toBe(0)
 })
 test('eight execution aliases serialize one installation while other installations remain parallel',async()=>{
  let active=0,peak=0
  const versions:string[]=[],pool={connect:async()=>({release:()=>{active--},query:async(sql:string,args:any[])=>{
   if(sql==='BEGIN'){active++;peak=Math.max(peak,active)}
   if(sql.includes('memory_relay_source_authority')){await new Promise(r=>setTimeout(r,15));return {rows:[authority]}}
   if(sql.includes('acquire_memory_source_processing_pin')){versions.push(args[3]);return {rows:[{valid:true}]}}
   return {rows:[]}
  }})} as unknown as pg.Pool
  const wrappers=Array.from({length:8},()=>{const alias={connect:()=>pool.connect()} as pg.Pool;bindSourceConnectionAlias(alias,pool);return new SourceProcessingPins(alias,crypto.randomUUID())})
  await Promise.all(wrappers.map(p=>p.protectCurrent(scope,root)));expect(peak).toBe(1)
  expect(versions).toHaveLength(8);expect(versions.every(v=>v===JSON.stringify({content:'7',authorization:'3',storage:'2'}))).toBe(true)
  const second=new SourceProcessingPins(pool,crypto.randomUUID());peak=0
  await Promise.all([wrappers[0].protectCurrent(scope,root),second.protectCurrent({...scope,installationId:crypto.randomUUID()},root)])
  expect(peak).toBe(2);await Promise.all([...wrappers,second].map(p=>p.close()))
 })
 test('queue time consumes the original deadline without checkout or late SQL',async()=>{
  let connected=0,entered!:()=>void,finish!:()=>void;const queries:string[]=[]
  const began=new Promise<void>(resolve=>{entered=resolve}),held=new Promise<void>(resolve=>{finish=resolve})
  const pool={connect:async()=>{connected++;return {release:()=>{},connection:{stream:{destroy:()=>{}}},query:async(sql:string)=>{
   queries.push(sql);return {rows:[]}
  }}}} as unknown as pg.Pool
  // A 5s selected transaction holds the SAME physical queue until explicitly
  // released AFTER the queued pin's unchanged 2s invocation has timed out.
  // Two independent 2s pin calls have slightly different deadlines: the first
  // can release with a valid sub-millisecond checkout window left for the next.
  const predecessor=runSelectedSourceTransaction(pool,scope.installationId,undefined,async()=>{entered();await held;return null})
  await began;const pins=new SourceProcessingPins(pool,crypto.randomUUID()),started=performance.now()
  try{
   expect(await pins.protectCurrent(scope,root).catch(e=>e)).toBeInstanceOf(Error)
   expect(performance.now()-started).toBeLessThan(2300);expect(connected).toBe(1)
   expect(queries).toEqual(['BEGIN',"SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'"])
   finish();expect(await predecessor).toBeNull();await new Promise<void>(resolve=>setImmediate(resolve));expect(connected).toBe(1)
   expect(queries).toEqual(['BEGIN',"SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='1s'",'COMMIT'])
  }finally{finish();await predecessor.catch(()=>undefined);await pins.close()}
 },3500)
 test('closing a queued execution prevents checkout when the predecessor completes',async()=>{
  let entered!:()=>void,finish!:()=>void,connected=0
  const began=new Promise<void>(r=>{entered=r}),held=new Promise<void>(r=>{finish=r})
  const pool={connect:async()=>{connected++;return {release:()=>{},query:async(sql:string)=>{
   if(sql.includes('memory_relay_source_authority')){entered();await held;return {rows:[authority]}}
   return {rows:[{valid:true}]}
  }}}} as unknown as pg.Pool
  const first=new SourceProcessingPins(pool,crypto.randomUUID()),queued=new SourceProcessingPins(pool,crypto.randomUUID())
  const one=first.protectCurrent(scope,root);await began;const two=queued.protectCurrent(scope,root).catch(e=>e),closing=queued.close();finish();await one
  expect(await two).toBeInstanceOf(Error);await closing;expect(connected).toBe(1);await first.close()
 })
 test('a late current-protection checkout is destroyed without authority SQL',async()=>{
  let finish!:(c:any)=>void;const destroy=vi.fn(),release=vi.fn(),query=vi.fn()
  const pins=new SourceProcessingPins({connect:()=>new Promise(r=>{finish=r})} as unknown as pg.Pool,crypto.randomUUID())
  const result=pins.protectCurrent(scope,root).catch(e=>e);await new Promise(r=>setTimeout(r,1100));expect(await result).toBeInstanceOf(Error)
  finish({release,query,connection:{stream:{destroy}}});await new Promise(r=>setTimeout(r,10));expect(query).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledWith(true);await pins.close()
 },2500)
})
