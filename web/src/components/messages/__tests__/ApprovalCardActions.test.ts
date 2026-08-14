import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import ApprovalCard from '../ApprovalCard.vue'

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: 'approval_request', request_id: 'per_1', status: 'pending',
    tool: 'bash', permissionName: 'bash', patterns: ['git status'], always: ['git *'],
    metadata: { command: 'git status', cwd: '/repo' }, inputDesc: 'git status',
    ...overrides,
  }
}

describe('ApprovalCard OpenCode actions', () => {
  test('renders full permission context and emits once/always/reject without optimistic resolution', async () => {
    const pending = message({ securityContext: {
      schema_version: 1, risk_level: 'low', classification_incomplete: false,
      risk_reasons: ['executes_command'], allowed_actions: ['once', 'always', 'reject'],
    } })
    const wrapper = mount(ApprovalCard, { props: { message: pending, supportsActions: true, trustedPolicy: true, disabled: false } })
    expect(wrapper.text()).toContain('bash')
    expect(wrapper.text()).toContain('git status')
    expect(wrapper.text()).toContain('/repo')

    await wrapper.get('.approval-btn.once').trigger('click')
    await wrapper.get('.approval-btn.always').trigger('click')
    await wrapper.get('.approval-btn.reject').trigger('click')
    expect(wrapper.emitted('respond')?.map(args => args[1])).toEqual(['once', 'always', 'reject'])
    expect(pending.status).toBe('pending')
  })

  test('disables always when OpenCode supplied no save rules', () => {
    const wrapper = mount(ApprovalCard, {
      props: { message: message({
        always: [],
        securityContext: {
          schema_version: 1, risk_level: 'low', classification_incomplete: false,
          risk_reasons: [], allowed_actions: ['once', 'always', 'reject'],
        },
      }), supportsActions: true, trustedPolicy: true, disabled: false },
    })
    expect(wrapper.find('.approval-btn.always').exists()).toBe(false)
  })

  test('does not render persistent approval without a trusted policy context', () => {
    const legacy = mount(ApprovalCard, {
      props: { message: message(), supportsActions: true, trustedPolicy: false, disabled: false },
    })
    expect(legacy.find('.approval-btn.always').exists()).toBe(false)

    const malformed = mount(ApprovalCard, {
      props: {
        message: message({
          availableDecisions: ['accept', 'acceptForSession', 'decline'],
          securityContext: { schema_version: 1, risk_level: 'low', allowed_actions: ['always'] },
        }),
        supportsActions: false, trustedPolicy: true, disabled: false,
      },
    })
    expect(malformed.find('.approval-btn.always').exists()).toBe(false)
  })

  test('submitting and external disabled state lock every action', () => {
    const wrapper = mount(ApprovalCard, {
      props: { message: message({ submitting: true }), supportsActions: true, disabled: true },
    })
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  test('shows the readiness reason while actions are locked', () => {
    const wrapper = mount(ApprovalCard, {
      props: {
        message: message(),
        supportsActions: true,
        disabled: true,
        disabledReason: '正在同步最新状态',
      },
    })

    expect(wrapper.get('.interaction-readiness').text()).toBe('正在同步最新状态')
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  test('renders daemon-confirmed action and preserves legacy two-action UI', async () => {
    const resolved = mount(ApprovalCard, {
      props: { message: message({ status: 'resolved', action: 'always' }), supportsActions: true, disabled: false },
    })
    expect(resolved.text()).toMatch(/always|始终/i)

    const legacy = mount(ApprovalCard, {
      props: { message: message(), supportsActions: false, disabled: false },
    })
    expect(legacy.find('.approval-btn.always').exists()).toBe(false)
    expect(legacy.findAll('.approval-btn')).toHaveLength(2)
    await legacy.findAll('.approval-btn')[0].trigger('click')
    expect(legacy.emitted('respond')?.[0][1]).toBe('once')
  })

  test('renders only Codex app-server available decisions', async () => {
	const wrapper = mount(ApprovalCard, {
	  props: {
		message: message({
		  approvalKind: 'commandExecution',
		  availableDecisions: ['accept', 'cancel'],
		  always: [],
		}),
		supportsActions: false,
		disabled: false,
	  },
	})
	expect(wrapper.find('.approval-btn.once').exists()).toBe(true)
	expect(wrapper.find('.approval-btn.always').exists()).toBe(false)
	expect(wrapper.find('.approval-btn.reject').exists()).toBe(false)
	expect(wrapper.find('.approval-btn.cancel').exists()).toBe(true)
	await wrapper.get('.approval-btn.once').trigger('click')
	await wrapper.get('.approval-btn.cancel').trigger('click')
	expect(wrapper.emitted('respond')?.map(args => args[1])).toEqual(['once', 'cancel'])
  })

  test('renders only once and reject for Claude Channel explicit decisions', () => {
    const wrapper = mount(ApprovalCard, {
      props: {
        message: message({
          approvalKind: 'claude_channel', availableDecisions: ['accept', 'decline'], always: [],
        }),
        supportsActions: false,
      },
    })
    expect(wrapper.find('.approval-btn.once').exists()).toBe(true)
    expect(wrapper.find('.approval-btn.always').exists()).toBe(false)
    expect(wrapper.find('.approval-btn.reject').exists()).toBe(true)
    expect(wrapper.find('.approval-btn.cancel').exists()).toBe(false)
  })

  test.each(['timed_out', 'daemon_restarted', 'hook_disconnected', 'session_drained', 'server_shutdown', 'claude_result_unconfirmed', 'result_unknown', 'channel_disconnected', 'channel_write_failed'])(
    'renders %s as a neutral closed result',
    (reason) => {
      const wrapper = mount(ApprovalCard, {
        props: {
          message: message({ status: 'resolved', action: 'reject', reason }),
          supportsActions: false,
        },
      })
      expect(wrapper.get('.approval-result').classes()).toContain('elsewhere')
      expect(wrapper.text()).toMatch(/closed|关闭|submitted|unknown|已提交|未知/i)
      expect(wrapper.findAll('button')).toHaveLength(0)
    },
  )
})
