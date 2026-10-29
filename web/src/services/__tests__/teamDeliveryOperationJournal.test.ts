import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { validDeliveryIntent, TeamDeliveryOperationJournal, type DeliveryIntent } from '../teamDeliveryOperationJournal'
const op:DeliveryIntent={task:'task',actor:1,operation:{kind:'acceptance',input:{request_id:'original',expected_revision:2,spec_revision:1,submission_id:'submission',decision:'changes_requested',reason:'proof',verified_checks:[]}}}
const execute:DeliveryIntent={task:'task',actor:1,operation:{kind:'execute_task',session:'session',input:{request_id:'execute',expected_revision:2,spec_revision:1,context_version:6,target_offer_ids:['offer']}}}
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto)})
afterEach(()=>vi.unstubAllGlobals())
test('durable record survives new instances and isolates accounts, origins and tasks',async()=>{
 await new TeamDeliveryOperationJournal().reserve('account-a-origin-a',op)
 expect(await new TeamDeliveryOperationJournal().load('account-a-origin-a','task')).toEqual([op])
 for(const [scope,task] of [['account-b-origin-a','task'],['account-a-origin-b','task'],['account-a-origin-a','other']])expect(await new TeamDeliveryOperationJournal().load(scope,task)).toEqual([])
})
test('closing a controller connection preserves pending intents for a new controller',async()=>{
 const a=new TeamDeliveryOperationJournal();await a.reserve('scope',op);a.close()
 await expect(a.load('scope','task')).rejects.toThrow('关闭')
 expect(await new TeamDeliveryOperationJournal().load('scope','task')).toEqual([op])
})
test('simultaneous acceptance and execution from separate tabs reserve only one task operation',async()=>{
 const a=new TeamDeliveryOperationJournal(),b=new TeamDeliveryOperationJournal()
 const results=await Promise.allSettled([a.reserve('scope',op),b.reserve('scope',execute)])
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 const [winner]=await a.load('scope','task'),loser=winner.operation.kind==='acceptance'?execute:op
 await expect(b.reserve('scope',loser)).rejects.toThrow();await expect(b.remove('scope',loser)).rejects.toThrow()
 expect(await a.load('scope','task')).toEqual([winner]);await b.remove('scope',winner);expect(await a.load('scope','task')).toEqual([])
})
test('legacy migration preserves both old operations without permitting a new write',async()=>{
 const a=new TeamDeliveryOperationJournal(),b=new TeamDeliveryOperationJournal()
 await Promise.all([a.importLegacy('scope','task',[op,execute]),b.importLegacy('scope','task',[op,execute])])
 expect(await a.load('scope','task')).toEqual([op,execute])
 await expect(a.reserve('scope',{...op,operation:{...op.operation,input:{...op.operation.input,request_id:'third'}}} as DeliveryIntent)).rejects.toThrow()
 await a.remove('scope',op);expect(await b.load('scope','task')).toEqual([execute]);await b.remove('scope',execute)
})
test('altered payload fails closed on load, reserve and remove',async()=>{
 const j=new TeamDeliveryOperationJournal();await j.reserve('scope',op)
 const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('pocketctl-team-delivery-operations-v1');r.onsuccess=()=>resolve(r.result)})
 await new Promise<void>(resolve=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),r=store.get(JSON.stringify(['scope','task']));r.onsuccess=()=>store.put({...r.result,payload:r.result.payload.replace('proof','tampered')});tx.oncomplete=()=>resolve()})
 await expect(j.load('scope','task')).rejects.toThrow();await expect(j.reserve('scope',execute)).rejects.toThrow();await expect(j.remove('scope',op)).rejects.toThrow();db.close()
})
test('capacity rejects new tasks without evicting unresolved records',async()=>{
 const j=new TeamDeliveryOperationJournal();await j.importLegacy('scope','task',[op,execute])
 const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('pocketctl-team-delivery-operations-v1');r.onsuccess=()=>resolve(r.result)})
 await new Promise<void>(resolve=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents');for(let n=0;n<511;n++)store.put({key:'other-'+n,payload:'reserved'});tx.oncomplete=()=>resolve()})
 await expect(j.reserve('scope',{...op,task:'new'})).rejects.toThrow('上限');expect(await j.load('scope','task')).toEqual([op,execute])
 await j.remove('scope',op);expect(await j.load('scope','task')).toEqual([execute]);db.close()
})
test('invalid operation and unavailable browser storage cannot reserve',async()=>{
 const j=new TeamDeliveryOperationJournal();await expect(j.reserve('scope',{...execute,operation:{...execute.operation,session:''}} as DeliveryIntent)).rejects.toThrow()
 vi.stubGlobal('indexedDB',undefined);await expect(new TeamDeliveryOperationJournal().reserve('scope',op)).rejects.toThrow();
})

test('reconcile journal preserves the original attempt Call and runtime expectation',async()=>{
 const intent:DeliveryIntent={task:'task',actor:1,operation:{kind:'plan_control',expectedState:'cancelled',expectedCallId:'original',input:{request_id:'reconcile',expected_revision:3,plan_revision:1,action:'reconcile',attempt_id:'aaaaaaaa-1111-4111-8111-111111111111'}}}
 await new TeamDeliveryOperationJournal().reserve('a',intent)
 expect(await new TeamDeliveryOperationJournal().load('a','task')).toEqual([intent])
 const wrong=structuredClone(intent);if(wrong.operation.kind==='plan_control')delete wrong.operation.expectedCallId
 await expect(new TeamDeliveryOperationJournal().reserve('b',wrong)).rejects.toThrow()
})

test('step retry journal rejects missing delivery CAS and preserves exact request',async()=>{
 const intent:DeliveryIntent={task:'task',actor:1,operation:{kind:'plan_control',expectedState:'active',expectedCallId:'original',input:{request_id:'retry',expected_revision:3,plan_revision:1,action:'retry',attempt_id:'aaaaaaaa-1111-4111-8111-111111111111',expected_delivery_revision:4}}}
 await new TeamDeliveryOperationJournal().reserve('a',intent);expect(await new TeamDeliveryOperationJournal().load('a','task')).toEqual([intent])
 const wrong=structuredClone(intent);if(wrong.operation.kind==='plan_control')delete wrong.operation.input.expected_delivery_revision
 await expect(new TeamDeliveryOperationJournal().reserve('b',wrong)).rejects.toThrow()
})

test('only activation can persist revision zero and an explicit bounded call budget',()=>{
 const intent:any={task:'task',actor:1,operation:{kind:'plan_control',input:{request_id:'activate',expected_revision:0,plan_revision:2,action:'activate',invocation_limit:3}}}
 expect(validDeliveryIntent(intent)).toBe(true)
 for(const patch of [{invocation_limit:0},{invocation_limit:129},{invocation_limit:1.5},{invocation_limit:undefined},{expected_revision:1},{action:'resume'}])expect(validDeliveryIntent({...intent,operation:{...intent.operation,input:{...intent.operation.input,...patch}}})).toBe(false)
})

test('activation persists exact optional budgets and rejects reset and unknown budget fields',async()=>{
 const intent:any={task:'task',actor:1,operation:{kind:'plan_control',input:{request_id:'budget',expected_revision:0,plan_revision:2,action:'activate',invocation_limit:3,budget:{max_concurrent_calls:2,max_duration_seconds:3600,token_warning_limit:1000000000000}}}}
 await new TeamDeliveryOperationJournal().reserve('budget',intent)
 expect(await new TeamDeliveryOperationJournal().load('budget','task')).toEqual([intent])
 for(const budget of [{max_concurrent_calls:33},{max_duration_seconds:604801},{token_warning_limit:0},{token_warning_limit:1.5},{hard_token_limit:1},null])expect(validDeliveryIntent({...intent,operation:{...intent.operation,input:{...intent.operation.input,budget}}})).toBe(false)
 expect(validDeliveryIntent({...intent,operation:{...intent.operation,input:{...intent.operation.input,action:'resume',expected_revision:1,invocation_limit:undefined}}})).toBe(false)
})

test('confirmed task revision survives storage; malformed revisions are rejected',async()=>{
 const current=structuredClone(execute)
 if(current.operation.kind!=='execute_task')throw Error('fixture')
 current.operation.input.expected_task_revision=12
 await new TeamDeliveryOperationJournal().reserve('scope',current)
 expect(await new TeamDeliveryOperationJournal().load('scope','task')).toEqual([current])
 for(const bad of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  current.operation.input.expected_task_revision=bad
  expect(validDeliveryIntent(current)).toBe(false)
 }
 expect(validDeliveryIntent(execute)).toBe(true) // Old pending receipts must remain recoverable.
})

test('accepted successor persists exact original identity and reason across journal reopening',async()=>{
 const intent:DeliveryIntent={task:'task',actor:1,operation:{kind:'plan_control',expectedState:'active',expectedCallId:'original',input:{request_id:'new-version',expected_revision:3,plan_revision:1,action:'new_version',attempt_id:'aaaaaaaa-1111-4111-8111-111111111111',expected_delivery_revision:4,reason:'补齐证明'}}}
 const journal=new TeamDeliveryOperationJournal();await journal.reserve('scope',intent);journal.close()
 const reopened=new TeamDeliveryOperationJournal();expect(await reopened.load('scope','task')).toEqual([intent]);reopened.close()
 for(const reason of [undefined,'',' ', 'x'.repeat(1001),'bad\0reason']){
  const invalid=structuredClone(intent);if(invalid.operation.kind==='plan_control')invalid.operation.input.reason=reason
  expect(validDeliveryIntent(invalid)).toBe(false)
 }
})
