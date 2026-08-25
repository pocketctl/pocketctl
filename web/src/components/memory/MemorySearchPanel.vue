<template>
  <section class="memory-panel" data-testid="memory-search-panel">
    <form class="search-row" @submit.prevent="runSearch">
      <input v-model="query" type="search" :placeholder="t('memory.search_placeholder')"
        data-testid="memory-search-input" :disabled="loading" />
      <button type="submit" :disabled="loading || query.trim().length === 0" data-testid="memory-search-submit">
        {{ t('memory.search') }}
      </button>
    </form>
    <p v-if="degraded" class="degraded" data-testid="memory-search-degraded">{{ t('memory.degraded_embedding') }}</p>
    <p v-else-if="error" class="error" data-testid="memory-search-error">{{ error }}</p>
    <p v-else-if="!loading && searched && hits.length === 0" class="empty" data-testid="memory-search-empty">
      {{ t('memory.no_results') }}
    </p>
    <ul v-if="hits.length" class="hit-list" data-testid="memory-search-hits">
      <li v-for="hit in hits" :key="hit.versionId">
        <button type="button" class="hit" :data-testid="`memory-hit-${hit.claimId}`" @click="$emit('select-claim', hit.claimId)">
          <span class="type">{{ hit.claimType }}</span>
          <span class="statement">{{ hit.statement }}</span>
          <span class="meta" :data-testid="`memory-hit-scope-${hit.claimId}`">
            {{ hit.scopeKind }} · {{ hit.scopeKey }}<template v-if="hit.branch"> · {{ hit.branch }}</template>
          </span>
          <span class="meta">{{ hit.freshnessAt ?? '' }} · {{ hit.authority }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  MemoryClientError,
  searchMemory,
} from '../../services/memoryClient'
import type { MemorySearchHit } from '../../types/memory'

const { t } = useLocale()
const emit = defineEmits<{ (e: 'select-claim', claimId: string): void }>()

const query = ref('')
const hits = ref<MemorySearchHit[]>([])
const loading = ref(false)
const searched = ref(false)
const error = ref('')
const degraded = ref(false)
let controller: AbortController | undefined

async function runSearch(): Promise<void> {
  const text = query.value.trim()
  if (!text) return
  controller?.abort()
  const requestController = new AbortController()
  controller = requestController
  loading.value = true
  error.value = ''
  degraded.value = false
  try {
    const result = await searchMemory(text, {}, requestController.signal)
    if (controller !== requestController) return
    hits.value = result.hits
    degraded.value = result.degradedComponents.includes('embedding')
  } catch (err) {
    if (controller !== requestController) return
    if (err instanceof MemoryClientError && err.code === 'superseded') return
    error.value = err instanceof Error ? err.message : t('memory.search_failed')
    hits.value = []
  } finally {
    if (controller !== requestController) return
    loading.value = false
    searched.value = true
  }
}
</script>
