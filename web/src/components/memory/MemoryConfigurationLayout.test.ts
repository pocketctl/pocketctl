import { afterEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MemoryContextSettings from './MemoryContextSettings.vue'
import MemoryPersonaPanel from './MemoryPersonaPanel.vue'
import MemoryPolicyEditor from './MemoryPolicyEditor.vue'
import MemoryLoadoutEditor from './MemoryLoadoutEditor.vue'
import ContextPackList from './ContextPackList.vue'

vi.mock('../../services/memoryClient', () => ({
  listContextSettings: async () => ({ settings: [] }),
  listMemoryClaims: async () => ({ claims: [] }),
  getContextLoadout: async () => ({ revision: 1, items: [] }),
}))

const css = readFileSync(resolve(process.cwd(), 'src/components/memory/memory-workbench.css'), 'utf8')
afterEach(() => { document.head.querySelector('[data-memory-configuration-test]')?.remove(); document.body.replaceChildren() })

test.each([
  ['context', MemoryContextSettings], ['persona', MemoryPersonaPanel],
  ['policy', MemoryPolicyEditor], ['loadout', MemoryLoadoutEditor], ['packs', ContextPackList],
] as const)('%s configuration uses the Memory surface and styled controls', async (_name, component) => {
  const style = document.createElement('style')
  style.dataset.memoryConfigurationTest = ''
  style.textContent = css + readFileSync(resolve(process.cwd(), 'src/assets/action-select.css'), 'utf8')
  document.head.append(style)
  const host = document.createElement('div')
  host.className = 'memory-workbench memory-layout-v2'
  document.body.append(host)
  const wrapper = mount(component, { attachTo: host })
  await flushPromises()
  try {
    const surface = getComputedStyle(wrapper.element)
    expect(surface.borderRadius).toBe('9px')
    expect(Number.parseFloat(surface.paddingTop)).toBeGreaterThanOrEqual(16)
    for (const button of wrapper.findAll('button')) {
      const computed = getComputedStyle(button.element)
      expect(computed.display).toBe('inline-flex')
      expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(32)
    }
    for (const field of wrapper.findAll('input, select, textarea')) {
      const computed = getComputedStyle(field.element)
      expect(computed.minWidth).toBe('0')
      expect(computed.borderRadius).toBe('6px')
    }
  } finally { wrapper.unmount() }
})
