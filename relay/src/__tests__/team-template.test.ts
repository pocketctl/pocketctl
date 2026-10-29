import {describe,test,expect} from 'vitest'
import {bindTemplate,validateTemplate} from '../team/template-contract.js'
import {resolveTeamCollaborationConfig,teamTemplatesEnabled} from '../team/config.js'
import {templateFixture} from './fixtures/team-template.js'
describe('versioned template contract',()=>{
 test('role bindings produce the normal bounded DAG without carrying suggested budget into dispatch',()=>{
  const t=templateFixture();validateTemplate(t)
  const steps=bindTemplate(t,{builder:'offer',reviewer:7})
  expect(steps[0].review_policy).toEqual({primary_offer_id:'offer',reviewer_user_id:7,required_checks:['unit']})
  expect(steps[1].depends_on).toEqual(['repair']);expect(steps[0]).not.toHaveProperty('agent_role')
 })
 test.each(['missing','wrong-kind','cycle','extra','size','budget'])('rejects malformed %s template',kind=>{
  const t:any=templateFixture()
  if(kind==='missing')t.roles.pop()
  if(kind==='wrong-kind')t.roles[1].kind='agent'
  if(kind==='cycle')t.steps[0].depends_on=['handoff']
  if(kind==='extra')t.permissions={admin:true}
  if(kind==='size')t.steps[0].instruction='x'.repeat(16001)
  if(kind==='budget')t.budget_suggestion.invocation_limit=1
  expect(()=>validateTemplate(t)).toThrow()
 })
 test.each([{}, {builder:'offer'}, {builder:1,reviewer:7}, {builder:'offer',reviewer:'7'}, {builder:'offer',reviewer:7,extra:1}])('requires complete exact role bindings %j',bindings=>{expect(()=>bindTemplate(templateFixture(),bindings as any)).toThrow()})
 test('requires independent opt-in plus draft, delivery and team allowlist',()=>{
  const env={TEAM_COLLABORATION:'on',TEAM_TASK_DELIVERY_V1:'on',TEAM_TASK_DELIVERY_TEAMS:'team',TEAM_TASK_PLAN_DRAFT_V1:'on'}
  expect(teamTemplatesEnabled(resolveTeamCollaborationConfig(env),'team')).toBe(false)
  const c=resolveTeamCollaborationConfig({...env,TEAM_TASK_TEMPLATES_V1:'on'})
  expect(teamTemplatesEnabled(c,'team')).toBe(true);expect(teamTemplatesEnabled(c,'other')).toBe(false)
  expect(()=>resolveTeamCollaborationConfig({TEAM_TASK_TEMPLATES_V1:'yes'})).toThrow()
  expect(()=>resolveTeamCollaborationConfig({TEAM_TASK_TEMPLATES_V1:'on'})).toThrow('requires plan draft')
 })
})
