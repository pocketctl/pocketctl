import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import SessionActions from '../SessionActions.vue'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../composables/useWebSocket', () => ({ useWebSocket: () => ({ send, onEvent: vi.fn() }) }))
vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ accessToken: ref('local-test') }) }))
vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))

describe('confirmed session deletion', () => {
  beforeEach(() => { vi.useFakeTimers(); send.mockClear() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  async function confirm() {
    const session = { session_id: 'original', title: 'Original session' }
    const wrapper = mount(SessionActions, { props: { session }, global: { stubs: { Teleport: true } } })
    await wrapper.get('.ss-more-btn').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'session.actions.delete')!.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'session.actions.delete_confirm')!.trigger('click')
    return { wrapper, session }
  }

  test('sends the confirmed deletion after navigation unmounts the row', async () => {
    const { wrapper } = await confirm()
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5700)
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'session_delete', session_id: 'original' })
  })

  test('retains the original target when the row receives a different session', async () => {
    const { wrapper } = await confirm()
    await wrapper.setProps({ session: { session_id: 'next', title: 'Next session' } })
    await vi.advanceTimersByTimeAsync(5700)
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'session_delete', session_id: 'original' })
    wrapper.unmount()
  })

  test('undo within the existing five-second window prevents deletion', async () => {
    const { wrapper, session } = await confirm()
    await vi.advanceTimersByTimeAsync(700)
    await flushPromises()
    expect(session).toHaveProperty('__pendingDelete', true)
    await wrapper.get('.ss-toast-undo').trigger('click')
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).not.toHaveBeenCalled()
    expect(session).toHaveProperty('__pendingDelete', false)
    wrapper.unmount()
  })
})
