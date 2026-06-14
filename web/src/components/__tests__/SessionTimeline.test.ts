import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionTimeline from '../SessionTimeline.vue'

const milestones = [
  { status: 'running', time: '2026-06-07T10:00:00Z' },
  { status: 'idle', time: '2026-06-07T10:05:00Z' },
  { status: 'exited', time: '2026-06-07T10:10:00Z' },
]

describe('SessionTimeline', () => {
  test('renders milestones in order', () => {
    const wrapper = mount(SessionTimeline, { props: { milestones } })
    const items = wrapper.findAll('.milestone')
    expect(items.length).toBe(3)
  })

  test('last milestone is active', () => {
    const wrapper = mount(SessionTimeline, { props: { milestones } })
    const items = wrapper.findAll('.milestone')
    expect(items[0].classes()).not.toContain('active')
    expect(items[2].classes()).toContain('active')
  })

  test('previous milestones are passed', () => {
    const wrapper = mount(SessionTimeline, { props: { milestones } })
    const items = wrapper.findAll('.milestone')
    expect(items[0].classes()).toContain('passed')
    expect(items[1].classes()).toContain('passed')
  })

  test('does not render when milestones empty', () => {
    const wrapper = mount(SessionTimeline, { props: { milestones: [] } })
    expect(wrapper.find('.session-timeline').exists()).toBe(false)
  })

  test('displays status labels', () => {
    const wrapper = mount(SessionTimeline, { props: { milestones } })
    const html = wrapper.html()
    expect(html).toContain('Running')
    expect(html).toContain('Idle')
    expect(html).toContain('Exited')
  })
})
