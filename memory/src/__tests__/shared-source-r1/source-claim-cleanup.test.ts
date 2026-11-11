import type pg from 'pg'
import {test,expect,vi,afterEach} from 'vitest'
import {releaseCachedSourceClaims} from '../../sources/source-claim-cleanup.js'
import {bindSourcePool} from '../../sources/pool-context.js'
const claim={kind:'relay_event' as const,rootKey:'1:session',workerId:'worker',token:'20000000-0000-0000-0000-000000000001',claimedRevision:'3'}
function fixture(handler?:(sql:string,args:any[])=>Promise<any>){
 const queries:{sql:string;args:any[]}[]=[]
 const client={connection:{stream:{destroy:vi.fn()}},release:vi.fn(),query:vi.fn(async(sql:string,args:any[]=[])=>{queries.push({sql,args});if(handler)return handler(sql,args);return {rows:sql.includes('resume_memory_source_distribution')?[{recovery:{claimedRevision:'7'}}]:[{valid:true}],command:sql==='COMMIT'?'COMMIT':'SELECT'}})}
 const pool={connect:vi.fn(async()=>client)}as unknown as pg.Pool;bindSourcePool(pool,{namespace:'memory'});return{pool,client,queries}
}
afterEach(()=>vi.useRealTimers())
test('same live token is reconciled then failed temporarily, never acknowledged or reset',async()=>{
 const f=fixture();await releaseCachedSourceClaims(f.pool,'worker',[claim],performance.now()+5000)
 const recover=f.queries.find(q=>q.sql.includes('resume_memory_source_distribution'))!,fail=f.queries.find(q=>q.sql.includes('fail_memory_source_work'))!
 expect(recover.args).toEqual([claim.kind,claim.rootKey,claim.token,'worker'])
 expect(fail.args).toEqual([claim.kind,claim.rootKey,claim.token,'worker','7','temporary_unavailable'])
 expect(f.queries.some(q=>/ack_memory|claim_memory_source_work|UPDATE\s/i.test(q.sql))).toBe(false)
 expect(f.queries.filter(q=>q.sql==='COMMIT')).toHaveLength(1);expect(f.client.release).toHaveBeenCalledOnce()
})
test('all four tokens share one physical checkout and original absolute deadline',async()=>{
 const f=fixture(),claims=Array.from({length:4},(_,n)=>({...claim,rootKey:'1:session-'+n,token:'20000000-0000-0000-0000-00000000000'+(n+1)}))
 await releaseCachedSourceClaims(f.pool,'worker',claims,performance.now()+5000)
 expect(f.pool.connect).toHaveBeenCalledOnce();expect(f.queries.filter(q=>q.sql.includes('fail_memory_source_work'))).toHaveLength(4)
 expect(f.queries.filter(q=>q.sql==='COMMIT')).toHaveLength(4)
})
test('empty cache or already expired cleanup budget does not acquire a connection',async()=>{
 const f=fixture();await releaseCachedSourceClaims(f.pool,'worker',[],performance.now()+5000)
 await releaseCachedSourceClaims(f.pool,'worker',[claim],performance.now()-1);expect(f.pool.connect).not.toHaveBeenCalled()
})
test('foreign worker claims are rejected without SQL',async()=>{
 const f=fixture();await expect(releaseCachedSourceClaims(f.pool,'other',[claim],performance.now()+5000)).rejects.toThrow('source_cleanup_claims_invalid');expect(f.pool.connect).not.toHaveBeenCalled()
})
test('unknown COMMIT is never retried and destroys the physical connection',async()=>{
 const f=fixture(async sql=>{if(sql==='COMMIT')throw Object.assign(Error('socket lost'),{code:'ECONNRESET'});return{rows:sql.includes('resume_memory_source_distribution')?[{recovery:{claimedRevision:'3'}}]:[{valid:true}]}})
 await expect(releaseCachedSourceClaims(f.pool,'worker',[claim],performance.now()+5000)).rejects.toThrow('source_cleanup_commit_unknown')
 expect(f.queries.filter(q=>q.sql==='COMMIT')).toHaveLength(1);expect(f.queries.some(q=>q.sql==='ROLLBACK')).toBe(false);expect(f.client.connection.stream.destroy).toHaveBeenCalledOnce()
})
test('late checkout is destroyed with no SQL after one second',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});const f=fixture();let resolve!:(c:any)=>void
 f.pool.connect=vi.fn(()=>new Promise(r=>{resolve=r}))as any
 const result=releaseCachedSourceClaims(f.pool,'worker',[claim],performance.now()+5000).catch(e=>e)
 await vi.advanceTimersByTimeAsync(1001);expect(await result).toBeInstanceOf(Error);resolve(f.client);await vi.advanceTimersByTimeAsync(1)
 expect(f.queries).toEqual([]);expect(f.client.connection.stream.destroy).toHaveBeenCalledOnce()
})
test('hung metadata uses the original total budget and forbids late COMMIT',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});let unblock!:(v:any)=>void
 const f=fixture(async sql=>sql.includes('resume_memory_source_distribution')?new Promise(r=>{unblock=r}):{rows:[]})
 const result=releaseCachedSourceClaims(f.pool,'worker',[claim],performance.now()+2000).catch(e=>e)
 await vi.advanceTimersByTimeAsync(2001);expect(await result).toBeInstanceOf(Error);unblock({rows:[{recovery:{claimedRevision:'3'}}]});await vi.advanceTimersByTimeAsync(1)
 expect(f.queries.some(q=>q.sql==='COMMIT')).toBe(false);expect(f.client.connection.stream.destroy).toHaveBeenCalledOnce()
})
test('known lost ownership rolls back and other cached roots may still clean up',async()=>{
 const lost=Object.assign(Error('source_lease_lost'),{code:'P0001'});let seen=0
 const f=fixture(async sql=>{if(sql.includes('resume_memory_source_distribution')&&++seen===1)throw lost;return{rows:sql.includes('resume_memory_source_distribution')?[{recovery:{claimedRevision:'3'}}]:[{valid:true}],command:sql==='COMMIT'?'COMMIT':'SELECT'}})
 await releaseCachedSourceClaims(f.pool,'worker',[claim,{...claim,rootKey:'1:next',token:'20000000-0000-0000-0000-000000000002'}],performance.now()+5000)
 expect(f.queries.filter(q=>q.sql==='ROLLBACK')).toHaveLength(1);expect(f.queries.filter(q=>q.sql.includes('fail_memory_source_work'))).toHaveLength(1);expect(f.queries.find(q=>q.sql.includes('fail_memory_source_work'))!.args[1]).toBe('1:next')
})
test('rollback transport failure never reuses the broken client for another cached root',async()=>{
 const lost=Object.assign(Error('source_lease_lost'),{code:'P0001'}),f=fixture(async sql=>{if(sql.includes('resume_memory_source_distribution'))throw lost;if(sql==='ROLLBACK')throw Error('rollback socket lost');return{rows:[]}})
 await expect(releaseCachedSourceClaims(f.pool,'worker',[claim,{...claim,rootKey:'1:next'}],performance.now()+5000)).rejects.toBe(lost)
 expect(f.queries.filter(q=>q.sql.includes('resume_memory_source_distribution'))).toHaveLength(1);expect(f.client.connection.stream.destroy).toHaveBeenCalledOnce()
})
test('malformed recovery cannot authorize a failure write or acknowledgement',async()=>{
 const f=fixture(async sql=>({rows:sql.includes('resume_memory_source_distribution')?[{recovery:{claimedRevision:'0'}}]:[]}))
 await expect(releaseCachedSourceClaims(f.pool,'worker',[claim],performance.now()+5000)).rejects.toThrow('source_cleanup_recovery_invalid')
 expect(f.queries.some(q=>q.sql.includes('fail_memory_source_work'))).toBe(false);expect(f.queries.some(q=>q.sql==='COMMIT')).toBe(false)
})
test('oversized or duplicate cached roots are rejected before checkout',async()=>{
 const f=fixture();for(const claims of [[claim,claim],Array.from({length:5},(_,n)=>({...claim,rootKey:'1:root-'+n}))])await expect(releaseCachedSourceClaims(f.pool,'worker',claims,performance.now()+5000)).rejects.toThrow('source_cleanup_claims_invalid')
 expect(f.pool.connect).not.toHaveBeenCalled()
})
