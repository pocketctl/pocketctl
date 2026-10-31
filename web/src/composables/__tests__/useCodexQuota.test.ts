import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useCodexQuota, parseCodexQuota } from '../useCodexQuota'
const wire=vi.hoisted(()=>({handlers:new Set<(e:any)=>void>(),send:vi.fn(),connected:null as any,daemons:null as any,user:null as any}))
vi.mock('../useWebSocket',()=>({useWebSocket:()=>({connected:wire.connected,daemons:wire.daemons,send:wire.send,onEvent:(fn:any)=>{wire.handlers.add(fn);return()=>wire.handlers.delete(fn)}})}))
vi.mock('../useAuth',()=>({useAuth:()=>({user:wire.user})}))
vi.mock('../useEnv',()=>({getRelayWs:()=> 'ws://fixture'}))
let state:any,wrapper:any
const options=ref({sessionId:'s',daemonId:'d',online:true})
function start(){wrapper=mount(defineComponent({setup(){state=useCodexQuota(options);return()=>null}}))}
function emit(e:any){for(const fn of wire.handlers)fn(e)}
function reply(percent=8){const req=wire.send.mock.calls.at(-1)![0];emit({type:'invocation_result',session_id:req.session_id,request_id:req.request_id,invocation:{kind:'codex_rate_limits',scope_id:'a',observed_at:new Date().toISOString(),exhausted:false,buckets:[{id:'codex',name:'Codex',exhausted:false,windows:[{remaining_percent:percent,duration_minutes:10080,resets_at:null}]}]}})}
beforeEach(()=>{vi.useFakeTimers();wire.handlers.clear();wire.connected=ref(true);wire.daemons=ref(new Map());wire.user=ref({id:7});wire.send.mockReset().mockReturnValue(true);options.value={sessionId:'s',daemonId:'d',online:true};Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})})
afterEach(()=>{wrapper?.unmount();vi.useRealTimers()})
test('queries on mount, uses full snapshot and refreshes once per minute',async()=>{start();expect(wire.send).toHaveBeenCalledTimes(1);reply();expect(state.snapshot.value.buckets[0].windows[0].remaining_percent).toBe(8);await vi.advanceTimersByTimeAsync(60000);expect(wire.send).toHaveBeenCalledTimes(2)})
test('coalesces updates and discards obsolete reads after account switch',async()=>{start();const old=wire.send.mock.calls[0][0];emit({type:'codex_rate_limits_changed',session_id:'s',resync:true});emit({type:'invocation_result',session_id:'s',request_id:old.request_id,invocation:{kind:'codex_rate_limits'}});expect(state.snapshot.value).toBeNull();await vi.advanceTimersByTimeAsync(1100);expect(wire.send).toHaveBeenCalledTimes(2);reply(64);expect(state.snapshot.value.buckets[0].windows[0].remaining_percent).toBe(64)})
test('preserves stale data offline and does not query hidden pages',async()=>{start();reply();wire.connected.value=false;await nextTick();expect(state.stale.value).toBe(true);await vi.advanceTimersByTimeAsync(60000);expect(wire.send).toHaveBeenCalledTimes(1);Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});wire.connected.value=true;await nextTick();await vi.advanceTimersByTimeAsync(60000);expect(wire.send).toHaveBeenCalledTimes(1)})
test('isolates account and session changes and ignores late replies',async()=>{start();reply();const old=wire.send.mock.calls[0][0];options.value={sessionId:'other',daemonId:'d',online:true};await nextTick();expect(state.snapshot.value).toBeNull();emit({type:'invocation_result',session_id:'s',request_id:old.request_id,invocation:{kind:'codex_rate_limits'}});expect(state.snapshot.value).toBeNull();reply();wire.user.value={id:8};await nextTick();expect(state.snapshot.value).toBeNull()})
test('times out and a late successful reply cannot revive stale state',async()=>{start();await vi.advanceTimersByTimeAsync(22000);expect(state.loading.value).toBe(false);expect(state.failed.value).toBe(true);reply();expect(state.snapshot.value).toBeNull()})
test('host reads bind responses to the canonical daemon and isolate home selection',async()=>{
 options.value={daemonId:'d',online:true,homeId:'codex-home-aaaaaaaaaaaaaaaaaaaaaaaa'} as any;start()
 const first=wire.send.mock.calls[0][0];expect(first).toEqual({type:'read_codex_host_rate_limits',daemon_id:'d',codex_home_id:'codex-home-aaaaaaaaaaaaaaaaaaaaaaaa',request_id:expect.any(String)});expect(first).not.toHaveProperty('session_id')
 const data={kind:'codex_rate_limits',scope_id:'a',observed_at:new Date().toISOString(),exhausted:false,plan_type:'pro',reset_credits:{available_count:0,credits:[]},buckets:[]}
 emit({type:'invocation_result',daemon_id:'foreign',request_id:first.request_id,invocation:data});expect(state.snapshot.value).toBeNull()
 emit({type:'invocation_result',daemon_id:'d',request_id:first.request_id,invocation:data});expect(state.snapshot.value.plan_type).toBe('pro')
 options.value={...options.value,homeId:'codex-home-bbbbbbbbbbbbbbbbbbbbbbbb'} as any;await nextTick();expect(state.snapshot.value).toBeNull()
 emit({type:'invocation_result',daemon_id:'d',request_id:first.request_id,invocation:data});expect(state.snapshot.value).toBeNull()
 const next=wire.send.mock.calls.at(-1)![0];emit({type:'error',request_id:next.request_id,error:'quota_unavailable'});expect(state.loading.value).toBe(false);expect(state.failed.value).toBe(true)
})

test('keeps the explicit CLI notice optional and validates its values',()=>{
 const base={kind:'codex_rate_limits',scope_id:'a',observed_at:new Date().toISOString(),exhausted:false,buckets:[]}
 expect(parseCodexQuota(base)?.usage_notice).toBeNull()
 const notice={remaining_percent:25,duration_minutes:10080,resets_at:null}
 expect(parseCodexQuota({...base,usage_notice:{...notice,secret:'removed'}})?.usage_notice).toEqual(notice)
 expect(parseCodexQuota({...base,usage_notice:{...notice,remaining_percent:101}})).toBeNull()
})
test('an expired notice hides even when ordinary bucket windows were omitted',async()=>{
 start();const req=wire.send.mock.calls[0][0]
 emit({type:'invocation_result',session_id:'s',request_id:req.request_id,invocation:{kind:'codex_rate_limits',scope_id:'a',status:'ok',observed_at:new Date().toISOString(),exhausted:false,buckets:[],usage_notice:{remaining_percent:8,duration_minutes:10080,resets_at:Math.floor(Date.now()/1000)-1}}})
 expect(state.stale.value).toBe(true)
})
