import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../../composables/useLocale', async () => {
  const module = await import('../../i18n/zh.json')
  const translations = module.default as Record<string, string>
  return {
    useLocale: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let text = translations[key] ?? key
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            text = text.split(`{{${k}}}`).join(String(v))
          }
        }
        return text
      },
      locale: { value: 'zh' },
    }),
  }
})

const ContextPackDetail = (await import('./ContextPackDetail.vue')).default

describe('ContextPackDetail', () => {
  test('renders state and delivery distinctly with the replay hint', async () => {
    const wrapper = mount(ContextPackDetail, {
      props: {
        pack: {
          pack_id: 'abcd1234abcd1234abcd1234abcd1234',
          state: 'ready',
          client_request_id: 'cr-1',
          created_at: new Date().toISOString(),
          delivery: { state: 'delivered', outcome_code: 'accepted' },
          mode: 'enabled', agent: 'codex', stable_text: '', dynamic_text: '',
          stable_tokens: 0, dynamic_tokens: 0, error_code: null,
          policy_revision: 1, settings_revision: 1, loadout_revision: 1,
          items: [], trajectory: null,
        },
      },
    })
    expect(wrapper.find('[data-testid="detail-state"]').text()).toBe('ready')
    expect(wrapper.find('[data-testid="detail-delivery"]').text()).toBe('delivered')
    // The replay limitation is explicit, never silently implied.
    expect(wrapper.text()).toContain('content input')

    const empty = mount(ContextPackDetail, { props: { pack: null } })
    expect(empty.find('[data-testid="context-pack-detail"]').exists()).toBe(false)
  })
})
