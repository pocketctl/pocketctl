import {it,expect,vi} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {defineComponent} from 'vue'
import {usePersonalUsage} from '../../composables/usePersonalUsage'
import fixture from '../../../../tests/fixtures/usage-analytics/personal-v1.json'
vi.mock('../../composables/useAuth',async()=>{const {ref}=await import('vue');return {useAuth:()=>({accessToken:ref('fixture'),apiGetAuth:async(url:string)=>{const r=await fetch(url);return {ok:r.ok,data:await r.json()}}})}})
it('discards the previous scope response arriving after the new scope',async()=>{
 let release!:(v:unknown)=>void;const old=new Promise(r=>release=r);vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('daemon=old')?old:{...structuredClone(fixture.dashboard),hosts:[{daemon_id:'new',name:'New',historical:false}]}})))
 let u!:ReturnType<typeof usePersonalUsage>;const w=mount(defineComponent({setup(){u=usePersonalUsage('old');void u.load();return()=>''}}));u.daemon.value='new';await flushPromises();expect(u.dashboard.value?.hosts[0]?.name).toBe('New');release({...fixture.dashboard,hosts:[{daemon_id:'old',name:'Old',historical:false}]});await flushPromises();expect(u.dashboard.value?.hosts[0]?.name).toBe('New');w.unmount()
})
it('I11 rejects delayed detail from an earlier scope and earlier detail request',async()=>{
 let release!:(v:unknown)=>void;const old=new Promise(r=>release=r);vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('/slow')?old:structuredClone(fixture.dashboard)})))
 let u!:ReturnType<typeof usePersonalUsage>;const w=mount(defineComponent({setup(){u=usePersonalUsage('old');return()=>''}}));await u.load();const pending=u.detail('/slow').then(()=>false,()=>true);u.daemon.value='new';await flushPromises();release(fixture.dashboard);expect(await pending).toBe(true);w.unmount()
})
