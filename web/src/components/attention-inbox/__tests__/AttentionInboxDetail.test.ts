import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import AttentionInboxDetail from '../AttentionInboxDetail.vue'
import AttentionInboxItemRow from '../AttentionInboxItemRow.vue'
import type { AttentionInboxContext, AttentionInboxItem } from '../../../types/attentionInbox'

vi.mock('../../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))

function item(context: AttentionInboxContext, provider: AttentionInboxItem['provider'] = 'opencode'): AttentionInboxItem {
  return {
    item_id: 'synthetic-approval', revision: 1, provider, kind: 'approval', state: 'open',
    risk: { level: 'high', classification_incomplete: true, reasons: ['executes_command'] },
    daemon: { id: 'test-host', display_name: 'Test host' },
    session: { id: 'test-session', title: 'Command acceptance', status: 'waiting_approval' },
    request_id: 'test-request', title: 'Approval required', summary: '', context,
    allowed_actions: [], seen_at: null, snoozed_until: null, submitted_at: null,
    resolved_at: null, handled_at: null, expires_at: null, resolution: null, last_error: null,
    created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z',
  }
}

function render(context: AttentionInboxContext, provider?: AttentionInboxItem['provider']) {
  return mount(AttentionInboxDetail, { props: { item: item(context, provider), actions: [], readOnly: false } })
}

describe('approval command context', () => {
  test('renders the production OpenCode nested command with the command label', () => {
    const wrapper = render({ command: '', permission_name: 'bash', input: { command: 'printf V055-GLM-ALLOW-OK' }, metadata: { command: 'printf V055-GLM-ALLOW-OK' } })
    expect(wrapper.get('.context-card code').text()).toBe('printf V055-GLM-ALLOW-OK')
    expect(wrapper.get('.context-card > span').text()).toBe('attention.command')
  })

  test('keeps the canonical command ahead of nested alternatives for Codex and OpenCode', () => {
    for (const provider of ['codex', 'opencode'] as const) {
      const wrapper = render({ command: 'printf canonical', input: { command: 'printf input' }, metadata: { command: 'printf metadata' } }, provider)
      expect(wrapper.get('code').text()).toBe('printf canonical')
    }
  })

  test('preserves multiline and quoted command bytes and escapes HTML', () => {
    const command = '  printf "<img src=x onerror=alert(1)>"\nprintf "a  b"  '
    const wrapper = render({ input: { command }, metadata: { command: 'wrong command' } })
    expect(wrapper.get('code').element.textContent).toBe(command)
    expect(wrapper.find('code img').exists()).toBe(false)
  })

  test.each([null, [], 'bash', { command: 42 }, { command: {} }, { command: '  ' }])('uses metadata when input is invalid: %j', input => {
    const wrapper = render({ command: ' ', input, metadata: { command: 'printf metadata' } })
    expect(wrapper.get('code').text()).toBe('printf metadata')
    expect(wrapper.get('.context-card > span').text()).toBe('attention.command')
  })

  test('does not mistake permission patterns for an actual command', () => {
    const wrapper = render({ input: { command: {} }, metadata: [], permission_name: 'bash', patterns: ['printf *'], always_rules: ['*'] })
    expect(wrapper.get('code').text()).toBe('bash')
    expect(wrapper.get('.context-card > span').text()).toBe('attention.context')
  })

  test('retains non-command context and does not use OpenCode fallbacks for Codex', () => {
    const wrapper = render({ description: 'Choose a file', input: { command: 'unrelated' } }, 'codex')
    expect(wrapper.get('code').text()).toBe('Choose a file')
    expect(render({}).find('.context-card').exists()).toBe(false)
  })

  test('updates both command and label when selecting another item', async () => {
    const wrapper = render({ input: { command: 'printf first' } })
    await wrapper.setProps({ item: { ...item({ metadata: { command: 'printf second' } }), item_id: 'second' } })
    expect(wrapper.get('code').text()).toBe('printf second')
    await wrapper.setProps({ item: item({ description: 'File access' }) })
    expect(wrapper.get('code').text()).toBe('File access')
    expect(wrapper.get('.context-card > span').text()).toBe('attention.context')
  })
})


describe('approval provider identity', () => {
  test.each([
    ['claude-code', 'Claude Code'], ['dsh', 'DeepSeek Harness'], ['codex', 'Codex'], ['opencode', 'OpenCode'],
  ] as const)('shows %s consistently in the list and approval detail', (provider, label) => {
    const approval = item({}, provider)
    const row = mount(AttentionInboxItemRow, { props: { item: approval } })
    const detail = render({}, provider)
    expect(row.get('.item-kicker strong').text()).toBe(label)
    expect(detail.get('.detail-meta').text()).toBe(`${label} · Test host · Command acceptance`)
  })
})
