import { flushPromises, mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import type { TeamEvent, TeamMember, TeamSession } from '../../types/team'
import TeamGroupAssignment from './TeamGroupAssignment.vue'
const request = vi.hoisted(() => vi.fn())
vi.mock('../../services/teamClient', () => ({ teamRequest: request }))
vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ user: { value: { id: 1 } } }) }))
vi.mock('../../composables/useEnv', () => ({ getRelayOrigin: () => 'http://test.local' }))

test('selects a machine grant and requires review of the saved revision before confirmation', async () => {
  const grant = {
    repository: 'team/project',
    base_sha: 'a'.repeat(40),
    grant_revision: 'f'.repeat(64),
    paths: ['web'],
    tools: ['git'],
  }
  const session = {
    id: 's',
    current_context_version: 0,
    agent_bindings: [
      {
        id: 'b',
        offer_id: 'offer',
        provider: 'codex',
        daemon_id: 'Mac-A',
        owner_user_id: 1,
        availability: 'online',
        code_workspaces: [grant],
      },
    ],
    participants: [{ user_id: 1, state: 'active' }],
  } as TeamSession
  const source = {
    id: 'post',
    team_session_id: 's',
    kind: 'member_message',
    content: 'Implement the project',
  } as TeamEvent
  const draft = {
    assignment_id: 'assignment',
    source_text: source.content,
    mode: 'independent',
    proposal: source.content,
    context_version: 0,
    references_snapshot: [],
    revision: 1,
    items: [],
  }
  request.mockImplementation(async (_url: string, opts: { method?: string; body?: Record<string, unknown> }) => ({
    assignment: opts.method === 'PATCH' ? { ...draft, ...opts.body, revision: 2 } : draft,
  }))
  const wrapper = mount(TeamGroupAssignment, {
    props: {
      session,
      source,
      members: [{ user_id: 1, role: 'admin', state: 'active', display_label: 'Lin' } as TeamMember],
      events: [source],
      actor: 1,
      canEdit: true,
    },
    global: { stubs: { ActionSelect: {template:"<span><slot/></span>"}, TeamOverlay: { template: '<div><slot/><slot name="footer"/></div>' } } },
  })
  await flushPromises()
  const select = (label: string) =>
    wrapper
      .findAll('label')
      .find((l) => l.text().startsWith(label))!
      .get('select')
  await select('怎样实施').setValue('plan')
  await select('执行工作区').setValue(grant.grant_revision)
  await wrapper
    .findAll('label')
    .find((l) => l.text() === '验收条件')!
    .get('textarea')
    .setValue('Web check')
  const button = (label: string) => wrapper.findAll('button').find((b) => b.text().startsWith(label))!
  expect(button('确认按')).toBeUndefined()
  await button('保存并核对').trigger('click')
  await flushPromises()
  expect(request.mock.calls.at(-1)?.[1].body.items[0].code).toEqual({ ...grant, kind: 'develop' })
  expect(button('确认按').text()).toContain('v2')
  expect(button('确认按').attributes('disabled')).toBeUndefined()
  expect(wrapper.text()).toContain('Web check')
  expect(wrapper.find('textarea').exists()).toBe(false)
  await button('返回修改').trigger('click')
  await wrapper
    .findAll('label')
    .find((l) => l.text() === '职责')!
    .get('textarea')
    .setValue('Updated scope')
  expect(button('确认按')).toBeUndefined()
  wrapper.unmount()
})
