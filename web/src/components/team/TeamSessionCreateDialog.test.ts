import {flushPromises,mount} from '@vue/test-utils'
import {beforeEach,describe,expect,test,vi} from 'vitest'
import {createMemoryHistory,createRouter} from 'vue-router'
import TeamSessionCreateDialog from './TeamSessionCreateDialog.vue'
vi.mock('../../composables/useLocale',async()=>{const table=(await import('../../i18n/zh.json')).default as Record<string,string>;return {useLocale:()=>({t:(key:string)=>table[key]||key})}})
const api=vi.hoisted(()=>({createTeamContext:vi.fn(),createTeamSession:vi.fn(),getTeamContext:vi.fn(),getTeamSession:vi.fn(),listTeamAgentOffers:vi.fn(),listTeamMembers:vi.fn(),listTeamTasks:vi.fn(),setTeamSessionParticipant:vi.fn()}))
vi.mock('../../services/teamClient',()=>api)
const session={id:'created-session',team_id:'team',title:'New session',revision:1,participants:[{user_id:7,state:'active'}],agent_bindings:[]}
beforeEach(()=>{
 vi.clearAllMocks()
 api.listTeamAgentOffers.mockResolvedValue([{id:'online',owner_user_id:7,daemon_id:'mine',provider:'codex',state:'active',managed_callable:true},{id:'offline',owner_user_id:8,daemon_id:'offline',provider:'claude-code',state:'active',managed_callable:false}])
 api.listTeamMembers.mockResolvedValue([{id:'member-7',user_id:7,display_label:'Lin'},{id:'member-8',user_id:8,display_label:'Zoe'}])
 api.listTeamTasks.mockResolvedValue([{id:'open',title:'Open task',state:'open'},{id:'archived',title:'Archived task',state:'archived'}])
 api.createTeamSession.mockResolvedValue(session);api.createTeamContext.mockResolvedValue({});api.getTeamContext.mockResolvedValue(null)
 api.setTeamSessionParticipant.mockResolvedValue({...session,revision:2,participants:[...session.participants,{user_id:8,state:'active'}]})
 api.getTeamSession.mockResolvedValue({...session,revision:2,participants:[...session.participants,{user_id:8,state:'active'}]})
})
async function render(){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/teams',component:{template:'<div />'}},{path:'/team/:teamId/session/:id',name:'team-session',component:{template:'<div />'}}]});await router.push('/teams');await router.isReady();const wrapper=mount(TeamSessionCreateDialog,{props:{teamId:'team'},global:{plugins:[router]}});await flushPromises();return{wrapper,router}}
describe('Team shared-session creation',()=>{
 test('retains actual members, callable Agent gates and linked task selection',async()=>{
  const {wrapper,router}=await render()
  try{
   expect(wrapper.findAll('select option').map(option=>option.attributes('value'))).toEqual(['','open'])
   expect(wrapper.findAll('.offer-choice input')[1].attributes('disabled')).toBeDefined()
   await wrapper.get('[data-testid="team-session-title"]').setValue('New session');await wrapper.get('[data-testid="team-session-goal"]').setValue('Discuss scope')
   await wrapper.get('select').setValue('open');await wrapper.findAll('.offer-choice input')[0].setValue(true);await wrapper.findAll('.person-choice input')[1].setValue(true)
   expect(wrapper.get('button[form="team-shared-session-create-form"]').attributes('type')).toBe('submit')
   await wrapper.get('form').trigger('submit');await flushPromises()
   expect(api.createTeamSession).toHaveBeenCalledWith('team',{title:'New session',offerIDs:['online'],taskID:'open'})
   expect(api.setTeamSessionParticipant).toHaveBeenCalledWith(session,8,true)
   expect(api.createTeamContext).toHaveBeenCalledWith('created-session',expect.objectContaining({goal:'Discuss scope',expectedRevision:0}))
   expect(router.currentRoute.value.name).toBe('team-session')
  }finally{wrapper.unmount()}
 })
 test('retries incomplete setup without creating another session or re-adding members',async()=>{
  api.createTeamContext.mockRejectedValueOnce(new Error('Temporary failure'))
  const {wrapper,router}=await render()
  try{
   await wrapper.get('[data-testid="team-session-title"]').setValue('New session');await wrapper.get('[data-testid="team-session-goal"]').setValue('Discuss scope')
   await wrapper.findAll('.offer-choice input')[0].setValue(true);await wrapper.findAll('.person-choice input')[1].setValue(true)
   await wrapper.get('form').trigger('submit');await flushPromises()
   expect(wrapper.get('[data-testid="team-session-title"]').attributes('disabled')).toBeDefined()
   expect(wrapper.text()).toContain('重试剩余设置');expect(wrapper.text()).toContain('打开已创建的会话')
   await wrapper.get('form').trigger('submit');await flushPromises()
   expect(api.createTeamSession).toHaveBeenCalledTimes(1);expect(api.setTeamSessionParticipant).toHaveBeenCalledTimes(1)
   expect(api.getTeamContext).toHaveBeenCalledWith('created-session');expect(api.createTeamContext).toHaveBeenCalledTimes(2)
   expect(router.currentRoute.value.name).toBe('team-session')
  }finally{wrapper.unmount()}
 })
})
