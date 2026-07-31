import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import HostActionsMenu from '../HostActionsMenu.vue'

describe('HostActionsMenu', () => {
  test('renders the iOS action set and emits the selected action', async () => {
    const wrapper = mount(HostActionsMenu, {
      props: {
        daemon: { daemon_id: 'daemon-1', hostname: 'mac-studio' },
        x: 20,
        y: 40,
      },
    })

    expect(wrapper.findAll('[data-host-action]').map(button => button.attributes('data-host-action'))).toEqual([
      'refresh',
      'restart',
      'alias',
      'kick',
      'unregister',
    ])

    await wrapper.get('[data-host-action="refresh"]').trigger('click')
    expect(wrapper.emitted('action')).toEqual([['refresh']])
  })
})
