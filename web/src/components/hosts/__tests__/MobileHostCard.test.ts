import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import MobileHostCard from '../MobileHostCard.vue'

describe('MobileHostCard', () => {
  test('presents the iOS host-card information hierarchy and actions', async () => {
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
    expect(wrapper.emitted('sessions')).toHaveLength(1)
    expect(wrapper.emitted('new-session')).toHaveLength(1)
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
