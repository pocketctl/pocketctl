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

describe('Codex quota private reads',()=>{
 test('correlates read results only to the requesting owner and rejects foreign sessions',async()=>{
  const {router,a,b,d}=fixture()
  await router.handleClientMessage(a,{type:'read_codex_rate_limits',session_id:'s',request_id:'quota-read'})
  expect(d.sent[0]?.request_id).not.toBe('quota-read')
  router.handleDaemonMessage('d',{type:'invocation_result',session_id:'s',request_id:d.sent[0]?.request_id,invocation:{kind:'codex_rate_limits',buckets:[]}})
  expect(a.sent.at(-1)).toMatchObject({request_id:'quota-read',invocation:{kind:'codex_rate_limits'}})
  expect(b.sent).toHaveLength(0)
  await router.handleClientMessage(b,{type:'read_codex_rate_limits',session_id:'foreign',request_id:'denied'})
  expect(b.sent.at(-1)).toMatchObject({type:'invocation_result',error:'session not found or not owned'})
  expect(d.sent).toHaveLength(1)
  router.unregisterClient(a);router.unregisterClient(b)
 })
 test('never persists quota invalidations as history',()=>{
  expect(classifyDaemonEvent({type:'codex_rate_limits_changed',session_id:'s',resync:true}).durable).toBe(false)
 })
 test('broadcasts only a sanitized invalidation to the owner, never account payloads',async()=>{
  const {router,r,a,b}=fixture(); const foreign=socket();router.registerClient(foreign,8)
  vi.spyOn(r,'authorizeEphemeralTitleSession').mockResolvedValue(true)
  router.handleDaemonMessage('d',{type:'codex_rate_limits_changed',session_id:'s',resync:true,secret:'account'})
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(a.sent.at(-1)).toEqual({type:'codex_rate_limits_changed',session_id:'s',daemon_id:'d',resync:true})
  expect(b.sent.at(-1)).toEqual(a.sent.at(-1));expect(foreign.sent).toHaveLength(0)
  router.unregisterClient(a);router.unregisterClient(b);router.unregisterClient(foreign)
 })
})

describe('ZCode host quota private reads',()=>{
 test('reads without a session and returns only to the owner tab with canonical host identity',async()=>{
  const {router,r,a,b,d}=fixture()
  await router.handleClientMessage(a,{type:'read_zcode_quota',daemon_id:'d',request_id:'host-quota',url:'https://attacker.invalid'})
  expect(d.sent).toHaveLength(1)
  expect(d.sent[0]).toEqual({type:'read_zcode_quota',request_id:expect.any(String)})
  expect(d.sent[0].request_id).not.toBe('host-quota')
  router.handleDaemonMessage('d',{type:'invocation_result',request_id:d.sent[0].request_id,daemon_id:'forged',invocation:{kind:'zcode_quota'}})
  expect(a.sent.at(-1)).toMatchObject({type:'invocation_result',request_id:'host-quota',daemon_id:'d',invocation:{kind:'zcode_quota'}})
  expect(b.sent).toHaveLength(0)
  await router.handleClientMessage(a,{type:'read_zcode_quota',daemon_id:'d',request_id:'host-quota'})
  expect(d.sent).toHaveLength(1)
  router.unregisterClient(a);router.unregisterClient(b);expect(r.invocationRequests.size).toBe(0)
 })
 test('rejects foreign hosts and client supplied session references',async()=>{
  const {router,r,a,d}=fixture();const foreign=socket();router.registerClient(foreign,8)
  for(const msg of [{type:'read_zcode_quota',daemon_id:'d',request_id:'foreign'},{type:'read_zcode_quota',daemon_id:'d',session_id:'s',request_id:'session'}]){
   await router.handleClientMessage(msg.request_id==='foreign'?foreign:a,msg)
  }
  expect(d.sent).toHaveLength(0);expect(foreign.sent.at(-1)).toMatchObject({type:'invocation_result',error:'forbidden'})
  expect(a.sent.at(-1)).toMatchObject({type:'invocation_result',error:'invalid_request'})
  r.daemons.delete('d');await router.handleClientMessage(a,{type:'read_zcode_quota',daemon_id:'d',request_id:'offline'})
  expect(a.sent.at(-1)).toMatchObject({type:'invocation_result',error:'daemon_unreachable'})
  router.unregisterClient(a);router.unregisterClient(foreign)
 })
 test('drops results from another daemon connection',async()=>{
  const {router,r,a,d}=fixture();await router.handleClientMessage(a,{type:'read_zcode_quota',daemon_id:'d',request_id:'origin'})
  const pending=d.sent[0]?.request_id
  r.daemons.set('other',{ws:socket(),userId:7})
  router.handleDaemonMessage('other',{type:'invocation_result',request_id:pending,invocation:{kind:'zcode_quota'}})
  expect(a.sent).toHaveLength(0)
  r.daemons.set('d',{ws:socket(),userId:7});router.handleDaemonMessage('d',{type:'invocation_result',request_id:pending,invocation:{kind:'zcode_quota'}})
  expect(a.sent).toHaveLength(0);router.unregisterClient(a)
 })
})

describe('Codex host quota private reads',()=>{
 test('allows an owner to read an allowlisted home without a session and strips credit/account identifiers',async()=>{
  const {router,a,b,d}=fixture(),home='codex-home-aaaaaaaaaaaaaaaaaaaaaaaa'
  await router.handleClientMessage(a,{type:'read_codex_host_rate_limits',daemon_id:'d',codex_home_id:home,request_id:'host',url:'https://invalid.example'})
  expect(d.sent[0]).toEqual({type:'read_codex_host_rate_limits',codex_home_id:home,request_id:expect.any(String)})
  router.handleDaemonMessage('d',{type:'invocation_result',request_id:d.sent[0].request_id,invocation:{kind:'codex_rate_limits',scope_id:'scope',observed_at:'2026-10-31T00:00:00Z',status:'ok',plan_type:'pro',exhausted:false,usage_notice:{remaining_percent:25,duration_minutes:10080,resets_at:null,private:'secret-notice'},accountId:'secret-account',buckets:[{id:'codex',name:'Codex',plan_type:'pro',exhausted:false,windows:[{remaining_percent:70,duration_minutes:10080,resets_at:null}]}],reset_credits:{available_count:2,credits:[{id:'secret-credit',expires_at:null}]}}})
  const reply=a.sent.at(-1);expect(reply).toMatchObject({daemon_id:'d',request_id:'host',invocation:{plan_type:'pro',usage_notice:{remaining_percent:25,duration_minutes:10080,resets_at:null},reset_credits:{available_count:2,credits:[{expires_at:null}]}}});expect(JSON.stringify(reply)).not.toMatch(/secret-credit|secret-account|secret-notice/);expect(b.sent).toHaveLength(0)
  router.unregisterClient(a);router.unregisterClient(b)
 })
 test('rejects other owners, arbitrary home paths and session references',async()=>{
  const {router,a,d}=fixture(),foreign=socket();router.registerClient(foreign,8)
  await router.handleClientMessage(foreign,{type:'read_codex_host_rate_limits',daemon_id:'d',request_id:'foreign'});expect(foreign.sent.at(-1)).toMatchObject({error:'forbidden'})
  for(const extras of [{codex_home_id:'/tmp/credential'},{session_id:'s'}]){await router.handleClientMessage(a,{type:'read_codex_host_rate_limits',daemon_id:'d',request_id:'invalid',...extras});expect(a.sent.at(-1)).toMatchObject({error:'invalid_request'})}
  expect(d.sent).toHaveLength(0);router.unregisterClient(a);router.unregisterClient(foreign)
 })
 test('host invalidations contain only scope and reach only the owner',async()=>{
  const {router,a,b}=fixture(),foreign=socket();router.registerClient(foreign,8)
  router.handleDaemonMessage('d',{type:'codex_rate_limits_changed',codex_home_id:'home',resync:true,accountId:'secret'})
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(a.sent.at(-1)).toEqual({type:'codex_rate_limits_changed',codex_home_id:'home',daemon_id:'d',resync:true});expect(b.sent.at(-1)).toEqual(a.sent.at(-1));expect(foreign.sent).toHaveLength(0)
  router.unregisterClient(a);router.unregisterClient(b);router.unregisterClient(foreign)
 })
})
