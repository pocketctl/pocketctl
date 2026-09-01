<template>
  <section class="memory-wiki-editor" data-testid="memory-wiki-editor">
    <header>
      <div><strong>{{ sectionKey }}</strong><small>CAS {{ lockVersion }}</small></div>
      <span class="memory-phase4-badge" :data-status="locked ? 'locked' : 'manual'">
        {{ locked ? t('memory.phase4.locked') : t('memory.phase4.manual') }}
      </span>
    </header>
    <textarea v-model="draft" rows="8" :disabled="!canEdit || locked"
      :aria-label="t('memory.phase4.manual_markdown')"></textarea>
    <footer v-if="canEdit">
      <button v-if="!locked" type="button" class="memory-button" data-testid="memory-wiki-editor-save"
        :disabled="draft.trim().length === 0 || draft === markdown" @click="emit('save', draft)">
        {{ t('memory.phase4.save_manual') }}
      </button>
      <button v-if="locked" type="button" class="memory-button" data-testid="memory-wiki-editor-unlock"
        @click="emit('unlock')">{{ t('memory.phase4.unlock') }}</button>
      <button v-else type="button" class="memory-button" data-testid="memory-wiki-editor-lock"
        @click="emit('lock')">{{ t('memory.phase4.lock') }}</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{
  sectionKey: string
  markdown: string
  lockVersion: number
  locked: boolean
  canEdit: boolean
}>()
const emit = defineEmits<{ save: [markdown: string]; lock: []; unlock: [] }>()
const { t } = useLocale()
const draft = ref(props.markdown)
watch(() => props.markdown, value => { draft.value = value })
</script>
