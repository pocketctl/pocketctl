<template>
  <section class="memory-phase4-workspace memory-codegraph-workspace" data-testid="memory-codegraph-panel">
    <MemoryScopeSwitcher v-if="scopes.length" :model-value="installationId" :scopes="scopes"
      data-testid="memory-codegraph-scopes" @update:model-value="emit('update:installationId',$event)" />
    <p v-if="scopeUnavailable" class="memory-notice is-error" role="alert">{{ t('memory.phase4.scope_unavailable_copy') }}</p>
    <header class="memory-phase4-commandbar">
      <label class="memory-phase4-repository-field">
        <span>{{ t('memory.codegraph.repository') }}</span>
        <select :value="repositoryId" :disabled="scopeUnavailable" data-testid="memory-codegraph-catalog" @change="selectRepository">
          <option value="">{{ t('memory.codegraph.choose_repository') }}</option>
          <option v-if="repositoryId && !repositories.some(r=>r.repository_id===repositoryId)" :value="repositoryId">{{ repositoryId }}</option>
          <option v-for="repo in repositories" :key="repo.repository_id" :value="repo.repository_id">{{ repo.repository_key }} · {{ t('memory.codegraph.state.'+repo.state) }}</option>
        </select>
      </label>
      <button type="button" class="memory-button" :disabled="loading || catalogLoading || scopeUnavailable"
        data-testid="memory-codegraph-retry" @click="refresh">{{ t('memory.phase4.refresh') }}</button>
      <button v-if="catalogCursor" class="memory-button" :disabled="catalogLoading" @click="loadRepositories(catalogCursor)">{{ t('memory.phase4.load_more') }}</button>
    </header>
    <p v-if="catalogError" class="memory-notice is-error" role="alert" data-testid="memory-codegraph-catalog-error">{{ catalogError }}</p>
    <p v-else-if="catalogLoading" role="status">{{ t('memory.phase4.loading') }}</p>
    <div v-if="selectedRepository" class="memory-provenance-spine" data-testid="memory-codegraph-source">
      <span class="memory-provenance-dot" aria-hidden="true"></span>
      <div><small>{{ t('memory.codegraph.latest_snapshot') }} · {{ t('memory.codegraph.state.'+selectedRepository.state) }}</small><code>{{ selectedRepository.commit_sha }}</code></div>
      <span>{{ selectedRepository.file_count }} {{ t('memory.codegraph.files') }}</span>
      <span v-if="selectedRepository.selection?.partial" class="memory-phase4-badge" data-status="partial">partial</span>
    </div>
    <p v-if="selectedRepository && selectedRepository.state!=='active'" class="memory-notice" role="status">{{ t('memory.codegraph.status_hint') }}</p>
    <details v-if="!scopeUnavailable" class="memory-codegraph-setup" :open="!repositoryId">
      <summary>{{ t('memory.codegraph.sync_title') }}</summary>
      <p>{{ t('memory.codegraph.sync_copy') }}</p>
      <pre data-testid="memory-codegraph-command">{{ syncCommand }} --dry-run
{{ syncCommand }}</pre>
      <p>{{ t('memory.codegraph.sync_options') }}</p>
      <p>{{ t('memory.codegraph.gates') }}</p>
      <button v-if="canEnableUpload && !uploadEnabled" type="button" class="memory-button"
        :disabled="enablingUpload" data-testid="memory-codegraph-enable" @click="emit('enableUpload')">{{ t('memory.codegraph.enable_upload') }}</button>
      <p v-if="uploadError" class="memory-notice is-error" role="alert">{{ uploadError }}</p>
      <label class="memory-phase4-repository-field">
        <span>{{ t('memory.phase4.repository_id') }} · {{ t('memory.codegraph.manual_id') }}</span>
        <input v-model="repositoryDraft" data-testid="memory-codegraph-repository"
          :placeholder="t('memory.phase4.repository_placeholder')" :disabled="scopeUnavailable"
          @change="commitRepository" @keyup.enter="commitRepository" />
      </label>
    </details>

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

    <MemoryFeatureIntro v-if="!loading && !graph?.nodes.length" feature="codegraph" />

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
      <MemoryImpactPanel :repository-id="repositoryId" :installation-id="installationId" :legacy-grant="legacyGrant" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { getMemoryCodeGraph, listMemoryCodeRepositories, type MemoryGraphScopeContext } from '../../services/memoryClient'
import type { MemoryCodeGraphEdge, MemoryCodeGraphNode, MemoryCodeGraphPage, MemoryCodeRepository, MemoryGovernanceScope } from '../../types/memory'
import MemoryScopeSwitcher from './MemoryScopeSwitcher.vue'
import MemoryFeatureIntro from './MemoryFeatureIntro.vue'
import MemoryImpactPanel from './MemoryImpactPanel.vue'

const props = withDefaults(defineProps<{repositoryId:string;installationId?:string;scopes?:MemoryGovernanceScope[];legacyGrant?:boolean;
 canEnableUpload?:boolean;uploadEnabled?:boolean;enablingUpload?:boolean;uploadError?:string}>(),{installationId:'',scopes:()=>[],legacyGrant:true})
const emit = defineEmits<{ 'update:repositoryId': [value:string];'update:installationId':[value:string];enableUpload:[] }>()
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

const repositories = ref<MemoryCodeRepository[]>([])
const catalogLoading = ref(false), catalogError = ref(''), catalogCursor = ref<string|null>(null)
const scopeUnavailable = computed(()=>props.scopes.length>0 ? !props.scopes.some(s=>s.installation_id===props.installationId) : Boolean(props.installationId && !props.legacyGrant))
const selectedRepository = computed(()=>repositories.value.find(r=>r.repository_id===props.repositoryId))
const syncCommand = computed(()=>`pocketctl memory sync-repo --repo <repository-path>${props.installationId && !props.scopes.some(s=>s.installation_id===props.installationId && s.owner_scope_kind==='personal') ? ' --scope-installation-id '+props.installationId : ''}`)
let graphEpoch=0,catalogEpoch=0
let graphController:AbortController|undefined,catalogController:AbortController|undefined
function context(signal:AbortSignal):MemoryGraphScopeContext|undefined {
 return props.installationId ? {installationId:props.installationId,legacyGrant:props.legacyGrant,signal} : undefined
}
function clearGraph():void {
 graphEpoch++;graphController?.abort();graph.value=null;selectedNode.value=null;loaded.value=false;error.value='';loading.value=false
}
watch(()=>[props.installationId,props.legacyGrant,scopeUnavailable.value,props.repositoryId] as const,(_,old)=>{
 clearGraph();catalogEpoch++;catalogController?.abort();repositories.value=[];catalogCursor.value=null;catalogError.value='';catalogLoading.value=false
 if(old && old[0]!==props.installationId && old[3]===props.repositoryId) emit('update:repositoryId','')
 if(props.installationId && !scopeUnavailable.value) void loadRepositories()
},{immediate:true})
watch(()=>[props.repositoryId,props.installationId,scopeUnavailable.value] as const,()=>{
 repositoryDraft.value=props.repositoryId;clearGraph()
 if(props.repositoryId && !scopeUnavailable.value) void loadGraph(null)
},{immediate:true})
onBeforeUnmount(()=>{clearGraph();catalogEpoch++;catalogController?.abort()})
function selectRepository(event:Event):void { emit('update:repositoryId',(event.target as HTMLSelectElement).value) }
function commitRepository():void {
 const value=repositoryDraft.value.trim()
 if(value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {error.value=t('memory.codegraph.invalid_id');return}
 if(value===props.repositoryId) {if(value) void loadGraph(null)} else emit('update:repositoryId',value)
}
function requestError(cause:unknown):string {
 const status=cause && typeof cause==='object' && 'status' in cause ? Number(cause.status) : 0
 return status===503 ? t('memory.codegraph.disabled') : status===403 ? t('memory.codegraph.forbidden')
  : status===404 ? t('memory.codegraph.not_ready') : cause instanceof Error ? cause.message : t('memory.phase4.request_failed')
}
async function loadRepositories(after?:string|null):Promise<void> {
 if(!props.installationId || scopeUnavailable.value)return
 const epoch=++catalogEpoch;catalogController?.abort();catalogController=new AbortController();const scope=context(catalogController.signal)
 catalogLoading.value=true;catalogError.value=''
 try {
  const page=await listMemoryCodeRepositories(scope,after)
  if(epoch!==catalogEpoch)return
  repositories.value=after ? [...new Map([...repositories.value,...page.repositories].map(r=>[r.repository_id,r])).values()] : page.repositories
  catalogCursor.value=page.next_cursor
  if(props.repositoryId && !after && !repositories.value.some(r=>r.repository_id===props.repositoryId)) {
   const exact=await listMemoryCodeRepositories(scope,null,props.repositoryId)
   if(epoch!==catalogEpoch)return
   repositories.value.push(...exact.repositories)
  }
 }catch(cause){if(epoch===catalogEpoch){catalogError.value=requestError(cause);clearGraph();repositories.value=[]}}
 finally{if(epoch===catalogEpoch)catalogLoading.value=false}
}
function refresh():void {void loadRepositories();if(props.repositoryId)void loadGraph(null)}
async function loadGraph(cursor:string|null):Promise<void> {
 if(!props.repositoryId || scopeUnavailable.value)return
 const epoch=++graphEpoch;graphController?.abort();graphController=new AbortController()
 loading.value=true;error.value=''
 try {
  const page=await getMemoryCodeGraph(props.repositoryId,cursor,50,context(graphController.signal))
  if(epoch!==graphEpoch)return
  if(cursor && graph.value && graph.value.graph_version_id!==page.graph_version_id) {void loadGraph(null);return}
  graph.value=cursor && graph.value ? {...page,nodes:[...new Map([...graph.value.nodes,...page.nodes].map(n=>[n.node_id,n])).values()],edges:mergeEdges(graph.value.edges,page.edges)} : page
  if(!cursor)selectedNode.value=null
  loaded.value=true
 }catch(cause){if(epoch===graphEpoch){graph.value=null;selectedNode.value=null;error.value=requestError(cause);loaded.value=true}}
 finally{if(epoch===graphEpoch)loading.value=false}
}

function mergeEdges(existing: MemoryCodeGraphEdge[], next: MemoryCodeGraphEdge[]): MemoryCodeGraphEdge[] {
  return [...new Map([...existing, ...next].map(edge => [edge.edge_id, edge])).values()]
}

function oppositeKey(edge: MemoryCodeGraphEdge): string {
  return edge.from_stable_key === selectedNode.value?.stable_key ? edge.to_stable_key : edge.from_stable_key
}
</script>

<style scoped>
.memory-codegraph-setup { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 12px 0; }
.memory-codegraph-setup summary { cursor: pointer; font-weight: 600; }
.memory-codegraph-setup p { color: var(--fg-secondary); line-height: 1.6; }
.memory-codegraph-setup pre { overflow-x: auto; padding: 12px; border-radius: 8px; background: var(--bg-secondary); font-size: 12px; }
.memory-phase4-repository-field select { width: 100%; max-width: 100%; min-width: 0; height: 37px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--surface); font-size: 12px; }
:deep(.memory-scope-chip-personal) { color: var(--fg); }
</style>
