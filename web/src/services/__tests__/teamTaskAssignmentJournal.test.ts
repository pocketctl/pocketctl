import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { TeamTaskAssignmentJournal, type TaskAssignment } from '../teamTaskAssignmentJournal'
const op:TaskAssignment={team:'team',session:'session',actor:1,input:{request_id:'original',instruction:'goal',acceptance:'proof',target_offer_ids:['offer'],context_version:0,review_policy:{reviewer_user_id:2,primary_offer_id:'offer',required_checks:['unit']}}}
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto)})
afterEach(()=>vi.unstubAllGlobals())
test('a new instance restores durable intent and other account or Relay scopes cannot read it',async()=>{
 await new TeamTaskAssignmentJournal().reserve('actor-1-relay-a',op);expect(await new TeamTaskAssignmentJournal().load('actor-1-relay-a','session')).toEqual(op)
 expect(await new TeamTaskAssignmentJournal().load('actor-2-relay-a','session')).toBeNull();expect(await new TeamTaskAssignmentJournal().load('actor-1-relay-b','session')).toBeNull()
})
test('two tabs atomically reserve one intent and cannot remove the winner with another operation',async()=>{
 const a=new TeamTaskAssignmentJournal(),b=new TeamTaskAssignmentJournal(),other={...op,input:{...op.input,request_id:'second'}}
 const results=await Promise.allSettled([a.reserve('scope',op),b.reserve('scope',other)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 const winner=(await a.load('scope','session'))!;await expect(b.remove('scope',winner.input.request_id==='original'?other:op)).rejects.toThrow();expect(await a.load('scope','session')).toEqual(winner)
 await b.reserve('scope',winner);await b.remove('scope',winner);expect(await a.load('scope','session')).toBeNull()
})
test('unknown intent does not expire when a read cache ages out',async()=>{
 const j=new TeamTaskAssignmentJournal();await j.reserve('scope',op);vi.spyOn(Date,'now').mockReturnValue(Date.now()+365*86400000);expect(await j.load('scope','session')).toEqual(op);vi.restoreAllMocks()
})
test('corrupt bytes fail closed instead of being replaced by a new request',async()=>{
 const j=new TeamTaskAssignmentJournal();await j.reserve('scope',op)
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('pocketctl-team-task-assignments-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),r=store.get(JSON.stringify(['scope','session']));r.onsuccess=()=>store.put({...r.result,payload:r.result.payload.replace('goal','tampered')});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})
 await expect(j.load('scope','session')).rejects.toThrow();await expect(j.reserve('scope',op)).rejects.toThrow();db.close()
})
test('invalid target, actor or policy is rejected before writing',async()=>{
 const j=new TeamTaskAssignmentJournal();for(const bad of [{...op,actor:0},{...op,input:{...op.input,target_offer_ids:['offer','offer']}},{...op,input:{...op.input,review_policy:{reviewer_user_id:2,primary_offer_id:'absent',required_checks:[]}}}])await expect(j.reserve('scope',bad)).rejects.toThrow()
 expect(await j.load('scope','session')).toBeNull()
})
