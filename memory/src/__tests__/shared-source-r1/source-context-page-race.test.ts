import {expect,test,vi} from 'vitest'
import {loadSourceContextSet} from '../../sources/source-context-set.js'
import {JobDeferredError} from '../../jobs/types.js'
const root={kind:'relay_event' as const,key:'1:session'},installation='installation',scan='10000000-0000-0000-0000-000000000001'
const race=()=>Object.assign(Error('source_context_set_not_ready'),{code:'P0001'})
function fixture(failure:Error,fullFirstPage=false){
 let pages=0;const query=vi.fn(async(sql:string)=>{
  if(sql.includes('current_memory_source_distribution'))return {rows:[{seal:{scanId:scan,targetCount:fullFirstPage?'129':'1',controlRevision:'1',workRevision:'1'}}]}
  if(sql.includes('read_memory_source_context_set')){
   if(fullFirstPage&&pages++===0)return {rows:Array.from({length:128},(_,i)=>({cursor_key:String(i+1).padStart(3,'0'),source_scope:{installationId:installation},state:'current',target_mode:'shared-active',source_version:{}}))}
   throw failure
  }
  throw Error('unexpected query')
 });return {query,run:(purpose:'personal-projection'|'current-content'='personal-projection',selectedRoot:any=root)=>loadSourceContextSet({query}as any,installation,selectedRoot,scan,purpose)}
}
test.each([false,true])('a real SQL not-ready during personal page enumeration yields without partial output (later page=%s)',async later=>{
 const f=fixture(race(),later),error=await f.run().catch(e=>e)
 expect(error).toBeInstanceOf(JobDeferredError);expect(error.reason).toBe('source_not_ready');expect(error.availableAt.getTime()-Date.now()).toBeGreaterThan(900)
 expect(f.query).toHaveBeenCalledTimes(later?3:2);expect(f.query.mock.calls.every(([sql])=>sql.startsWith('SELECT '))).toBe(true)
})
test.each([Object.assign(Error('source_context_set_not_ready'),{code:'55P03'}),Object.assign(Error('source_context_policy_denied'),{code:'P0001'}),Error('source_context_set_not_ready'),Error('connection lost')])('other SQL or transport failures retain their identity: %s',async failure=>{
 const f=fixture(failure);await expect(f.run()).rejects.toBe(failure)
})
test.each(['current-content','team'])('existing %s paths retain their original error',async kind=>{
 const failure=race(),f=fixture(failure)
 await expect(f.run(kind==='current-content'?'current-content':'personal-projection',kind==='team'?{kind:'team_collaboration',key:'team:1'}:root)).rejects.toBe(failure)
})
