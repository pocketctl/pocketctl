<template>
  <section class="memory-wiki-candidate" data-testid="memory-wiki-candidate">
    <header>
      <div>
        <p class="memory-phase4-kicker">{{ t('memory.phase4.candidate_kicker') }}</p>
        <h3>{{ t('memory.phase4.candidate_title') }}</h3>
      </div>
      <div class="memory-phase4-status-line">
        <span class="memory-phase4-badge" data-status="candidate">generation {{ candidate.generation }}</span>
        <code>{{ candidate.commit_sha.slice(0, 12) }}</code>
      </div>
    </header>
    <div class="memory-wiki-diff">
      <article v-for="section in candidateSections" :key="section.section_key">
        <header><strong>{{ section.heading }}</strong><code>{{ section.section_key }}</code></header>
        <div class="memory-wiki-diff-columns">
          <section>
            <small>{{ t('memory.phase4.active_version') }}</small>
            <pre>{{ activeMarkdown(section.section_key) || t('memory.phase4.new_section') }}</pre>
          </section>
          <section>
            <small>{{ t('memory.phase4.candidate_version') }}</small>
            <pre>{{ section.markdown }}</pre>
          </section>
        </div>
        <footer><span class="memory-phase4-badge" :data-status="section.coverage">{{ section.coverage }}</span>
          <code v-for="token in section.source_tokens" :key="token">{{ token }}</code></footer>
      </article>
    </div>
    <footer v-if="canPublish" class="memory-wiki-candidate-actions">
      <button type="button" class="memory-button is-primary" data-testid="memory-wiki-publish-request"
        @click="confirming = true">{{ t('memory.phase4.publish_candidate') }}</button>
    </footer>
    <div v-if="confirming" class="memory-wiki-confirm" role="alertdialog" aria-modal="true"
      data-testid="memory-wiki-publish-confirmation">
      <strong>{{ t('memory.phase4.publish_confirm_title') }}</strong>
      <p>{{ t('memory.phase4.publish_confirm_copy') }}</p>
      <div>
        <button type="button" class="memory-button" @click="confirming = false">{{ t('common.cancel') }}</button>
        <button type="button" class="memory-button is-primary" data-testid="memory-wiki-publish-confirm"
          @click="confirmPublish">{{ t('memory.phase4.publish_confirm') }}</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemoryWikiCandidate, MemoryWikiSection } from '../../types/memory'

const props = defineProps<{
  activeSections: MemoryWikiSection[]
  candidate: MemoryWikiCandidate
  canPublish: boolean
}>()
const emit = defineEmits<{ publish: [] }>()
const { t } = useLocale()
const confirming = ref(false)
const candidateSections = computed(() => props.candidate.document.pages.flatMap(page => page.sections))
function activeMarkdown(sectionKey: string): string {
  return props.activeSections.find(section => section.section_key === sectionKey)?.markdown ?? ''
}
function confirmPublish(): void {
  confirming.value = false
  emit('publish')
}
</script>
