import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import BindEmailModal from '../BindEmailModal.vue'

const auth = vi.hoisted(() => ({
  user: { value: { email: '13800000000', display_name: 'Phone User' } },
  accessToken: { value: 'test-access-token' },
}))

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ user: auth.user, accessToken: auth.accessToken }),
}))

const fetchMock = vi.fn()

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('BindEmailModal verified-binding flow', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('sending the code calls the dedicated send-code endpoint, not the bind PUT', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }))
    const wrapper = mount(BindEmailModal)
    await wrapper.find('input[type="email"]').setValue('new-owner@example.test')

    await wrapper.find('[data-test="send-code"]').trigger('click')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/user/email/send-code')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ email: 'new-owner@example.test' })
    expect(init.headers.Authorization).toBe('Bearer test-access-token')
  })

  test('bind requires a code: PUT body always includes email + code', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
    const wrapper = mount(BindEmailModal)
    await wrapper.find('input[type="email"]').setValue('new-owner@example.test')
    await wrapper.find('[data-test="send-code"]').trigger('click')
    await wrapper.find('input[inputmode="numeric"][data-test="code"]').setValue('654321')

    await wrapper.find('[data-test="confirm"]').trigger('click')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/user/email')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ email: 'new-owner@example.test', code: '654321' })
    expect(wrapper.emitted('saved')?.[0]).toEqual(['new-owner@example.test'])
  })

  test('conflict surfaces a friendly error and keeps the modal open', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(jsonResponse(409, { error: '该邮箱已被其他账号绑定' }))
    const wrapper = mount(BindEmailModal)
    await wrapper.find('input[type="email"]').setValue('taken@example.test')
    await wrapper.find('[data-test="send-code"]').trigger('click')
    await wrapper.find('input[inputmode="numeric"][data-test="code"]').setValue('654321')
    await wrapper.find('[data-test="confirm"]').trigger('click')

    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.text()).toContain('该邮箱已被其他账号绑定')
  })

  test('send-code 429 shows retry guidance', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'too many requests, please retry later' }))
    const wrapper = mount(BindEmailModal)
    await wrapper.find('input[type="email"]').setValue(' throttled@example.test ')
    await wrapper.find('[data-test="send-code"]').trigger('click')

    expect(wrapper.text()).toContain('too many requests')
  })

  test('the verification code is never persisted to localStorage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }))
    const wrapper = mount(BindEmailModal)
    const keysBefore = Object.keys(localStorage)
    await wrapper.find('input[type="email"]').setValue('persist-check@example.test')
    await wrapper.find('[data-test="send-code"]').trigger('click')
    await wrapper.find('input[inputmode="numeric"][data-test="code"]').setValue('123456')
    await nextTick()

    // The modal must not add keys, and no stored value may contain the code.
    expect(Object.keys(localStorage).sort()).toEqual(keysBefore.sort())
    for (const value of Object.values(localStorage)) {
      expect(String(value)).not.toContain('123456')
    }
    wrapper.unmount()
  })

  test('cooldown countdown disables resend and closing clears the timer', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }))
      const wrapper = mount(BindEmailModal)
      await wrapper.find('input[type="email"]').setValue('timer@example.test')
      await wrapper.find('[data-test="send-code"]').trigger('click')

      const sendBtn = wrapper.find('[data-test="send-code"]')
      expect(sendBtn.attributes('disabled')).toBeDefined()
      await vi.advanceTimersByTimeAsync(1000)
      expect(wrapper.text()).toMatch(/59|重新获取|resend/i)

      wrapper.unmount()
      // No timer callbacks may keep running after unmount.
      fetchMock.mockClear()
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true }))
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
