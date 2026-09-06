import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import MobileHostCard from '../MobileHostCard.vue'

describe('MobileHostCard', () => {
  test('presents all four iOS host-card destinations', async () => {
    const wrapper = mount(MobileHostCard, {
      props: {
        daemon: {
          daemon_id: 'daemon-1',
          daemon_alias: '开发主机',
          hostname: 'mac-studio',
          daemon_online: true,
          agents: [
            { type: 'claude-code', version: '1.2.3' },
            { type: 'codex', version: '0.144.1' },
          ],
          last_heartbeat: '2026-07-25T04:00:00Z',
        },
        activeSessions: 2,
        totalSessions: 8,
        lastActivityLabel: '3 分钟前',
      },
    })

    expect(wrapper.text()).toContain('开发主机')
    expect(wrapper.text()).toContain('Claude Code')
    expect(wrapper.text()).toContain('Codex')
    expect(wrapper.text()).toMatch(/2 .*8 /)
    expect(wrapper.text()).toMatch(/active|活跃/i)

    await wrapper.get('[data-action="sessions"]').trigger('click')
    await wrapper.get('[data-action="new-session"]').trigger('click')
    await wrapper.get('[data-action="token"]').trigger('click')
    await wrapper.get('[data-action="agent"]').trigger('click')
    expect(wrapper.emitted('sessions')).toHaveLength(1)
    expect(wrapper.emitted('new-session')).toHaveLength(1)
    expect(wrapper.emitted('token')).toHaveLength(1)
    expect(wrapper.emitted('agent')).toHaveLength(1)
    expect(wrapper.findAll('.mobile-host-actions button')).toHaveLength(4)
  })

  test('edits an alias inline without opening a browser prompt', async () => {
    const promptSpy = vi.fn()
    vi.stubGlobal('prompt', promptSpy)
    const wrapper = mount(MobileHostCard, {
      props: {
        daemon: {
          daemon_id: 'daemon-1',
          daemon_alias: '开发主机',
          hostname: 'mac-studio',
          daemon_online: true,
          agents: [],
        },
        activeSessions: 0,
        totalSessions: 0,
      },
    })

    await wrapper.get('[data-action="edit-alias"]').trigger('click')
    const input = wrapper.get('[data-role="alias-input"]')
    await input.setValue('主力机')
    await wrapper.get('.mobile-host-rename').trigger('submit')

    expect(promptSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('set-alias')).toEqual([['主力机']])
    vi.unstubAllGlobals()
  })

  test('keeps token history available while disabling live-only actions offline', () => {
    const wrapper = mount(MobileHostCard, {
      props: {
        daemon: {
          daemon_id: 'daemon-1',
          hostname: 'mac-studio',
          daemon_online: false,
          agents: [{ type: 'codex', version: '0.144.1' }],
        },
        activeSessions: 0,
        totalSessions: 4,
      },
    })

    expect(wrapper.get('[data-action="new-session"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-action="agent"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-action="token"]').attributes('disabled')).toBeUndefined()
  })

  test('shows Codex Desktop without an upgrade affordance', () => {
    const wrapper = mount(MobileHostCard, {
      props: {
        daemon: {
          daemon_id: 'daemon-1', hostname: 'mac-studio', daemon_online: true,
          agents: [{ type: 'codex-desktop', version: '0.1.0', latest: '0.2.0' }],
        },
        activeSessions: 0,
        totalSessions: 1,
      },
    })

    expect(wrapper.get('.mobile-agent-tag').text()).toContain('Codex Desktop')
    expect(wrapper.find('.mobile-agent-tag .upgrade').exists()).toBe(false)
  })

  test('keeps the more-button click from reaching the document close handler', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const documentClick = vi.fn()
    document.addEventListener('click', documentClick)
    const wrapper = mount(MobileHostCard, {
      attachTo: host,
      props: {
        daemon: {
          daemon_id: 'daemon-1',
          hostname: 'mac-studio',
          daemon_online: true,
          agents: [],
        },
        activeSessions: 0,
        totalSessions: 0,
      },
    })

    await wrapper.get('.mobile-host-more').trigger('click')

    expect(wrapper.emitted('more')).toHaveLength(1)
    expect(documentClick).not.toHaveBeenCalled()

    wrapper.unmount()
    document.removeEventListener('click', documentClick)
    host.remove()
  })
})
