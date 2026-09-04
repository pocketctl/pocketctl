<template>
  <section class="memory-phase4-workspace memory-codegraph-workspace" data-testid="memory-codegraph-panel">
    <header class="memory-phase4-commandbar">
      <label class="memory-phase4-repository-field">
        <span>{{ t('memory.phase4.repository_id') }}</span>
        <input v-model="repositoryDraft" data-testid="memory-codegraph-repository"
          :placeholder="t('memory.phase4.repository_placeholder')"
          @change="commitRepository" @keyup.enter="commitRepository" />
      </label>
      <button type="button" class="memory-button" :disabled="loading || !repositoryDraft.trim()"
        data-testid="memory-codegraph-retry" @click="commitRepository">
        {{ loading ? t('memory.phase4.loading') : t('memory.phase4.refresh') }}
      </button>
    </header>

    <div v-if="loading && !graph" class="memory-phase4-state" data-testid="memory-codegraph-loading">
      <span class="memory-spinner" aria-hidden="true"></span>{{ t('memory.phase4.graph_loading') }}
    </div>
    <div v-else-if="error" class="memory-phase4-state is-error" role="alert" data-testid="memory-codegraph-error">
      <strong>{{ t('memory.phase4.graph_failed') }}</strong><p>{{ error }}</p>
    </div>
    <div v-else-if="loaded && graph && graph.nodes.length === 0" class="memory-phase4-state"
      data-testid="memory-codegraph-empty">
      <strong>{{ t('memory.phase4.graph_empty') }}</strong><p>{{ t('memory.phase4.graph_empty_copy') }}</p>
    </div>

    <template v-if="graph && graph.nodes.length">
      <div class="memory-provenance-spine" data-testid="memory-codegraph-provenance">
        <span class="memory-provenance-dot" aria-hidden="true"></span>
        <div><small>{{ t('memory.phase4.active_graph') }}</small><code>{{ graph.commit_sha }}</code></div>
        <span class="memory-phase4-badge" :data-status="graph.coverage"
          data-testid="memory-codegraph-coverage">{{ graph.coverage }}</span>
        <code>{{ graph.parser_version }}</code>
      </div>

      <div class="memory-codegraph-grid">
        <section class="memory-codegraph-nodes">
          <header><h3>{{ t('memory.phase4.graph_nodes') }}</h3><span>{{ graph.nodes.length }}</span></header>
          <ol>
            <li v-for="node in graph.nodes" :key="node.node_id">
              <button type="button" :class="{ selected: selectedNode?.node_id === node.node_id }"
                :data-testid="`memory-codegraph-node-${node.node_id}`" @click="selectedNode = node">
                <span class="memory-codegraph-node-kind">{{ node.kind }}</span>
                <strong>{{ node.name }}</strong>
                <code>{{ node.path || node.stable_key }}</code>
              </button>
            </li>
          </ol>
          <button v-if="graph.next_cursor" type="button" class="memory-button memory-codegraph-more"
            :disabled="loading" data-testid="memory-codegraph-more" @click="loadGraph(graph.next_cursor)">
            {{ t('memory.phase4.load_more') }}
          </button>
        </section>

        <aside class="memory-codegraph-relations" data-testid="memory-codegraph-relations">
          <header><h3>{{ t('memory.phase4.relationships') }}</h3></header>
          <div v-if="!selectedNode" class="memory-phase4-inline-empty">{{ t('memory.phase4.select_node') }}</div>
          <template v-else>
            <div class="memory-codegraph-selection">
              <strong>{{ selectedNode.name }}</strong><code>{{ selectedNode.stable_key }}</code>
            </div>
            <ul v-if="selectedEdges.length">
              <li v-for="edge in selectedEdges" :key="edge.edge_id">
                <span>{{ edge.kind }}</span>
                <code>{{ oppositeKey(edge) }}</code>
                <small :data-status="edge.resolution">{{ edge.resolution }}</small>
              </li>
            </ul>
            <div v-else class="memory-phase4-inline-empty">{{ t('memory.phase4.no_relationships') }}</div>
          </template>
        </aside>
      </div>
      <MemoryImpactPanel :repository-id="repositoryId" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { getMemoryCodeGraph } from '../../services/memoryClient'
import type { MemoryCodeGraphEdge, MemoryCodeGraphNode, MemoryCodeGraphPage } from '../../types/memory'
import MemoryImpactPanel from './MemoryImpactPanel.vue'

const props = defineProps<{ repositoryId: string }>()
const emit = defineEmits<{ 'update:repositoryId': [value: string] }>()
const { t } = useLocale()
const graph = ref<MemoryCodeGraphPage | null>(null)
const repositoryDraft = ref(props.repositoryId)
const selectedNode = ref<MemoryCodeGraphNode | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const selectedEdges = computed(() => selectedNode.value && graph.value
  ? graph.value.edges.filter(edge => edge.from_stable_key === selectedNode.value?.stable_key
    || edge.to_stable_key === selectedNode.value?.stable_key)
  : [])

watch(() => props.repositoryId, repositoryId => {
  repositoryDraft.value = repositoryId
  graph.value = null
  selectedNode.value = null
  loaded.value = false
  error.value = ''
  if (repositoryId) void loadGraph(null)
}, { immediate: true })

function commitRepository(): void {
  const value = repositoryDraft.value.trim()
  repositoryDraft.value = value
  if (value === props.repositoryId) {
    if (value) void loadGraph(null)
    return
  }
  emit('update:repositoryId', value)
}

async function loadGraph(cursor: string | null): Promise<void> {
  if (!props.repositoryId) return
  loading.value = true
  error.value = ''
  try {
    const page = await getMemoryCodeGraph(props.repositoryId, cursor)
    if (cursor && graph.value) {
      graph.value = { ...page, nodes: [...graph.value.nodes, ...page.nodes], edges: mergeEdges(graph.value.edges, page.edges) }
    } else {
      graph.value = page
      selectedNode.value = null
    }
    loaded.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.phase4.request_failed')
    loaded.value = true
  } finally {
    loading.value = false
  }
}

function mergeEdges(existing: MemoryCodeGraphEdge[], next: MemoryCodeGraphEdge[]): MemoryCodeGraphEdge[] {
  return [...new Map([...existing, ...next].map(edge => [edge.edge_id, edge])).values()]
}

function oppositeKey(edge: MemoryCodeGraphEdge): string {
  return edge.from_stable_key === selectedNode.value?.stable_key ? edge.to_stable_key : edge.from_stable_key
}
</script>
