import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

import SessionScopeSwitcher from '../SessionScopeSwitcher.vue'

describe('SessionScopeSwitcher', () => {
  test('emits explicit personal and Team scopes', async () => {
    const wrapper = mount(SessionScopeSwitcher, {
      props: {
        modelValue: { type: 'personal' },
        teams: [{ id: 'ctm_1', name: 'Research' }],
      },
    })

    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')
    await wrapper.get('button:nth-of-type(2)').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual({ type: 'team', teamId: 'ctm_1' })
  })
})
