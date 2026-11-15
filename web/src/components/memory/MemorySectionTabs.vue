<script setup lang="ts">
import { nextTick, ref } from 'vue'

export interface MemorySectionItem { id: string; label: string; disabled?: boolean; badge?: number | string }
const props = defineProps<{ modelValue: string; items: readonly MemorySectionItem[]; label: string; panelPrefix?: string }>()
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()
const navigation = ref<HTMLElement>()

function select(item: MemorySectionItem): void {
  if (!item.disabled) emit('update:modelValue', item.id)
}
async function keydown(event: KeyboardEvent): Promise<void> {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const enabled = props.items.filter(item => !item.disabled)
  if (!enabled.length) return
  event.preventDefault()
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-section-id]')
  const current = enabled.findIndex(item => item.id === (target?.dataset.sectionId || props.modelValue))
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
    : (Math.max(current, 0) + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length
  const item = enabled[index]!
  select(item)
  await nextTick()
  Array.from(navigation.value?.querySelectorAll<HTMLButtonElement>('[role=tab]') || [])
    .find(button => button.dataset.sectionId === item.id)?.focus()
}
</script>

<template>
  <nav ref="navigation" class="memory-section-tabs" role="tablist" :aria-label="label" @keydown="keydown">
    <button v-for="item in items" :key="item.id" type="button" role="tab"
      :data-section-id="item.id" :aria-selected="modelValue === item.id"
      :aria-controls="panelPrefix ? `${panelPrefix}-${item.id}` : undefined"
      :tabindex="!item.disabled && (modelValue === item.id || !items.some(option => option.id === modelValue && !option.disabled) && item.id === items.find(option => !option.disabled)?.id) ? 0 : -1"
      :disabled="item.disabled" @click="select(item)">
      {{ item.label }}<span v-if="item.badge !== undefined" class="memory-section-tab-count">{{ item.badge }}</span>
    </button>
  </nav>
</template>

<style scoped>
.memory-section-tabs{display:flex;align-items:center;gap:22px;overflow:auto;border-bottom:1px solid var(--line,var(--border));margin-bottom:22px;scrollbar-width:thin}
.memory-section-tabs>button{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:46px;padding:10px 0 12px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted,var(--fg-secondary));font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
.memory-section-tabs>button[aria-selected=true]{border-bottom-color:var(--brand,var(--accent));color:var(--brand,var(--accent));font-weight:550}
.memory-section-tabs>button:disabled{opacity:.45;cursor:not-allowed}.memory-section-tabs>button:focus-visible{outline:2px solid var(--brand,var(--accent));outline-offset:-2px;border-radius:3px}
.memory-section-tab-count{padding:1px 6px;border-radius:4px;background:var(--soft,var(--bg-secondary));color:var(--muted,var(--fg-secondary));font-size:10px;font-weight:400}
@media(max-width:760px){.memory-section-tabs{gap:20px;margin-bottom:18px}.memory-section-tabs>button{min-height:48px}}
</style>
