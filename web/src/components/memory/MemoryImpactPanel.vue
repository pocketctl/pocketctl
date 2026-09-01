<template>
  <section class="memory-impact-panel" data-testid="memory-impact-panel">
    <header>
      <div>
        <p class="memory-phase4-kicker">{{ t('memory.phase4.impact_kicker') }}</p>
        <h3>{{ t('memory.phase4.impact_title') }}</h3>
      </div>
      <button type="button" class="memory-button is-primary" data-testid="memory-impact-run"
        :disabled="loading || !repositoryId || paths.length === 0" @click="run">
        {{ loading ? t('memory.phase4.running') : t('memory.phase4.impact_run') }}
      </button>
    </header>
    <label class="memory-phase4-field">
      <span>{{ t('memory.phase4.impact_paths') }}</span>
      <textarea v-model="rawPaths" rows="3" data-testid="memory-impact-paths"
        :placeholder="t('memory.phase4.impact_paths_hint')"></textarea>
    </label>
    <p v-if="error" class="memory-notice is-error" role="alert" data-testid="memory-impact-error">{{ error }}</p>
    <article v-else-if="result" class="memory-impact-result" data-testid="memory-impact-result">
      <div class="memory-phase4-status-line">
        <span class="memory-phase4-badge" :data-status="result.coverage">{{ result.coverage }}</span>
        <code>{{ shortCommit(result.commit_sha) }}</code>
        <span>{{ result.edgeCount }} {{ t('memory.phase4.edges') }}</span>
      </div>
      <ul v-if="result.reasons.length" class="memory-impact-reasons">
        <li v-for="reason in result.reasons" :key="reason">{{ reason }}</li>
      </ul>
      <ol class="memory-impact-path-list">
        <li v-for="path in result.paths" :key="path"><code>{{ path }}</code></li>
      </ol>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { analyzeMemoryChangeImpact } from '../../services/memoryClient'
import type { MemoryChangeImpact } from '../../types/memory'

const props = defineProps<{ repositoryId: string }>()
const { t } = useLocale()
const rawPaths = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<MemoryChangeImpact | null>(null)
const paths = computed(() => [...new Set(rawPaths.value.split(/[\n,]/).map(path => path.trim()).filter(Boolean))].slice(0, 20))

async function run(): Promise<void> {
  if (!props.repositoryId || paths.value.length === 0) return
  loading.value = true
  error.value = ''
  try {
    result.value = await analyzeMemoryChangeImpact(props.repositoryId, {
      entry_paths: paths.value, depth: 3, max_nodes: 500, max_edges: 2000,
    })
  } catch (cause) {
    result.value = null
    error.value = cause instanceof Error ? cause.message : t('memory.phase4.request_failed')
  } finally {
    loading.value = false
  }
}

function shortCommit(value: string): string { return value.slice(0, 12) }
</script>
