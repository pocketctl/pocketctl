import { describe, test, expect, vi } from 'vitest'
import { Router } from '../router.js'
import { classifyDaemonEvent } from '../ingress/event-policy.js'
function socket(): any { return { readyState:1, sent:[] as any[], send(raw: string){this.sent.push(JSON.parse(raw))} } }
function fixture() {
 const router = new Router({ query: vi.fn(async()=>({rows:[]})) } as any)
 const r = router as any, a=socket(), b=socket(), d=socket(), other=socket()
 r.clients.set(a,{userId:7});r.clients.set(b,{userId:7})
 r.daemons.set('d',{ws:d,userId:7,supportsDirectoryBrowse:true})
 r.daemons.set('other',{ws:other,userId:8,supportsDirectoryBrowse:true})
 return {router,r,a,b,d,other}
}
describe('directory query routing',()=>{
 test('private correlated replies and same request ID in multiple tabs',async()=>{
  const {router,r,a,b,d}=fixture()
  for(const client of [a,b])await router.handleClientMessage(client,{type:'list_directories',daemon_id:'d',request_id:'same',path:'~/'} as any)
  expect(d.sent).toHaveLength(2);expect(d.sent[0].request_id).not.toBe(d.sent[1].request_id)
  router.handleDaemonMessage('d',{type:'directory_result',request_id:d.sent[0].request_id,directory:{path:'/home/user',entries:[]}})
  expect(a.sent.at(-1)).toMatchObject({request_id:'same',daemon_id:'d'});expect(b.sent).toHaveLength(0)
  router.unregisterClient(b);expect(r.directoryRequests.size).toBe(0)
 })
 test('foreign/offline hosts never fallback; old daemon gives explicit unsupported',async()=>{
  const {router,r,a,d,other}=fixture()
  for(const id of ['missing','other']){
   await router.handleClientMessage(a,{type:'list_directories',daemon_id:id,request_id:'r',path:'~/'} as any)
   expect(a.sent.at(-1).reason).toBe('daemon_offline')
   await router.handleClientMessage(a,{type:'session_create',daemon_id:id,request_id:'create',agent:'codex'} as any)
   expect(a.sent.at(-1)).toMatchObject({type:'session_create_failed',reason:'daemon_offline'})
  }
  expect(d.sent).toHaveLength(0);expect(other.sent).toHaveLength(0)
  r.daemons.get('d').supportsDirectoryBrowse=false
  await router.handleClientMessage(a,{type:'list_directories',daemon_id:'d',request_id:'r',path:'~/'} as any)
  expect(a.sent.at(-1).reason).toBe('unsupported')
 })
 test('directory payload is ephemeral and cancellation belongs to originating client',async()=>{
  expect(classifyDaemonEvent({type:'directory_result'}).durable).toBe(false)
  const {router,r,a,b,d}=fixture()
  await router.handleClientMessage(a,{type:'list_directories',daemon_id:'d',request_id:'r',path:'~/'} as any)
  await router.handleClientMessage(b,{type:'cancel_directory',daemon_id:'d',request_id:'r'} as any)
  expect(r.directoryRequests.size).toBe(1)
  await router.handleClientMessage(a,{type:'cancel_directory',daemon_id:'d',request_id:'r'} as any)
  expect(r.directoryRequests.size).toBe(0);expect(d.sent.at(-1).type).toBe('cancel_directory')
 })
})
