import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CommandReceiptCard from '../CommandReceiptCard.vue'

describe('CommandReceiptCard', () => {
  test('renders command + success icon', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/context', status: 'success', message: '## Context Usage' },
    })
    expect(w.text()).toContain('/context')
    expect(w.text()).toContain('✓')
    expect(w.classes()).toContain('receipt-success')
  })

  test('failed status shows ✗', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/compact', status: 'failed', message: 'Not enough messages' },
    })
    expect(w.text()).toContain('✗')
    expect(w.classes()).toContain('receipt-failed')
  })

  test('unavailable status shows ⊘', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/model', status: 'unavailable', message: "isn't available" },
    })
    expect(w.text()).toContain('⊘')
    expect(w.classes()).toContain('receipt-unavailable')
  })

  test('omits message element when no message', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/clear', status: 'success' },
    })
    expect(w.text()).toContain('/clear')
    expect(w.find('.receipt-msg').exists()).toBe(false)
  })
})
