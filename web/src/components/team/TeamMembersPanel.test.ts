import {DOMWrapper,flushPromises,mount} from '@vue/test-utils'
import {afterEach,beforeEach,describe,expect,test,vi} from 'vitest'
import TeamMembersPanel from './TeamMembersPanel.vue'
import type {TeamAgentCandidate,TeamAgentOffer,TeamMember,TeamSummary} from '../../types/team'
vi.mock('../../composables/useLocale',async()=>{const table=(await import('../../i18n/zh.json')).default as Record<string,string>;return {useLocale:()=>({t:(key:string)=>table[key]||key})}})
const api=vi.hoisted(()=>({addTeamAgentOffer:vi.fn(),dissolveTeam:vi.fn(),inviteTeamMember:vi.fn(),leaveTeam:vi.fn(),removeTeamMember:vi.fn(),revokeTeamAgentOffer:vi.fn(),revokeTeamInvitation:vi.fn()}))
vi.mock('../../services/teamClient',()=>api)
const team:TeamSummary={id:'team',name:'PocketCtl',creator_user_id:7,state:'active',revision:3,member_count:2,created_at:'',updated_at:''}
const members:TeamMember[]=[7,8].map(user_id=>({id:'member-'+user_id,team_id:team.id,user_id,display_label:user_id===7?'Lin':'Zoe',state:'active',revision:1,joined_at:'',ended_at:null}))
const candidate:TeamAgentCandidate={daemon_id:'mine',hostname:'My Mac',provider:'codex',installed:true,online:true,managed_callable:true,dispatch_supported:true,availability:'online',occupied_team_id:null}
const ownOffer:TeamAgentOffer={id:'own',team_id:team.id,owner_user_id:7,daemon_id:'mine',provider:'codex',runtime_profile_id:null,capability_revision:1,state:'active',revision:2,availability:'online',installed:true,online:true,managed_callable:true,dispatch_supported:true,created_at:'',updated_at:''}
const otherOffer:TeamAgentOffer={...ownOffer,id:'other',owner_user_id:8,daemon_id:'other-host',provider:'claude-code',availability:'offline',online:false,managed_callable:false}
const spare:TeamAgentCandidate={...candidate,daemon_id:'spare',hostname:'My Server',provider:'claude-code',availability:'offline',online:false,managed_callable:false}
const wrappers:Array<ReturnType<typeof mount>>=[]
async function render(writesEnabled=true){const wrapper=mount(TeamMembersPanel,{attachTo:document.body,props:{team,members,offers:[ownOffer,otherOffer],invitations:[],candidates:[candidate,spare],currentUserId:7,writesEnabled}});wrappers.push(wrapper);await flushPromises();return wrapper}
const actionList=()=>new DOMWrapper(document.querySelector('.workspace-action-list') as HTMLElement)
beforeEach(()=>{vi.clearAllMocks();Object.values(api).forEach(fn=>fn.mockResolvedValue({}));vi.stubGlobal('confirm',vi.fn().mockReturnValue(true))})
afterEach(()=>{wrappers.splice(0).forEach(wrapper=>wrapper.unmount());vi.unstubAllGlobals()})
describe('Team member and Agent controls',()=>{
 test('separates my shared and unshared Agents while retaining other member availability',async()=>{
  const wrapper=await render()
  const own=wrapper.get('[data-testid="team-my-agents"]')
  expect(own.findAll('[data-agent-key]')).toHaveLength(2)
  expect(own.text()).toContain('My Server');expect(own.text()).toContain('未共享')
  expect(own.text()).not.toContain('other-host')
  expect(wrapper.get('.reference-members').text()).toContain('离线')
  await own.get('[data-agent-key="spare:claude-code"] button').trigger('click');await flushPromises()
  await actionList().get('.action-item').trigger('click');await flushPromises()
  expect(api.addTeamAgentOffer).toHaveBeenCalledWith(team.id,spare,team.revision)
  expect(wrapper.emitted('refresh')).toHaveLength(1)
 })
 test('withdraws only the selected owned offer from the sharing action list',async()=>{
  const wrapper=await render()
  await wrapper.get('[data-agent-key="mine:codex"] button').trigger('click');await flushPromises()
  await actionList().get('.action-item').trigger('click');await flushPromises()
  expect(api.revokeTeamAgentOffer).toHaveBeenCalledWith(ownOffer)
  expect(api.addTeamAgentOffer).not.toHaveBeenCalled()
 })
 test('keeps readonly member details accessible while hiding all write controls',async()=>{
  const wrapper=await render(false)
  expect(wrapper.find('.module-intro button').exists()).toBe(false)
  expect(wrapper.get('[data-testid="team-my-agents"]').findAll('button')).toHaveLength(0)
  await wrapper.get('[data-testid="team-member-manage-8"]').trigger('click');await flushPromises()
  expect(actionList().text()).toContain('Zoe');expect(actionList().text()).toContain('离线')
  expect(actionList().find('.action-item').exists()).toBe(false)
  expect(api.removeTeamMember).not.toHaveBeenCalled()
 })
 test('preserves creator confirmation before removing a member',async()=>{
  const wrapper=await render()
  await wrapper.get('[data-testid="team-member-manage-8"]').trigger('click');await flushPromises()
  vi.mocked(confirm).mockReturnValueOnce(false)
  await actionList().get('.action-item').trigger('click');await flushPromises()
  expect(api.removeTeamMember).not.toHaveBeenCalled()
  await actionList().get('.action-item').trigger('click');await flushPromises()
  expect(api.removeTeamMember).toHaveBeenCalledWith(team.id,members[1])
 })
})
