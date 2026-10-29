import {IDBFactory} from 'fake-indexeddb'
import {webcrypto} from 'node:crypto'
import {beforeEach,afterEach,test,expect,vi} from 'vitest'
import {TeamTaskHolderJournal} from '../teamTaskHolderJournal'
import {validHolderOperation,matchesHolderReceipt,matchesHolderResult,type HolderOperation} from '../../types/teamTaskHolder'
import type {TeamTask} from '../../types/team'
const op:HolderOperation={team:'team',task:'task',actor:2,active:true,input:{request_id:'claim',expected_revision:3}}
const result={id:'task',team_id:'team',revision:4,holder_user_ids:[2]} as TeamTask
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto)})
afterEach(()=>vi.unstubAllGlobals())
test('original claim survives reopen and cannot be replaced or cleared by release',async()=>{
 const a=new TeamTaskHolderJournal(),b=new TeamTaskHolderJournal();await a.reserve('scope',op)
 expect(await b.load('scope','task')).toEqual(op)
 expect(await b.load('other','task')).toBeNull();expect(await b.load('scope','other')).toBeNull()
 await expect(b.reserve('scope',{...op,active:false})).rejects.toThrow()
 await expect(b.remove('scope',{...op,active:false})).rejects.toThrow()
 await b.reserve('scope',op);await b.remove('scope',op);expect(await a.load('scope','task')).toBeNull()
})
test('cross-tab contention reserves only one unresolved holder intent',async()=>{
 const a=new TeamTaskHolderJournal(),b=new TeamTaskHolderJournal()
 const results=await Promise.allSettled([a.reserve('scope',op),b.reserve('scope',{...op,active:false})])
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
})
test('storage failure never permits transient fallback',async()=>{
 vi.stubGlobal('indexedDB',undefined);await expect(new TeamTaskHolderJournal().reserve('scope',op)).rejects.toThrow()
})
test('identity injection and malformed original request fail validation',()=>{
 for(const bad of [{...op,actor:0},{...op,active:'true'},{...op,input:{...op.input,holder_user_id:99}},{...op,input:{...op.input,request_id:' claim '}},{...op,input:{...op.input,expected_revision:0}}])expect(validHolderOperation(bad)).toBe(false)
})
test('receipt validates original identity, action and exact resulting revision',()=>{
 expect(matchesHolderResult(op,result)).toBe(true)
 for(const wrong of [{...result,revision:5},{...result,team_id:'other'},{...result,holder_user_ids:[]},{...result,holder_user_ids:[2,2]}])expect(matchesHolderResult(op,wrong)).toBe(false)
 const receipt={task_id:'task',actor_user_id:2,request_id:'claim',found:true,response:result}
 expect(matchesHolderReceipt(op,receipt)).toBe(true)
 expect(matchesHolderReceipt(op,{...receipt,actor_user_id:3})).toBe(false)
 expect(matchesHolderReceipt(op,{...receipt,found:false,response:null})).toBe(true)
 expect(matchesHolderReceipt(op,{...receipt,found:false})).toBe(false)
 expect(matchesHolderResult({...op,active:false},{...result,holder_user_ids:[]})).toBe(true)
})
