import {expect,test} from 'vitest'
import {Registry} from 'prom-client'
import {createSourceMetrics,updateSourceGauges,attachSourceMetrics,createSourceGaugeCollector} from '../../sources/metrics.js'
import {bindSourcePool} from '../../sources/pool-context.js'
import {createObservedSourceReader} from '../../sources/observed-reader.js'
test('source metric labels are finite and never include identity or raw errors',async()=>{
 const registry=new Registry(),metrics=createSourceMetrics(registry)
 metrics.readerError('resolveBodies','relay_event','revoked')
 metrics.readerError('secret-session','owner-private','private connection/password')
 const text=await registry.metrics()
 expect(text).toContain('operation="resolveBodies",kind="relay_event",reason="revoked"')
 expect(text).not.toMatch(/secret-session|owner-private|password/)
})
test('shared health resets absent finite series only after a successful metadata query',async()=>{
 const registry=new Registry(),metrics=createSourceMetrics(registry)
 let fail=false
 const pool={query:async(sql:string)=>{expect(sql).toBe('SELECT shared.memory_source_health() AS health');if(fail)throw Error('timeout');return{rows:[{health:{ready:false,roots:[{kind:'relay_event',state:'pending',count:'2',oldest_seconds:'10'}],modes:[{mode:'shared-shadow',count:'1'}],copies:[{table:'source_events',bytes:'9007199254740993'}]}}]}}}
 bindSourcePool(pool,{namespace:'memory'})
 await updateSourceGauges(pool as never,metrics)
 expect(await registry.metrics()).toContain('kind="relay_event",state="pending"} 2')
 fail=true;await expect(updateSourceGauges(pool as never,metrics)).rejects.toThrow('timeout')
 expect(await registry.metrics()).toContain('kind="relay_event",state="pending"} 2')
})
test('reader instrumentation counts bounded failures and preserves rejection',async()=>{
 const registry=new Registry(),metrics=createSourceMetrics(registry)
 const pool={query:async()=>{throw Error('private credentials must not enter metrics')}}
 bindSourcePool(pool,{namespace:'memory'});attachSourceMetrics(pool as never,metrics)
 await expect(createObservedSourceReader(pool as never).checkAuthority({installationId:'private-installation',principalUserId:'1',ownerScopeKind:'personal',ownerScopeId:'private-owner',authorizationRevision:'1',configVersion:'1',modeGeneration:'1'},{kind:'relay_event',key:'private-session'})).rejects.toThrow('shared_source_unavailable:source_store_unavailable')
 const text=await registry.metrics();expect(text).toContain('reason="source_store_unavailable"');expect(text).not.toMatch(/private-|credentials/)
})

test('scrapes share one bounded read-only transaction and pace subsequent attempts',async()=>{
 const metrics=createSourceMetrics(new Registry()),calls:string[]=[]
 let now=0,release!:()=>void,connects=0
 const blocked=new Promise<void>(resolve=>{release=resolve})
 const client={query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT')){await blocked;return{rows:[{health:{ready:false,roots:[],modes:[],copies:[]}}]}}return{rows:[]}},release(){calls.push('release')}}
 const pool={connect:async()=>{connects++;return client}}
 bindSourcePool(pool,{namespace:'memory'})
 const collect=createSourceGaugeCollector(pool as never,metrics,{now:()=>now})
 const a=collect(),b=collect();release();await Promise.all([a,b]);await collect()
 expect(connects).toBe(1);expect(calls).toEqual(['BEGIN READ ONLY',"SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",'SELECT shared.memory_source_health() AS health','COMMIT','release'])
 now=15000;await collect();expect(connects).toBe(2)
})
