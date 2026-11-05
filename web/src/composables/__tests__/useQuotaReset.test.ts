import {mount} from '@vue/test-utils'
import {defineComponent,ref,nextTick} from 'vue'
import {test,expect,vi,beforeEach,afterEach} from 'vitest'
import QuotaResetActions from '../../components/session/QuotaResetActions.vue'
import {useLocale} from '../useLocale'
import {useQuotaReset} from '../useQuotaReset'
const wire=vi.hoisted(()=>({send:vi.fn(),handlers:new Set<(e:any)=>void>()}))
vi.mock('../useWebSocket',()=>({useWebSocket:()=>({send:wire.send,onEvent:(f:any)=>{wire.handlers.add(f);return()=>wire.handlers.delete(f)}})}))
vi.mock('../useAuth',()=>({useAuth:()=>({user:ref({id:7})})}))
vi.mock('../useEnv',()=>({getRelayWs:()=> 'ws://fixture'}))
let wrapper:any,state:any;const opts=ref({daemonId:'d',scopeId:'a'.repeat(32),provider:'zcode' as 'zcode'|'codex',enabled:true,online:true,homeId:''})
function start(){wrapper=mount(defineComponent({setup(){state=useQuotaReset(opts);return()=>null}}))}
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();wire.handlers.clear();wire.send.mockReset().mockReturnValue(true);opts.value={daemonId:'d',scopeId:'a'.repeat(32),provider:'zcode',enabled:true,online:true,homeId:''}})
afterEach(()=>{wrapper?.unmount();vi.useRealTimers()})
test('persists before sending and never creates a second operation after timeout or remount',async()=>{
 start();state.submit('WEEK');const cmd=wire.send.mock.calls[0][0];expect(cmd).toMatchObject({type:'consume_zcode_reset_credit',quota_scope_id:'a'.repeat(32),reset_type:'WEEK'});expect(localStorage.length).toBe(1)
 await vi.advanceTimersByTimeAsync(22000);expect(state.phase.value).toBe('unknown');state.submit('FIVE_HOUR');expect(wire.send).toHaveBeenCalledTimes(1)
 wrapper.unmount();start();await nextTick();expect(wire.send.mock.calls.at(-1)![0]).toMatchObject({type:'read_quota_reset_result',idempotency_key:cmd.idempotency_key})
})
test('requires canonical daemon and scope; confirmed success does not infer a quota value',()=>{
 start();state.submit('WEEK');const req=wire.send.mock.calls[0][0]
 const emit=(daemon_id:string,scope_id:string)=>{for(const h of wire.handlers)h({type:'invocation_result',daemon_id,request_id:req.request_id,invocation:{kind:'quota_reset',scope_id,outcome:'reset'}})}
 emit('other','a'.repeat(32));expect(state.phase.value).toBe('submitting');emit('d','b'.repeat(32));expect(state.phase.value).toBe('submitting');emit('d','a'.repeat(32));expect(state.phase.value).toBe('success')
})
test('never automatically redeems on recovery and disables stale data submissions',()=>{opts.value.enabled=false;start();state.submit('WEEK');expect(wire.send).not.toHaveBeenCalled()})

test('opens a separate alertdialog and spends only after explicit second confirmation',async()=>{
 useLocale().setLocale('en')
 wrapper=mount(QuotaResetActions,{attachTo:document.body,props:{provider:'zcode',daemonId:'d',scopeId:'a'.repeat(32),hostname:'Mac',accountLabel:'Current account',supported:true,online:true,stale:false,showCounts:true,choices:[{type:'WEEK',label:'Weekly reset credit',count:3,expires:[1797955199]}]}})
 await wrapper.get('.reset-use').trigger('click');await nextTick()
 expect(wire.send).not.toHaveBeenCalled();const cancel=document.querySelector<HTMLButtonElement>('[role="alertdialog"] footer button')!;cancel.click();await nextTick();expect(wire.send).not.toHaveBeenCalled()
 await wrapper.get('.reset-use').trigger('click');await nextTick();document.querySelector<HTMLButtonElement>('[role="alertdialog"] footer .primary')!.click();await nextTick()
 expect(wire.send).toHaveBeenCalledTimes(1);expect(wire.send.mock.calls[0][0]).toMatchObject({type:'consume_zcode_reset_credit',reset_type:'WEEK'})
})
test('explicit Codex recovery reuses the original key even after no credits remain',async()=>{
 opts.value.provider='codex';start();state.submit('codex');const original=wire.send.mock.calls[0][0];await vi.advanceTimersByTimeAsync(22000)
 opts.value.enabled=false;(opts.value as any).recoverable=true;await nextTick();state.retryOriginal()
 expect(wire.send.mock.calls.at(-1)![0]).toMatchObject({type:'consume_codex_reset_credit',idempotency_key:original.idempotency_key})
 expect(wire.send.mock.calls.at(-1)![0].request_id).not.toBe(original.request_id)
})
