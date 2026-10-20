<template>
  <ActionList :title="title" :width="640" :anchor="returnFocusTo" :close-label="t('session.file_change_close')" @close="emit('close')">
    <section id="file-change-mobile-sheet" class="file-change-bottom-sheet" data-testid="file-change-sheet">
      <p class="file-change-sheet-stats"><span class="add">+{{ message.fileChange.additions }}</span> <span class="del">−{{ message.fileChange.deletions }}</span></p>
      <div class="file-change-sheet-content"><FileChangeDetail :message="message" /></div>
    </section>
  </ActionList>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { AgentFileChangeMessage } from '../../utils/agentFileChange'
import FileChangeDetail from './FileChangeDetail.vue'
import ActionList from '../ActionList.vue'
const props = defineProps<{ message: AgentFileChangeMessage; returnFocusTo?: HTMLElement | null }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useLocale()
const title = computed(() => t('session.file_change_edited_files', { n: props.message.fileChange.files.length }))
</script>

<style scoped>
.file-change-bottom-sheet { height: min(65dvh, 600px); min-height: 200px; display: flex; flex-direction: column; overflow: hidden; }
.file-change-sheet-stats { margin: 0 0 8px; font: 11px/1.4 var(--font-mono); }
.add { color: var(--success); }
.del { color: var(--danger); }
.file-change-sheet-content { min-height: 0; flex: 1; overflow: hidden; }
</style>
