import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import OpenCodeQuestionCard from '../OpenCodeQuestionCard.vue'

const pending = () => ({
  type: 'question_request', request_id: 'que_1', status: 'pending',
  questions: [
    { header: 'Scope', question: 'Choose scope', options: [{ label: 'A', description: 'Only A' }, { label: 'B' }], multiple: false, custom: false },
    { header: 'Checks', question: 'Choose checks', options: [{ label: 'B' }, { label: 'C' }], multiple: true, custom: true },
  ],
})

describe('OpenCodeQuestionCard', () => {
  test('collects ordered single + multi/custom answers atomically', async () => {
    const message = pending()
    const wrapper = mount(OpenCodeQuestionCard, { props: { message, disabled: false } })
    expect(wrapper.findAll('.question-block')).toHaveLength(2)
    expect(wrapper.get('.question-submit').attributes('disabled')).toBeDefined()

    await wrapper.findAll('.question-block')[0].findAll('.question-option')[0].trigger('click')
    await wrapper.findAll('.question-block')[1].findAll('.question-option')[0].trigger('click')
    await wrapper.findAll('.question-block')[1].findAll('.question-option')[1].trigger('click')
    await wrapper.findAll('.question-custom')[0].setValue('custom')

    expect(wrapper.get('.question-submit').attributes('disabled')).toBeUndefined()
    await wrapper.get('.question-submit').trigger('click')
    expect(wrapper.emitted('submit')?.[0]).toEqual([message, [['A'], ['B', 'C', 'custom']]])
    expect(message.status).toBe('pending')
  })

  test('single choice replaces the previous option and no-custom questions have no input', async () => {
    const wrapper = mount(OpenCodeQuestionCard, { props: { message: pending(), disabled: false } })
    const first = wrapper.findAll('.question-block')[0]
    await first.findAll('.question-option')[0].trigger('click')
    await first.findAll('.question-option')[1].trigger('click')
    expect(first.findAll('.question-option')[0].classes()).not.toContain('selected')
    expect(first.findAll('.question-option')[1].classes()).toContain('selected')
    expect(first.find('.question-custom').exists()).toBe(false)
  })

  test('reject emits explicitly and submitting locks controls', async () => {
    const message = pending()
    const wrapper = mount(OpenCodeQuestionCard, { props: { message, disabled: false } })
    await wrapper.get('.question-reject').trigger('click')
    expect(wrapper.emitted('reject')?.[0]).toEqual([message])

    await wrapper.setProps({ message: { ...message, submitting: true } })
    expect(wrapper.findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
  })

  test('renders remote resolution instead of answer controls', () => {
    const wrapper = mount(OpenCodeQuestionCard, {
      props: { message: { ...pending(), status: 'resolved', rejected: true }, disabled: false },
    })
    expect(wrapper.find('.question-submit').exists()).toBe(false)
    expect(wrapper.text()).toMatch(/rejected|拒绝/i)
  })

  test('uses password input for Codex secret questions', () => {
    const wrapper = mount(OpenCodeQuestionCard, {
      props: {
        message: {
          type: 'question_request', request_id: 'codex_secret', status: 'pending',
          questions: [{ id: 'token', header: 'Token', question: 'Enter token', custom: true, secret: true }],
        },
        disabled: false,
      },
    })
    const input = wrapper.get('.question-custom')
    expect(input.attributes('type')).toBe('password')
    expect(input.attributes('autocomplete')).toBe('new-password')
  })
})
