import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TopbarGithubLink from '../TopbarGithubLink.vue'

describe('TopbarGithubLink', () => {
  it('opens the pocketctl GitHub project safely with the landing icon', () => {
    const wrapper = mount(TopbarGithubLink)
    const link = wrapper.get('a')

    expect(link.attributes('href')).toBe('https://github.com/pocketctl/pocketctl')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.attributes('aria-label')).toBe('GitHub')
    expect(link.classes()).toContain('theme-toggle')
    expect(link.get('svg').attributes('viewBox')).toBe('0 0 24 24')
    expect(link.findAll('path')).toHaveLength(2)
  })
})
