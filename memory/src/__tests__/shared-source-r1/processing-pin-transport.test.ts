import type pg from 'pg'
import {describe,expect,test,vi} from 'vitest'
import {SourceProcessingPins} from '../../sources/processing-pins.js'
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

})
