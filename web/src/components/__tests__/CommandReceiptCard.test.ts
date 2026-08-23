import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CommandReceiptCard from '../CommandReceiptCard.vue'

describe('CommandReceiptCard', () => {
  test('renders command + success icon (SVG check-circle)', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/context', status: 'success', message: '## Context Usage' },
    })
    expect(w.text()).toContain('/context')
    expect(w.text()).toContain('## Context Usage')
    // success → receipt-success class + SVG icon present
    expect(w.find('.receipt-card.receipt-success').exists()).toBe(true)
    expect(w.find('svg.receipt-icon').exists()).toBe(true)
  })

  test('failed status shows error styling + x-circle icon', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/compact', status: 'failed', message: 'Not enough messages' },
    })
    expect(w.text()).toContain('/compact')
    expect(w.find('.receipt-card.receipt-failed').exists()).toBe(true)
    expect(w.find('svg.receipt-icon').exists()).toBe(true)
  })

  test('unavailable status shows muted styling + minus-circle icon', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/model', status: 'unavailable', message: "isn't available" },
    })
    expect(w.text()).toContain('/model')
    expect(w.find('.receipt-card.receipt-unavailable').exists()).toBe(true)
    expect(w.find('svg.receipt-icon').exists()).toBe(true)
  })

  test('omits message element when no message', () => {
    const w = mount(CommandReceiptCard, {
      props: { command: '/clear', status: 'success' },
    })
    expect(w.text()).toContain('/clear')
    expect(w.find('.receipt-msg').exists()).toBe(false)
  })
})
