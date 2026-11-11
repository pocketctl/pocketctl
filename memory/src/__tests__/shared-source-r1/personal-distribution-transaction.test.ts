import {test,expect,vi} from 'vitest'
import type pg from 'pg'
import type {SourceWorkClaim} from '@pocketctl/session-source'
import {advancePersonalSourceDistribution} from '../../sources/source-distribution.js'
import {bindSourcePool,bindSourceConnectionAlias} from '../../sources/pool-context.js'
const claim={kind:'relay_event',rootKey:'1:session',token:'token',workerId:'worker',claimedRevision:'7'} as SourceWorkClaim
function fixture(checkpoint:any=null,valid=true){
 const queries:{sql:string;args?:unknown[]}[]=[],step={scanId:'scan',state:'sealed',cursor:'c',reset:false,controlRevision:'2',workRevision:'7'},dispatched={scanId:'scan',cursor:'target',complete:true,pageCount:1,workRevision:'7'}
 const client={query:vi.fn(async(sql:string,args?:unknown[])=>{queries.push({sql,args});return {rows:sql.includes('renew_memory_source_lease')?[{valid}]:sql.includes('resume_memory_source_distribution')?[{checkpoint}]:sql.includes('step_memory_source_distribution')?[{result:step}]:sql.includes('dispatch_memory_source_distribution')?[{result:dispatched}]:[]}}),release:vi.fn()}
 const pool={connect:vi.fn(async()=>client),query:vi.fn(()=>{throw Error('implicit_transaction_forbidden')})} as unknown as pg.Pool
 bindSourcePool(pool,{namespace:'memory'});return {pool,client,queries,step,dispatched}
}
test('renew, durable checkpoint and exactly one scan page share one committed physical transaction',async()=>{
 const f=fixture(),result=await advancePersonalSourceDistribution(f.pool,claim,64)
 expect(result).toEqual({valid:true,step:f.step});expect(f.pool.connect).toHaveBeenCalledOnce();expect(f.pool.query).not.toHaveBeenCalled()
 expect(f.queries.map(q=>q.sql)).toEqual(['BEGIN',"SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'",'SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30) AS valid','SELECT shared.resume_memory_source_distribution($1,$2,$3,$4,$5) AS checkpoint','SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,$8) AS result','COMMIT'])
 const args=[claim.kind,claim.rootKey,claim.token,claim.workerId,claim.claimedRevision]
 expect(f.queries[2].args).toEqual(args);expect(f.queries[3].args).toEqual(args);expect(f.queries[4].args).toEqual([...args,null,'',64]);expect(f.client.release).toHaveBeenCalledOnce()
})
test('scanning resumes only the checkpoint read inside the current physical transaction',async()=>{
 const checkpoint={scanId:'current',state:'scanning',cursor:'native-cursor'},f=fixture(checkpoint)
 await advancePersonalSourceDistribution(f.pool,claim,8)
 expect(f.queries[4].args).toEqual([claim.kind,claim.rootKey,claim.token,claim.workerId,'7','current','native-cursor',8])
})
test('sealed checkpoint admits exactly one dispatch and reports only its acknowledged result',async()=>{
 const f=fixture({scanId:'sealed',state:'sealed',dispatchCursor:'old-target'}),result=await advancePersonalSourceDistribution(f.pool,claim,8)
 expect(result).toEqual({valid:true,dispatched:f.dispatched});expect(f.queries[4]).toEqual({sql:'SELECT shared.dispatch_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,$8) AS result',args:[claim.kind,claim.rootKey,claim.token,claim.workerId,'7','sealed','old-target',8]});expect(f.queries.at(-1)?.sql).toBe('COMMIT')
})
test('failed strict lease renewal cannot read or advance a checkpoint',async()=>{
 const f=fixture(null,false);expect(await advancePersonalSourceDistribution(f.pool,claim)).toEqual({valid:false})
 expect(f.queries).toHaveLength(4);expect(f.queries.at(-1)?.sql).toBe('COMMIT');expect(f.client.release).toHaveBeenCalledOnce()
})
test.each(['resume_memory_source_distribution','step_memory_source_distribution','COMMIT'])('failure at %s never returns a positive result or retries',async failAt=>{
 const f=fixture(),original=f.client.query.getMockImplementation()!,error=Object.assign(Error('lost-or-denied'),{code:failAt==='COMMIT'?'ECONNRESET':'P0001'})
 f.client.query.mockImplementation(async(sql,args)=>{if(sql.includes(failAt))throw error;return original(sql,args)})
 await expect(advancePersonalSourceDistribution(f.pool,claim)).rejects.toBe(error)
 expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');expect(f.pool.connect).toHaveBeenCalledOnce();expect(f.client.release).toHaveBeenCalledOnce()
})
test.each([0,129,1.5])('invalid page bound %s never borrows a connection',async limit=>{
 const f=fixture();await expect(advancePersonalSourceDistribution(f.pool,claim,limit)).rejects.toThrow('invalid_source_distribution_page');expect(f.pool.connect).not.toHaveBeenCalled()
})
test('only personal Relay roots on the original Memory pool may use the combined transaction',async()=>{
 const f=fixture();await expect(advancePersonalSourceDistribution(f.pool,{...claim,kind:'team_collaboration'})).rejects.toThrow('personal_distribution_requires_relay_root');expect(f.pool.connect).not.toHaveBeenCalled()
 const g=fixture();bindSourcePool(g.pool,{namespace:'public'});await expect(advancePersonalSourceDistribution(g.pool,claim)).rejects.toThrow('source_distribution_requires_physical_pool');expect(g.pool.connect).not.toHaveBeenCalled()
 const h=fixture();bindSourceConnectionAlias(h.pool,{});await expect(advancePersonalSourceDistribution(h.pool,claim)).rejects.toThrow('source_distribution_requires_physical_pool');expect(h.pool.connect).not.toHaveBeenCalled()
})

test.each(['renew_memory_source_lease','resume_memory_source_distribution'])('stop after %s drains its current transaction without admitting more metadata SQL',async stopAt=>{
 const f=fixture(),original=f.client.query.getMockImplementation()!;let active=true
 f.client.query.mockImplementation(async(sql,args)=>{const result=await original(sql,args);if(sql.includes(stopAt))active=false;return result})
 expect(await advancePersonalSourceDistribution(f.pool,claim,64,()=>active)).toEqual({valid:false})
 const last=f.queries.findIndex(q=>q.sql.includes(stopAt));expect(f.queries.slice(last+1).map(q=>q.sql)).toEqual(['COMMIT']);expect(f.client.release).toHaveBeenCalledOnce()
})
