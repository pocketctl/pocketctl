import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))

test('keeps the sync child mounted and preserves its pending work while switching project and operations sections', async () => {
  const Workspace = (await import('./MemoryGitWorkspace.vue')).default
  let mounts = 0
  const Sync = defineComponent({ props: { section: String }, setup(props) { mounts++; const draft = ref('original request'); return () => h('div', { 'data-testid': 'sync-child' }, [h('input', { value: draft.value, onInput: (e: Event) => { draft.value = (e.target as HTMLInputElement).value } }), h('span', props.section)]) } })
  const w = mount(Workspace, { attachTo: document.body, slots: { projects: '<div data-testid="projects">Project access</div>', sync: ({ section }: { section: string }) => h(Sync, { section }) } })
  await w.get('input').setValue('pending original key')
  await w.get('[data-section-id="projects"]').trigger('click')
  expect(w.get('[data-testid="projects"]').isVisible()).toBe(true)
  expect(w.get('[data-testid="sync-child"]').isVisible()).toBe(false)
  await w.get('[data-section-id="operations"]').trigger('click')
  expect(w.get('[data-testid="sync-child"]').isVisible()).toBe(true)
  expect(w.get('[data-testid="sync-child"]').text()).toContain('operations')
  expect(w.get('input').element).toHaveProperty('value', 'pending original key')
  expect(mounts).toBe(1)
  await w.get('[data-section-id="sync"]').trigger('click')
  expect(w.get('[data-testid="sync-child"]').text()).toContain('sync')
  w.unmount()
})
