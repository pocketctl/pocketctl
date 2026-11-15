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

test('content, item provenance and trajectory have separate accessible tabs and usage stays unconfirmed', async () => {
  const pack={pack_id:'pack',state:'ready',client_request_id:'request',created_at:'2026-11-06',delivery:{state:'delivered',outcome_code:null},mode:'enabled',agent:'codex',stable_text:'full stable',dynamic_text:'full dynamic',stable_tokens:12,dynamic_tokens:3,error_code:null,policy_revision:1,settings_revision:2,loadout_revision:3,items:[{item_id:'item',claim_id:'claim',version_id:'version',claim_type:'fact',layer:'dynamic',section:'knowledge',representation:'full',reason_codes:['matched'],token_count:3,ordinal:1,evidence_ids:['evidence-one']}],trajectory:{result_state:'ready',degraded_components:['source'],candidates:[{version_id:'version',decision:'included',reason_code:'matched',final_ordinal:1}]}}
  const wrapper=mount(ContextPackDetail,{props:{pack},attachTo:document.body})
  expect(wrapper.get('[data-testid="detail-use"]').text()).toBe('未确认')
  const tabs=wrapper.findAll('[role="tab"]');expect(tabs).toHaveLength(3)
  await tabs[1]!.trigger('click')
  expect(wrapper.get('[data-testid="detail-items"]').isVisible()).toBe(true)
  expect(wrapper.get('[data-testid="detail-items"]').text()).toContain('evidence-one')
  expect(wrapper.get('[data-testid="detail-stable"]').isVisible()).toBe(false)
  await tabs[2]!.trigger('click')
  expect(wrapper.get('[data-testid="detail-trajectory"]').isVisible()).toBe(true)
  expect(wrapper.get('[data-testid="detail-trajectory"]').text()).toContain('included')
  wrapper.unmount()
})
