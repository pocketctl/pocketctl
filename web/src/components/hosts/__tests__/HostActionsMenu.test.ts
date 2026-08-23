import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
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

  test('edits the alias inside the action sheet and keeps clicks contained', async () => {
    const documentClick = vi.fn()
    document.addEventListener('click', documentClick)
    const wrapper = mount(HostActionsMenu, {
      props: {
        daemon: { daemon_id: 'daemon-1', daemon_alias: '开发主机', hostname: 'mac-studio' },
        x: 20,
        y: 40,
      },
      attachTo: document.body,
    })

    await wrapper.get('[data-host-action="alias"]').trigger('click')
    expect(documentClick).not.toHaveBeenCalled()
    const input = wrapper.get('[data-role="sheet-alias-input"]')
    await input.setValue('主力机')
    await wrapper.get('[data-action="confirm-alias"]').trigger('click')

    expect(wrapper.emitted('action')).toEqual([['alias', '主力机']])
    wrapper.unmount()
    document.removeEventListener('click', documentClick)
  })
})
