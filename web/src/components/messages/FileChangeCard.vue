<template>
  <article :class="['file-change-card', { expanded }]">
    <button
      ref="trigger"
      type="button"
      class="file-change-trigger"
      data-testid="file-change-trigger"
      :aria-expanded="isMobile ? undefined : expanded"
      :aria-haspopup="isMobile ? 'dialog' : undefined"
      :aria-controls="ariaControls"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="file-change-icon" aria-hidden="true">▤</span>
      <span class="file-change-title">{{ title }}</span>
      <span class="file-change-stats">
        <span class="add" :aria-label="t('session.file_change_additions', { n: message.fileChange.additions })">+{{ message.fileChange.additions }}</span>
        <span class="del" :aria-label="t('session.file_change_deletions', { n: message.fileChange.deletions })">-{{ message.fileChange.deletions }}</span>
      </span>
      <svg :class="['file-change-chevron', { expanded }]" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
    </button>
    <FileChangeDetail v-if="expanded && !isMobile" :id="detailId" :message="message" />
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useResponsiveLayout } from '../../composables/useResponsiveLayout'
import type { AgentFileChangeMessage } from '../../utils/agentFileChange'
import FileChangeDetail from './FileChangeDetail.vue'

const props = defineProps<{ message: AgentFileChangeMessage }>()
const emit = defineEmits<{ (event: 'open-mobile', opener: HTMLElement): void }>()
const { t } = useLocale()
const { isMobile } = useResponsiveLayout()
const expanded = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const detailId = computed(() => `file-change-detail-${props.message.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)
const ariaControls = computed(() => isMobile.value ? 'file-change-mobile-sheet' : detailId.value)
const title = computed(() => t(
  props.message.fileChange.files.length === 1 ? 'session.file_change_edited_file' : 'session.file_change_edited_files',
  { n: props.message.fileChange.files.length },
))

function toggle() {
  if (isMobile.value) {
    if (trigger.value) emit('open-mobile', trigger.value)
    return
  }
  expanded.value = !expanded.value
}
</script>

<style scoped>
.file-change-card { width: 100%; min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.file-change-card.expanded { height: min(74vh, 760px); min-height: 420px; display: flex; flex-direction: column; border-color: var(--border-light); box-shadow: 0 16px 42px rgba(0, 0, 0, .18); }
.file-change-trigger { width: 100%; min-height: 44px; display: flex; align-items: center; gap: 9px; padding: 8px 11px; border: 0; color: var(--fg-secondary); background: transparent; text-align: left; }
.file-change-card.expanded .file-change-trigger { flex: 0 0 auto; border-bottom: 1px solid var(--border); }
.file-change-card.expanded :deep(.file-change-detail) { min-height: 0; flex: 1; }
.file-change-trigger:hover { background: var(--surface-hover); }
.file-change-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.file-change-icon { width: 24px; height: 24px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 7px; color: var(--accent); background: var(--accent-muted); font-family: var(--font-mono); font-weight: 700; }
.file-change-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 12px; font-weight: 600; }
.file-change-stats { display: flex; gap: 7px; margin-left: auto; font: 11px/1 var(--font-mono); }
.add { color: var(--success); }
.del { color: var(--danger); }
.file-change-chevron { width: 13px; height: 13px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.8; transition: transform 160ms ease; }
.file-change-chevron.expanded { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .file-change-chevron { transition: none; } }
@media (max-width: 768px) { .file-change-card.expanded { height: auto; min-height: 0; display: block; box-shadow: none; } }
</style>
