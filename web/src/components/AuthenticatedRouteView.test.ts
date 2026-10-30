import { computed, defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import AuthenticatedRouteView from './AuthenticatedRouteView.vue'
import MemorySearchPanel from './memory/MemorySearchPanel.vue'
const user=ref<{id:number}|null>({id:1}), token=ref('a'), offline=ref(false)
vi.mock('../composables/useAuth',()=>({useAuth:()=>({user,accessToken:token,isLoggedIn:computed(()=>!!user.value&&!!token.value),canReadOfflineTeams:offline})}))
vi.mock('../composables/useLocale',()=>({useLocale:()=>({t:(s:string)=>s})}))
const search=vi.hoisted(()=>vi.fn())
vi.mock('../services/memoryClient',async()=>({...await vi.importActual('../services/memoryClient'),searchMemory:search}))
const hit={claimId:'c',versionId:'v',statement:'PRIVATE MEMORY TEXT',claimType:'work_method',scopeKind:'installation',scopeKey:'global',score:1,authority:'user_accepted'}
const page=defineComponent({components:{MemorySearchPanel},template:'<MemorySearchPanel />'})
async function render(){
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/memory',component:page,meta:{requiresAuth:true}},{path:'/teams',component:{template:'<p>Offline team outbox</p>'},meta:{requiresAuth:true}},{path:'/login',component:{template:'<p>Login required</p>'}}]})
 await router.push('/memory');await router.isReady()
 const view=mount(AuthenticatedRouteView,{global:{plugins:[router]}});await flushPromises()
 await view.get('[data-testid=memory-search-input]').setValue('private');await view.get('form').trigger('submit');await flushPromises()
 return{view,router}
}
beforeEach(()=>{user.value={id:1};token.value='a';offline.value=false;search.mockReset().mockResolvedValue({hits:[hit],nextCursor:null,degradedComponents:[],poolSizes:{}})})
test('revocation clears rendered Memory without a click or reload and redirects to login',async()=>{
 const {view,router}=await render();expect(view.text()).toContain(hit.statement)
 user.value=null;token.value='';await flushPromises();expect(view.text()).not.toContain(hit.statement);expect(router.currentRoute.value.path).toBe('/login');view.unmount()
})
test('a late Memory search cannot restore content after revocation',async()=>{
 let finish!:(v:any)=>void;search.mockReturnValueOnce(new Promise(resolve=>finish=resolve))
 const {view}=await render();user.value=null;token.value='';await flushPromises();finish({hits:[hit],nextCursor:null,degradedComponents:[],poolSizes:{}});await flushPromises();expect(view.text()).not.toContain(hit.statement);view.unmount()
})
test('account switch disposes the old search view',async()=>{
 const {view}=await render();expect(view.text()).toContain(hit.statement)
 user.value={id:2}
 await flushPromises();expect(view.text()).not.toContain(hit.statement);view.unmount()
})
test('offline Team outbox remains available while personal Memory is unmounted',async()=>{
 const {view,router}=await render();offline.value=true;token.value='';await flushPromises();expect(view.text()).not.toContain(hit.statement);expect(router.currentRoute.value.path).toBe('/teams');expect(view.text()).toContain('Offline team outbox');view.unmount()
})
test('routine access token rotation preserves the current view',async()=>{
 const {view}=await render();token.value='rotated';await flushPromises();expect(view.text()).toContain(hit.statement);view.unmount()
})
