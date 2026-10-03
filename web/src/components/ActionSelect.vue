<template>
  <span ref="root" class="action-select" :class="{ 'is-disabled': disabled }" v-show="hasSelect">
    <span class="action-select-native"><slot /></span>
    <button ref="trigger" type="button" class="action-select-trigger" :disabled="disabled" :aria-label="accessibleLabel" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="menuId" @click="toggle" @keydown="onTriggerKey">
      <span>{{ selectedLabel }}</span><WorkspaceIcon name="down" />
    </button>
    <Teleport to="body">
      <section v-if="open" :id="menuId" ref="menu" class="action-select-content" role="listbox" :aria-label="accessibleLabel" :style="position" @keydown="onMenuKey">
        <template v-for="(item, index) in items" :key="index">
          <div v-if="item.group && (index === 0 || items[index - 1]?.group !== item.group)" class="action-select-group">{{ item.group }}</div>
          <button type="button" role="option" :aria-selected="item.selected" :disabled="item.disabled" :tabindex="index === focused ? 0 : -1" :data-option-index="index" @click="choose(index)">
            <span>{{ item.label }}</span><WorkspaceIcon v-if="item.selected" name="check" />
          </button>
        </template>
      </section>
    </Teleport>
  </span>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useId } from 'vue'
import '../assets/action-select.css'
import WorkspaceIcon from './WorkspaceIcon.vue'
// Keep the original select and its Vue v-model handler as the source of truth.
// This preserves numbers, undefined values, object options and all existing change handlers.
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), menu = ref<HTMLElement>()
const menuId = `action-select-${useId()}`
const open = ref(false), disabled = ref(false), hasSelect = ref(false), label = ref(''), focused = ref(0)
type Item = { label: string; group: string; selected: boolean; disabled: boolean }
const items = ref<Item[]>([]), position = ref<Record<string, string>>({})
const selectedLabel = computed(() => items.value.filter(item => item.selected).map(item => item.label).join(', '))
const accessibleLabel = computed(() => label.value || selectedLabel.value)
let select: HTMLSelectElement | null = null, observer: MutationObserver | undefined, signature = '', search = '', searchTimer: ReturnType<typeof setTimeout> | undefined
function sync() {
  const current = root.value?.querySelector('select') || null
  hasSelect.value = !!current
  if (select !== current) { select?.removeEventListener('change', sync); select = current; select?.addEventListener('change', sync) }
  if (!select) { close(false); return }
  if (select.tabIndex !== -1) select.tabIndex = -1
  if (select.getAttribute('aria-hidden') !== 'true') select.setAttribute('aria-hidden', 'true')
  disabled.value = select.disabled
  label.value = select.getAttribute('aria-label') || (select.id ? Array.from(document.querySelectorAll('label')).find(item => item.htmlFor === select!.id)?.textContent?.trim() : '') || ''
  const next = Array.from(select.options).map(option => ({ label: option.textContent?.trim() || '', group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '', selected: option.selected, disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) }))
  const key = JSON.stringify(next)
  if (key !== signature) { signature = key; items.value = next }
  if (disabled.value || !next.length) close(false)
}
function place() {
  const box = trigger.value?.getBoundingClientRect()
  if (!box) return
  const width = Math.min(Math.max(box.width, 240), window.innerWidth - 24), below = window.innerHeight - box.bottom - 16, above = box.top - 16, height = Math.min(360, Math.max(below, above), window.innerHeight - 32)
  const down = below >= Math.min(240, above)
  position.value = { position: 'fixed', width: `${width}px`, left: `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`, maxHeight: `${Math.max(80, height)}px`, ...(down ? { top: `${box.bottom + 6}px` } : { bottom: `${window.innerHeight - box.top + 6}px` }) }
}
async function focusOption(index: number) {
  focused.value = index
  await nextTick()
  menu.value?.querySelector<HTMLButtonElement>(`[data-option-index="${index}"]`)?.focus()
}
async function show(last = false) {
  sync(); if (disabled.value || !items.value.length) return
  open.value = true; place()
  let index = items.value.findIndex(item => item.selected && !item.disabled)
  if (last) index = items.value.map((item, i) => item.disabled ? -1 : i).filter(i => i >= 0).at(-1) ?? -1
  if (index < 0) index = items.value.findIndex(item => !item.disabled)
  if (index >= 0) await focusOption(index)
}
function close(restore = true) { if (!open.value) return; open.value = false; if (restore) trigger.value?.focus() }
function toggle() { if (open.value) close(); else void show() }
function choose(index: number) {
  if (!select || disabled.value || items.value[index]?.disabled) return
  select.selectedIndex = index
  select.dispatchEvent(new Event('change', { bubbles: true }))
  sync(); close()
}
function onTriggerKey(event: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); void show(event.key === 'ArrowUp') }
}
function onMenuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key === 'Tab') { close(); return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const available = items.value.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0)
    if (!available.length) return
    const current = available.indexOf(focused.value), offset = event.key === 'ArrowUp' ? -1 : 1
    void focusOption(event.key === 'Home' ? available[0]! : event.key === 'End' ? available.at(-1)! : available[(current + offset + available.length) % available.length]!)
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    search += event.key.toLowerCase(); clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = '' }, 600)
    const index = items.value.findIndex(item => !item.disabled && item.label.toLowerCase().startsWith(search))
    if (index >= 0) void focusOption(index)
  }
}
function outside(event: Event) { if (!root.value?.contains(event.target as Node) && !menu.value?.contains(event.target as Node)) close(false) }
function scroll(event: Event) { if (open.value && !menu.value?.contains(event.target as Node)) place() }
onMounted(() => { sync(); observer = new MutationObserver(sync); observer.observe(root.value!, { childList: true, subtree: true, characterData: true, attributes: true }); document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', place); window.addEventListener('scroll', scroll, true) })
onUpdated(sync)
onBeforeUnmount(() => { observer?.disconnect(); select?.removeEventListener('change', sync); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true); clearTimeout(searchTimer) })
</script>

