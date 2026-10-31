import {mount,flushPromises} from '@vue/test-utils'
import {ref} from 'vue'
import {beforeEach,expect,test,vi} from 'vitest'
import zh from '../../i18n/zh.json'
import MemoryGitProjectSetup from './MemoryGitProjectSetup.vue'
const api=vi.hoisted(()=>({project:vi.fn(),connectProject:vi.fn(),disconnectProject:vi.fn(),initialize:vi.fn(),linkIdentity:vi.fn()}))
const user=ref({id:3})
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>''}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>(zh as Record<string,string>)[key]??key})}))
vi.mock('../../services/memoryGit',()=>({memoryGit:api}))
vi.mock('../../services/memoryGitProjects',()=>({memoryGitProjects:api}))
vi.mock('./MemoryGitPanel.vue',()=>({default:{props:['scopeId','connectionId'],template:'<div data-testid="sync-workspace">{{scopeId}} / {{connectionId}}</div>'}}))
const project={id:'project',team_id:'ctm_team',team_name:'PocketCTL',name:'Project',provider:'github' as const,repository_url:'https://github.com/example/repo',branch:'main',request_id:'request',created_at:'',setup:'repository_authorization_required' as const,memory_installation_id:'scope',memory_status:'active',can_initialize:true}
const connected={connection_id:'connection',repository_id:'repository',generation:'2',state:'active',target_branch:'main',consent_until:'2099-01-01T00:00:00Z',authorized:true,repository_url:project.repository_url}
beforeEach(()=>{vi.resetAllMocks();user.value={id:3};api.project.mockResolvedValue({project:null,can_configure:true})})
const panel=async(p=project)=>{const w=mount(MemoryGitProjectSetup,{props:{project:p}});await flushPromises();return w}
test('initialization requires explicit shared Memory consent and uses the collaboration Team identity',async()=>{
  const w=await panel({...project,memory_installation_id:'',memory_status:'pending'})
  expect(w.get('button').attributes('disabled')).toBeDefined()
  await w.get('input[type=checkbox]').setValue(true);await w.get('button').trigger('click');await flushPromises()
  expect(api.initialize).toHaveBeenCalledWith('ctm_team',expect.objectContaining({userId:3}))
  expect(w.emitted('changed')).toHaveLength(1);w.unmount()
})
test('connection requires consent, sends only the fixed project target, clears the token and opens the matching workspace',async()=>{
  api.connectProject.mockResolvedValue({project:connected})
  const w=await panel();await w.get('input[type=password]').setValue('TEST_ONLY_TOKEN')
  expect(w.get('[data-testid=git-setup-connect]').attributes('disabled')).toBeDefined()
  await w.get('input[type=checkbox]').setValue(true)
  api.project.mockResolvedValue({project:connected,can_configure:true})
  await w.get('form').trigger('submit');await flushPromises()
  expect(api.connectProject).toHaveBeenCalledWith('scope','project',expect.objectContaining({repository_url:project.repository_url,read_consent:true,expected_generation:null,access_token:'TEST_ONLY_TOKEN'}),expect.any(String))
  expect(w.text()).toContain('读取授权有效');expect(w.find('input[type=password]').exists()).toBe(false)
  await w.findAll('button').find(b=>b.text()==='打开同步工作区')!.trigger('click')
  expect(w.get('[data-testid=sync-workspace]').text()).toBe('scope / connection');w.unmount()
})
test('read-only members cannot submit credentials and revocation requires a separate confirmation',async()=>{
  api.project.mockResolvedValue({project:connected,can_configure:false})
  const w=await panel();expect(w.find('form').exists()).toBe(false);expect(w.text()).not.toContain('撤销读取授权');w.unmount()
  api.project.mockResolvedValue({project:connected,can_configure:true});api.disconnectProject.mockResolvedValue({project:{...connected,authorized:false,state:'disabled'}})
  const admin=await panel();await admin.findAll('button').find(b=>b.text()==='撤销读取授权')!.trigger('click')
  expect(api.disconnectProject).not.toHaveBeenCalled()
  await admin.findAll('button').find(b=>b.text()==='确认撤销')!.trigger('click');await flushPromises()
  expect(api.disconnectProject).toHaveBeenCalledWith('scope','project','2');expect(admin.text()).toContain('请重新授权');admin.unmount()
})
test('lost responses reconcile from the server and do not retain a credential in the form',async()=>{
  const w=await panel();await w.get('input[type=password]').setValue('TEST_ONLY_TOKEN');await w.get('input[type=checkbox]').setValue(true)
  api.connectProject.mockRejectedValue({status:0});api.project.mockResolvedValue({project:connected,can_configure:true})
  await w.get('form').trigger('submit');await flushPromises()
  expect(w.text()).toContain('读取授权有效');expect(w.find('form').exists()).toBe(false);w.unmount()
})
test('an account switch discards a late connection response and immediately clears the secret',async()=>{
  let finish!:(value:unknown)=>void;api.connectProject.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const w=await panel();await w.get('input[type=password]').setValue('TEST_ONLY_TOKEN');await w.get('input[type=checkbox]').setValue(true)
  await w.get('form').trigger('submit');api.project.mockResolvedValue({project:null,can_configure:false});user.value={id:9};await flushPromises()
  finish({project:connected});await flushPromises();expect(w.text()).not.toContain('读取授权有效');expect(w.find('input[type=password]').exists()).toBe(false);w.unmount()
})
test('a mismatched repository result cannot be displayed as connected',async()=>{
  api.project.mockResolvedValue({project:{...connected,repository_url:'https://github.com/another/repo'},can_configure:true})
  const w=await panel();expect(w.text()).toContain('目标已变化');expect(w.text()).not.toContain('读取授权有效');w.unmount()
})
test('a pending installation starts reading setup automatically once the provider becomes active',async()=>{
  const w=await panel({...project,memory_status:'pending'})
  expect(api.project).not.toHaveBeenCalled()
  await w.setProps({project:{...project,memory_status:'active'}});await flushPromises()
  expect(api.project).toHaveBeenCalledTimes(1);expect(w.find('form').exists()).toBe(true);w.unmount()
})
test('a contributor can link their own account without getting repository administration controls',async()=>{
  api.project.mockResolvedValue({project:connected,can_configure:false,can_link_identity:true});api.linkIdentity.mockResolvedValue({project:{...connected,generation:'3'}})
  const w=await panel();expect(w.text()).not.toContain('撤销读取授权')
  await w.get('input[type=password]').setValue('ONE_TIME_TEST_TOKEN');await w.get('input[type=checkbox]').setValue(true)
  await w.get('form').trigger('submit');await flushPromises()
  expect(api.linkIdentity).toHaveBeenCalledWith('scope','project',{access_token:'ONE_TIME_TEST_TOKEN',expected_generation:'2'},expect.any(String))
  expect((w.get('input[type=password]').element as HTMLInputElement).value).toBe('');w.unmount()
})
test('a failed credential renewal keeps the previous active connection and clears the replacement token',async()=>{
  api.project.mockResolvedValue({project:connected,can_configure:true});api.connectProject.mockRejectedValue({status:422,code:'repository_authorization_failed'})
  const w=await panel();await w.findAll('button').find(b=>b.text()==='更新读取授权')!.trigger('click')
  await w.get('input[type=password]').setValue('REPLACEMENT_TEST_TOKEN');await w.get('input[type=checkbox]').setValue(true)
  await w.get('form').trigger('submit');await flushPromises()
  expect(api.connectProject.mock.calls[0][2]).toMatchObject({expected_generation:'2'})
  expect(w.text()).toContain('读取授权有效');expect(w.text()).toContain('仓库授权验证失败')
  expect((w.get('input[type=password]').element as HTMLInputElement).value).toBe('');w.unmount()
})
test('an old active generation cannot falsely confirm a lost renewal response',async()=>{
  api.project.mockResolvedValue({project:connected,can_configure:true});api.connectProject.mockRejectedValue({status:0})
  const w=await panel();await w.findAll('button').find(b=>b.text()==='更新读取授权')!.trigger('click')
  await w.get('input[type=password]').setValue('REPLACEMENT_TEST_TOKEN');await w.get('input[type=checkbox]').setValue(true)
  await w.get('form').trigger('submit');await flushPromises()
  expect(w.text()).toContain('连接结果尚未确认');expect(w.emitted('changed')).toBeUndefined()
  api.project.mockResolvedValue({project:{...connected,generation:'4'},can_configure:true})
  await w.findAll('button').find(b=>b.text()==='刷新')!.trigger('click');await flushPromises()
  expect(w.text()).not.toContain('连接结果尚未确认');w.unmount()
})
