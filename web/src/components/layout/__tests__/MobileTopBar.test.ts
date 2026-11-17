import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useLocale } from '../../../composables/useLocale'
import MobileTopBar from '../MobileTopBar.vue'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ path: '/sessions', query: {} }),
}))

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

function mountBar(props: Partial<InstanceType<typeof MobileTopBar>['$props']> = {}) {
  return mount(MobileTopBar, {
    props: {
      title: 'Migration plan',
      connected: true,
      reconnecting: false,
      isSession: true,
      showNewSession: false,
      ...props,
    },
  })
}

describe('mobile top bar back navigation', () => {
  beforeEach(() => {
    push.mockClear()
  })

  test('returns to the host session list with the host query preserved', async () => {
    const wrapper = mountBar({ sessionHostId: 'daemon-1' })

    await wrapper.get('.mobile-topbar-back').trigger('click')

    expect(push).toHaveBeenCalledWith({ path: '/sessions', query: { host: 'daemon-1' } })
  })

  test('falls back to the plain session list when the host id is unknown', async () => {
    const wrapper = mountBar()

    await wrapper.get('.mobile-topbar-back').trigger('click')

    expect(push).toHaveBeenCalledWith('/sessions')
  })
})

test('session header keeps English loading-more text and omits GitHub while other pages retain it', () => {
  useLocale().locale.value='en'
  const wrapper=mountBar({sessionStatus:'running',sessionStatusLabel:'Loading more…'})
  expect(wrapper.get('.mobile-connection').classes()).toContain('loading-more')
  expect(wrapper.get('.mobile-connection').text()).toBe('Loading more…')
  expect(wrapper.findComponent({name:'TopbarGithubLink'}).exists()).toBe(false)
  wrapper.unmount()
  const other=mountBar({isSession:false})
  expect(other.findComponent({name:'TopbarGithubLink'}).exists()).toBe(true)
  other.unmount()
  useLocale().locale.value='zh'
})

test.each([320, 390, 768])('loading text remains visible with application mobile CSS at %i px', width => {
  useLocale().locale.value = 'en'
  const wrapper = mountBar({sessionStatus: 'running', sessionStatusLabel: 'Loading more…'})
  const rendering = new Window({width, height: 844})
  const styles = rendering.document.createElement('style')
  const [shared, overrides, component] = ['../../../assets/web-shared.css', '../../../assets/reference-overrides.css', '../MobileTopBar.vue'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
  styles.textContent = [shared, overrides, component.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ''].join('\n').replace(/@media\(/g, '@media (')
  rendering.document.head.append(styles)
  rendering.document.body.innerHTML = `<div class="design-shell">${wrapper.html()}</div>`
  const status = rendering.document.querySelector('.mobile-connection')!
  const label = status.lastElementChild!
  expect(rendering.getComputedStyle(status).display).not.toBe('none')
  expect(rendering.getComputedStyle(label).display).not.toBe('none')
  expect(parseFloat(rendering.getComputedStyle(label).fontSize)).toBeGreaterThanOrEqual(11)
  wrapper.unmount()
  rendering.close()
  useLocale().locale.value = 'zh'
})
