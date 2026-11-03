import { describe, expect, it } from 'vitest'
import { claimQueue, emptyQueue, mutateQueue, reduceQueueEvent } from '../session-message-queue/state.js'
const enqueue=(s:any,id:string)=>mutateQueue(s,{action:'enqueue',item_id:id,content:`task ${id}`})
const turn=(id:string,status:string)=>({event_type:'turn_status',payload:{turn_id:id,turn_status:status}})
describe('durable personal message queue',()=>{
 it('keeps receipt retries idempotent even after cancellation',()=>{const s=emptyQueue(true,'0');enqueue(s,'a');const v=s.version;enqueue(s,'a');expect(s.version).toBe(v);mutateQueue(s,{action:'cancel',item_id:'a',version:v});enqueue(s,'a');expect(s.items).toHaveLength(0);expect(()=>mutateQueue(s,{action:'enqueue',item_id:'a',content:'changed'})).toThrow('request_id_conflict')})
 it('uses CAS and exact permutations for reorder and protects claimed items',()=>{const s=emptyQueue(false,'0');enqueue(s,'a');enqueue(s,'b');expect(()=>mutateQueue(s,{action:'reorder',version:0,item_ids:['b','a']})).toThrow('queue_changed');mutateQueue(s,{action:'reorder',version:s.version,item_ids:['b','a']});const next=claimQueue(s,true)!;expect(next.id).toBe('b');expect(()=>mutateQueue(s,{action:'cancel',version:s.version,item_id:'b'})).toThrow('already_started');expect(claimQueue(s,true)).toBeUndefined()})
 it('waits for root completion and does not treat child completion as permission',()=>{const s=emptyQueue(true,'0');enqueue(s,'a');expect(claimQueue(s,true)).toBeUndefined();reduceQueueEvent(s,{...turn('child','completed'),payload:{...turn('child','completed').payload,agent_id:'child'}});expect(claimQueue(s,true)).toBeUndefined();reduceQueueEvent(s,turn('root','completed'));expect(claimQueue(s,false)).toBeUndefined();expect(claimQueue(s,true)?.id).toBe('a')})
 it('handles a fast terminal before the correlated dispatch receipt',()=>{const s=emptyQueue(false,'0');enqueue(s,'a');enqueue(s,'b');const a=claimQueue(s,true)!;reduceQueueEvent(s,turn('a-turn','running'));reduceQueueEvent(s,turn('a-turn','completed'));expect(claimQueue(s,true)).toBeUndefined();reduceQueueEvent(s,{event_type:'queue_dispatch_started',payload:{request_id:a.request_id}});expect(s.items.map(i=>i.id)).toEqual(['b']);expect(claimQueue(s,true)?.id).toBe('b')})
 it('crash or lost receipt never re-dispatches an uncertain item',()=>{const s=emptyQueue(false,'0');enqueue(s,'a');claimQueue(s,true,100);expect(claimQueue(s,true,30200)).toBeUndefined();expect(s.items[0].state).toBe('unknown');expect(()=>mutateQueue(s,{action:'resume',version:s.version})).toThrow('execution_unresolved');expect(claimQueue(s,true,99999)).toBeUndefined()})
 it('failed/interrupted execution retains following tasks and requires explicit resume',()=>{const s=emptyQueue(false,'0');enqueue(s,'a');enqueue(s,'b');const a=claimQueue(s,true)!;reduceQueueEvent(s,turn('t','running'));reduceQueueEvent(s,{event_type:'queue_dispatch_started',payload:{request_id:a.request_id}});reduceQueueEvent(s,turn('t','failed'));expect(s.items.map(i=>i.id)).toEqual(['b']);expect(claimQueue(s,true)).toBeUndefined();mutateQueue(s,{action:'resume',version:s.version});expect(claimQueue(s,true)?.id).toBe('b')})
})

it('does not release a newer active turn on a stale terminal', () => {
 const s=emptyQueue(true,'0');enqueue(s,'a')
 reduceQueueEvent(s,turn('current','running'));reduceQueueEvent(s,turn('old','completed'))
 expect(s.busy).toBe(true);expect(claimQueue(s,true)).toBeUndefined()
})
it('late dispatch evidence resolves uncertainty but preserves an explicit stop', () => {
 const s=emptyQueue(false,'0');enqueue(s,'a');enqueue(s,'b');const a=claimQueue(s,true,100)!
 reduceQueueEvent(s,turn('a','running'));claimQueue(s,true,30200)
 reduceQueueEvent(s,turn('a','completed'))
 reduceQueueEvent(s,{event_type:'queue_dispatch_started',payload:{request_id:a.request_id}})
 expect(s.blocked).toBe('');expect(s.items.map(i=>i.id)).toEqual(['b'])
 s.blocked='stopped';expect(claimQueue(s,true)).toBeUndefined()
})
it('rejects native commands and safely treats prototype-shaped IDs as ordinary keys', () => {
 const s=emptyQueue(false,'0')
 expect(()=>mutateQueue(s,{action:'enqueue',item_id:'slash',content:'/compact'})).toThrow('invalid_request')
 enqueue(s,'__proto__');const restored=JSON.parse(JSON.stringify(s));enqueue(restored,'__proto__')
 expect(restored.items).toHaveLength(1);expect(restored.seen.__proto__).not.toContain('task')
})
