import { describe, test, expect, vi } from 'vitest'
import { Router } from '../router.js'
import { classifyDaemonEvent } from '../ingress/event-policy.js'
function socket(): any { return {readyState:1,sent:[] as any[],send(raw:string){this.sent.push(JSON.parse(raw))}} }
function fixture(){
 const query=vi.fn(async(sql:string,params:any[]=[])=>({rows:sql.includes('WITH owned_session')&&params[0]==='s'&&params[1]===7?[{daemon_id:'d',agent_type:'codex',control_mode:'managed',source:'daemon',status:'idle',capabilities:[]}]:[]}))
 const pool:any={query};pool.connect=vi.fn(async()=>({query,release:vi.fn()}))
 const router=new Router(pool),r=router as any,a=socket(),b=socket(),d=socket()
 router.registerClient(a,7);router.registerClient(b,7);r.daemons.set('d',{ws:d,userId:7});r.sessionToDaemon.set('s','d')
 return {router,r,a,b,d,query}
}
describe('Codex invocation routing',()=>{
 test('isolates colliding tab IDs and deduplicates same-client retries',async()=>{
  const {router,r,a,b,d}=fixture();const msg={type:'invoke_command',session_id:'s',request_id:'same',content:'/pwd'}
  for(const client of [a,b,a])await router.handleClientMessage(client,msg)
  expect(d.sent).toHaveLength(2);expect(d.sent[0].request_id).not.toBe(d.sent[1].request_id)
  router.handleDaemonMessage('d',{type:'invocation_result',session_id:'s',request_id:d.sent[0].request_id,invocation:{kind:'text',text:'/repo'}})
  expect(a.sent.at(-1)).toMatchObject({type:'invocation_result',request_id:'same'});expect(b.sent).toHaveLength(0)
  await router.handleClientMessage(a,msg);expect(d.sent).toHaveLength(2);expect(a.sent).toHaveLength(2)
  await router.handleClientMessage(a,{...msg,content:'/compact'});expect(a.sent.at(-1).error).toBe('request_id_conflict')
  router.unregisterClient(a);router.unregisterClient(b);expect(r.invocationRequests.size).toBe(0)
 })
 test('rejects unowned sessions and never routes offline requests elsewhere',async()=>{
  const {router,r,a,d}=fixture()
  await router.handleClientMessage(a,{type:'list_invocations',session_id:'other',request_id:'1'});expect(d.sent).toHaveLength(0)
  r.daemons.delete('d');await router.handleClientMessage(a,{type:'invoke_command',session_id:'s',request_id:'2',content:'/review'});expect(d.sent).toHaveLength(0)
  expect(a.sent.at(-1)).toMatchObject({type:'invocation_result',request_id:'2',code:'daemon_unreachable'})
 })
 test('rejects fork sources outside the selected owned host',async()=>{
  const {router,a,d}=fixture()
  await router.handleClientMessage(a,{type:'session_create',request_id:'fork-1',daemon_id:'d',agent:'codex',cwd:'/repo',fork_from:'foreign'})
  expect(d.sent).toHaveLength(0);expect(a.sent.at(-1)).toMatchObject({type:'session_create_failed',reason:'invalid_fork_source'})
 })
 test('does not persist native directory and export payloads',()=>{expect(classifyDaemonEvent({type:'invocation_result',session_id:'s'}).durable).toBe(false)})
})
