import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, expect, test } from 'vitest'
import ActionSelect from '../ActionSelect.vue'
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.replaceChildren() })
function fixture() {
  const value = ref<number | undefined>(undefined), disabled = ref(false), name = ref('Five'), changes = ref(0)
  const component = defineComponent({ components: { ActionSelect }, setup: () => ({ value, disabled, name, changes }), template: `<ActionSelect><select v-model="value" :disabled="disabled" aria-label="Typed setting" @change="changes++"><option :value="undefined">Default</option><optgroup label="Levels"><option :value="5">{{ name }}</option><option :value="9" disabled>Unavailable</option><option :value="12">Twelve</option></optgroup></select></ActionSelect>` })
  const wrapper = mount(component, { attachTo: document.body }); wrappers.push(wrapper)
  return { wrapper, value, disabled, name, changes }
}
test('option list retains typed model values and existing change handlers', async () => {
  const { wrapper, value, changes } = fixture()
  await wrapper.get('.action-select-trigger').trigger('click'); await flushPromises()
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click(); await flushPromises()
  expect(value.value).toBe(5); expect(changes.value).toBe(1)
  await wrapper.get('.action-select-trigger').trigger('click'); await flushPromises()
  document.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]!.click(); await flushPromises()
  expect(value.value).toBeUndefined(); expect(changes.value).toBe(2)
})
test('keyboard traversal skips unavailable options and Escape restores focus', async () => {
  const { wrapper } = fixture()
  await wrapper.get('.action-select-trigger').trigger('keydown', { key: 'ArrowDown' }); await flushPromises()
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await flushPromises()
  expect(document.activeElement?.textContent).toBe('Five')
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await flushPromises()
  expect(document.activeElement?.textContent).toBe('Twelve')
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises()
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(document.activeElement).toBe(wrapper.get('.action-select-trigger').element)
})
test('translated labels and externally updated values stay synchronized', async () => {
  const { wrapper, value, name } = fixture(); value.value = 5; await flushPromises()
  expect(wrapper.get('.action-select-trigger').text()).toContain('Five')
  name.value = '五'; await flushPromises()
  expect(wrapper.get('.action-select-trigger').text()).toContain('五'); expect(value.value).toBe(5)
})
test('disabled controls cannot open and hidden native input is not a tab stop', async () => {
  const { wrapper, disabled } = fixture(); disabled.value = true; await flushPromises()
  expect(wrapper.get('.action-select-trigger').attributes('disabled')).toBeDefined()
  expect(wrapper.get('select').attributes('tabindex')).toBe('-1')
  await wrapper.get('.action-select-trigger').trigger('click'); await flushPromises()
  expect(document.querySelector('[role="listbox"]')).toBeNull()
})
