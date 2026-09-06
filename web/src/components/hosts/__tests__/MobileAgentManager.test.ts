import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import MobileAgentManager from '../MobileAgentManager.vue'

function daemonWithAgent(agent: Record<string, unknown>) {
  return {
    daemon_id: 'daemon-1', hostname: 'mac-studio', daemon_online: true,
    agents: [agent],
  }
}

describe('MobileAgentManager observer controls', () => {
  test.each(['codex-desktop', 'zcode'])(
    'never renders upgrade for forged manageable %s observer metadata',
    (type) => {
      const wrapper = mount(MobileAgentManager, {
        props: {
          daemon: daemonWithAgent({ type, version: '0.1.0', latest: '9.9.9', manageable: true }),
          upgrading: '',
        },
      })

      expect(wrapper.find('.mobile-agent-card > button').exists()).toBe(false)
      expect(wrapper.find('.mobile-agent-current').exists()).toBe(true)
    },
  )

  test('keeps a create-capable Codex CLI upgrade available', async () => {
    const wrapper = mount(MobileAgentManager, {
      props: {
        daemon: daemonWithAgent({ type: 'codex', version: '0.1.0', latest: '0.2.0', manageable: true }),
        upgrading: '',
      },
    })

    await wrapper.get('.mobile-agent-card > button').trigger('click')
    expect(wrapper.emitted('upgrade')).toEqual([['codex']])
  })
})
