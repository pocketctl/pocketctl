<template>
  <button type="button" class="session-fullscreen-toggle" :aria-pressed="modelValue" :aria-label="label" @click="emit('update:modelValue', !modelValue)">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="modelValue" d="M9 3v6H3m12-6v6h6M3 15h6v6m6 0v-6h6"/><path v-else d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6"/></svg>
  </button>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useLocale } from '../../composables/useLocale'
const props = defineProps<{ modelValue: boolean; escapeBlocked?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const { t } = useLocale()
const label = computed(() => t(props.modelValue ? 'session.fullscreen_exit' : 'session.fullscreen_enter'))
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.modelValue && !props.escapeBlocked && !event.defaultPrevented && !document.querySelector('dialog[open], [role=dialog], .modal-overlay')) {
    emit('update:modelValue', false)
    event.preventDefault()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true))
</script>
<style scoped>
.session-fullscreen-toggle { display: inline-grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--fg-secondary); cursor: pointer; }
.session-fullscreen-toggle:hover, .session-fullscreen-toggle[aria-pressed="true"] { color: var(--accent); background: var(--surface-hover); }
.session-fullscreen-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.session-fullscreen-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
@media(max-width:768px) { .session-fullscreen-toggle { width: 36px; height: 36px; } }
</style>
