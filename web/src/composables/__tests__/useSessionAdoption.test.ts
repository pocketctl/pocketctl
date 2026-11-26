import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useSessionAdoption } from '../useSessionAdoption'

const events = vi.hoisted(() => ({ handler: (_: any) => {}, send:vi.fn(()=>true) }))
vi.mock('../useWebSocket', async () => {
  const {ref}=await import('vue')
  const connected=ref(true)
  return { useWebSocket:()=>({ connected,send:events.send,onEvent:(_:string,cb:typeof events.handler)=>{events.handler=cb;return ()=>{}} }) }
})
let unmount=()=>{}
afterEach(()=>{unmount(); sessionStorage.clear(); events.send.mockClear();vi.useRealTimers()})
function fixture() {
  const scope=ref('owner|host|session'), session=ref('s'), writable=ref(false), fresh=ref(true), refresh=vi.fn()
  let state!:ReturnType<typeof useSessionAdoption>
  const view=mount(defineComponent({setup(){state=useSessionAdoption(scope,session,writable,refresh,fresh);return ()=>h('div')}}))
  unmount=()=>view.unmount()
  const last=()=>events.send.mock.calls.at(-1) as any
  const reply=(phase:string,reason:string,allowed_actions:string[],extra={})=>events.handler({
    type:'session_adoption_result',request_id:last()[0].request_id,session_id:session.value,
    adoption:{version:1,session_id:session.value,revision:1,phase,reason,allowed_actions,...extra}})
  return {scope,session,writable,fresh,refresh,state,last,reply}
}
describe('adoption verification',()=>{
  it('requires positive preflight and suppresses duplicate starts and late replies',()=>{
    const f=fixture()
    expect(f.last()[0].type).toBe('session_adopt_status')
    f.state.issue('adopt');expect(events.send).toHaveBeenCalledTimes(1)
    f.reply('available','eligible',['adopt'])
    const old=f.last()[0].request_id
    f.state.issue('adopt');f.state.issue('adopt')
    expect(events.send).toHaveBeenCalledTimes(2)
    events.handler({type:'session_adoption_result',session_id:'s',request_id:old,error:'forbidden'})
    expect(f.state.state.value).toBe('checking')
    f.reply('blocked','active_writer',['wait'],{operation_id:'a'})
    f.state.issue('wait')
    expect(f.last()[0]).toMatchObject({type:'session_adopt',wait_ms:120000})
    f.reply('waiting','active_writer',['cancel'],{operation_id:'b'})
    f.state.issue('cancel')
    expect(f.last()[0]).toMatchObject({type:'session_adopt_cancel',operation_id:'b'})
  })
  it('rejects old revisions and resets archive consent when scope changes',()=>{
    const f=fixture()
    f.reply('waiting','active_writer',['cancel'],{operation_id:'a',revision:5})
    f.state.issue('query')
    f.reply('blocked','archived',['unarchive'],{operation_id:'a',revision:4})
    expect(f.state.actions.value).toEqual(['cancel'])
    const old=f.last()[0].request_id
    f.state.confirmed.value=true
    f.scope.value=''
    events.handler({type:'session_adoption_result',session_id:'s',request_id:old,error:'forbidden'})
    expect(f.state.confirmed.value).toBe(false);expect(f.state.actions.value).toEqual([])
  })
  it('keeps archive consent on a matching status and closes it when authorization changes',()=>{
    const f=fixture()
    f.reply('blocked','archived',['unarchive'],{operation_id:'a'})
    f.state.confirmed.value=true
    f.state.issue('query');expect(f.state.confirmed.value).toBe(true)
    f.reply('blocked','archived',['unarchive'],{operation_id:'a'})
    expect(f.state.confirmed.value).toBe(true)
    f.state.issue('query')
    events.handler({type:'session_adoption_result',session_id:'s',request_id:f.last()[0].request_id,error:'forbidden'})
    expect(f.state.confirmed.value).toBe(false)
    expect(f.state.actions.value).toEqual([])
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })
  it('rechecks the exact waiting operation after remount without replaying its start',()=>{
    const first=fixture()
    first.reply('waiting','active_writer',['cancel'],{operation_id:'original-operation'})
    unmount()
    const second=fixture()
    expect(second.last()[0]).toMatchObject({type:'session_adopt_status',operation_id:'original-operation'})
  })
  it('fails closed for missing and future receipt versions',()=>{
    const f=fixture()
    f.reply('available','eligible',['adopt'],{version:undefined})
    expect(f.state.actions.value).toEqual(['query'])
    f.state.issue('query')
    f.reply('managed','managed',[],{version:2,local_managed:true,remote_ready:true})
    expect(f.state.state.value).toBe('unverified')
    expect(f.refresh).not.toHaveBeenCalled()
  })
  it('hides new actions during remote rollback while a wait remains cancellable',()=>{
    const f=fixture()
    f.reply('available','eligible',['adopt'],{start_enabled:false})
    expect(f.state.actions.value).toEqual(['query'])
    expect(f.state.state.value).toBe('remote_start_paused')
    f.state.issue('query')
    f.reply('waiting','active_writer',['cancel'],{start_enabled:false,operation_id:'a'})
    expect(f.state.actions.value).toEqual(['cancel'])
  })
  it('does not reuse a pre-disconnect action while its fresh preflight is pending',async()=>{
    const f=fixture()
    f.reply('blocked','archived',['unarchive'])
    f.fresh.value=false
    await nextTick()
    f.fresh.value=true
    await nextTick()
    expect(f.last()[0].type).toBe('session_adopt_status')
    expect(f.state.actions.value).toEqual([])
    f.reply('available','eligible',['adopt'])
    expect(f.state.actions.value).toEqual(['adopt'])
  })
  it('preserves an existing managed composer on an older daemon after its full metadata arrives',async()=>{
    const f=fixture()
    events.handler({type:'session_adoption_result',session_id:'s',request_id:f.last()[0].request_id,error:'daemon_upgrade_required'})
    f.writable.value=true
    await nextTick()
    expect(f.state.blocksComposer.value).toBe(false)
    expect(f.state.notice.value).toBe(false)
  })
  it('keeps a fresh writable row locked until the original operation proves remote readiness',async()=>{
    const f=fixture()
    f.reply('available','eligible',['adopt'])
    f.state.issue('adopt')
    f.writable.value=true
    await nextTick()
    expect(f.state.blocksComposer.value).toBe(true)
    f.reply('binding','',[],{operation_id:'a'})
    expect(f.state.blocksComposer.value).toBe(true)
    f.fresh.value=false
    await nextTick()
    expect(f.state.blocksComposer.value).toBe(true)
    f.fresh.value=true
    await nextTick()
    expect(f.last()[0].operation_id).toBe('a')
    f.reply('managed','managed',[],{operation_id:'a',revision:2,local_managed:true,remote_ready:false})
    expect(f.state.blocksComposer.value).toBe(true)
    f.state.issue('query')
    f.reply('managed','managed',[],{operation_id:'a',revision:3,local_managed:true,remote_ready:true})
    await nextTick()
    expect(f.state.blocksComposer.value).toBe(false)
    expect(f.state.notice.value).toBe(true)
  })
  it('follows a new CLI operation after another client cancels the Web wait in a hidden tab',async()=>{
    vi.useFakeTimers()
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    try {
      const f=fixture()
      f.reply('waiting','active_writer',['cancel'],{operation_id:'web-wait'})
      f.state.issue('query')
      expect(f.last()[0].operation_id).toBe('web-wait')
      f.writable.value=true
      await nextTick()
      f.reply('cancelled','cancelled',[],{operation_id:'web-wait',revision:2})
      expect(f.last()[0]).not.toHaveProperty('operation_id')
      f.reply('cancelled','cancelled',[],{operation_id:'web-wait',revision:2})
      expect(f.state.blocksComposer.value).toBe(true)
      await vi.advanceTimersByTimeAsync(1500)
      expect(f.last()[0]).not.toHaveProperty('operation_id')
      f.reply('managed','managed',[],{operation_id:'cli-wait',revision:1,local_managed:true,remote_ready:true})
      expect(f.state.blocksComposer.value).toBe(false)
      expect(events.send.mock.calls.every(call=>(call as any)[0].type==='session_adopt_status')).toBe(true)
    } finally {visibility.mockRestore()}
  })
  it('bounds read-only reconciliation in hidden tabs with inconsistent writable metadata',async()=>{
    vi.useFakeTimers()
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
    try {
      const f=fixture()
      f.reply('cancelled','cancelled',[],{operation_id:'old'})
      f.writable.value=true
      await nextTick()
      for(let i=0;i<4;i++) {
        f.reply('cancelled','cancelled',[],{operation_id:'old'})
        await vi.advanceTimersByTimeAsync(1500)
      }
      expect(events.send).toHaveBeenCalledTimes(5)
      expect(f.state.blocksComposer.value).toBe(true)
    } finally {visibility.mockRestore()}
  })
  it('refreshes session controls on management without granting write access',()=>{
    const f=fixture()
    f.reply('managed','managed',[],{operation_id:'a',local_managed:true,remote_ready:true})
    expect(f.refresh).toHaveBeenCalledTimes(1);expect(f.writable.value).toBe(false)
  })
})
