import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import ShareLinkManager from '../src/components/sharing/ShareLinkManager.vue'
import { useAuth } from '../src/composables/useAuth'
import { useLocale } from '../src/composables/useLocale'
import { shareLinksAPI } from '../src/services/shareLinks'
// Happy DOM has no deployment origin. Only supply that origin; every API response
// comes from the real, isolated Docker Web proxy + Relay + PostgreSQL stack.
vi.mock('../src/composables/useEnv',()=>({getRelayOrigin:()=> 'http://127.0.0.1:18983'}))
test.skipIf(process.env.POCKETCTL_SHARE_DOCKER!=='1')('real component opens, creates, reopens without renewal, copies and revokes through Docker',async()=>{
 const saved=JSON.parse(readFileSync('/tmp/share-docker-auth.json','utf8'))
 const claims=JSON.parse(Buffer.from(saved.token.split('.')[1],'base64url').toString())
 expect(claims.email).toBe('share-acceptance@pocketctl.local')
 const {user,accessToken}=useAuth();user.value={id:claims.userId,email:claims.email,phone:null,display_name:'Docker acceptance'};accessToken.value=saved.token
 useLocale().setLocale('zh')
 Object.defineProperty(navigator,'clipboard',{value:{writeText:vi.fn().mockResolvedValue(undefined)},configurable:true})
 const before=await shareLinksAPI.list('share-docker-session')
 const fetchSpy=vi.spyOn(globalThis,'fetch')
 let wrapper=mount(ShareLinkManager,{props:{sessionId:'share-docker-session'},attachTo:document.body})
 const until=(assertion:()=>void)=>vi.waitFor(assertion,{timeout:10000,interval:20})
 try{
  await until(()=>expect(wrapper.find('.share-list-heading').exists()).toBe(true))
  await until(()=>expect(wrapper.findAll('.share-row')).toHaveLength(before.links.length))
  expect(fetchSpy.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0)
  const create=wrapper.findAll('button').find(b=>b.text().includes('生成新链接'))!
  await create.trigger('click')
  await until(()=>expect(wrapper.findAll('.share-row')).toHaveLength(before.links.length+1))
  const after=await shareLinksAPI.list('share-docker-session'),created=after.links.find(x=>!before.links.some(y=>y.id===x.id))!
  expect(created).toBeDefined();expect(Date.parse(created.expires_at)-Date.parse(created.created_at)).toBe(900000)
  wrapper.unmount()
  wrapper=mount(ShareLinkManager,{props:{sessionId:'share-docker-session'},attachTo:document.body})
  await until(()=>expect(wrapper.find('.share-list-heading').exists()).toBe(true))
  await until(()=>expect(wrapper.findAll('.share-row')).toHaveLength(after.links.length))
  expect(fetchSpy.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1)
  const createdRow=wrapper.findAll('.share-row').find(r=>r.text().includes(created.id.slice(0,8)))!
  const choose=createdRow.findAll('button').find(b=>b.text()==='使用此链接')!
  if(choose.attributes('disabled')===undefined)await choose.trigger('click')
  await wrapper.find('.share-selected button').trigger('click')
  await until(()=>expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1))
  const url=vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]
  expect((await shareLinksAPI.get(created.id)).expires_at).toBe(created.expires_at)
  expect((await fetch(url)).status).toBe(200)
  await createdRow.findAll('button').find(b=>b.text()==='撤销')!.trigger('click')
  await until(()=>expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true))
  await wrapper.findAll('[role="alertdialog"] button').find(b=>b.text()==='取消')!.trigger('click')
  expect((await shareLinksAPI.get(created.id)).status).toBe('active')
  await createdRow.findAll('button').find(b=>b.text()==='撤销')!.trigger('click')
  await wrapper.findAll('[role="alertdialog"] button').find(b=>b.text()==='撤销')!.trigger('click')
  await until(()=>expect(wrapper.findAll('.share-row')).toHaveLength(before.links.length))
  expect((await shareLinksAPI.get(created.id)).status).toBe('revoked')
  expect((await fetch(url)).status).toBe(404)
  expect((await shareLinksAPI.list('share-docker-session')).links.every(r=>r.id!==created.id)).toBe(true)
 }finally{wrapper.unmount();fetchSpy.mockRestore();localStorage.clear()}
})
