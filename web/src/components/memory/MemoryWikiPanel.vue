<template>
  <section class="memory-phase4-workspace memory-wiki-workspace" data-testid="memory-wiki-panel">
    <header class="memory-phase4-commandbar">
      <label class="memory-phase4-repository-field">
        <span>{{ t('memory.phase4.repository_id') }}</span>
        <input v-model="repositoryDraft" data-testid="memory-wiki-repository"
          :placeholder="t('memory.phase4.repository_placeholder')"
          @change="commitRepository" @keyup.enter="commitRepository" />
      </label>
      <button type="button" class="memory-button" :disabled="loading || !repositoryDraft.trim()"
        data-testid="memory-wiki-retry" @click="commitRepository">
        {{ loading ? t('memory.phase4.loading') : t('memory.phase4.refresh') }}
      </button>
      <button v-if="wiki && canContribute" type="button" class="memory-button"
        data-testid="memory-wiki-build" :disabled="mutating" @click="scheduleBuild">
        {{ t('memory.phase4.build_candidate') }}
      </button>
    </header>

    <div v-if="loading && !wiki" class="memory-phase4-state" data-testid="memory-wiki-loading">
      <span class="memory-spinner" aria-hidden="true"></span>{{ t('memory.phase4.wiki_loading') }}
    </div>
    <div v-else-if="error" class="memory-phase4-state is-error" role="alert" data-testid="memory-wiki-error">
      <strong>{{ t('memory.phase4.wiki_failed') }}</strong><p>{{ error }}</p>
    </div>
    <div v-else-if="loaded && !wiki" class="memory-phase4-state" data-testid="memory-wiki-empty">
      <strong>{{ t('memory.phase4.wiki_empty') }}</strong><p>{{ t('memory.phase4.wiki_empty_copy') }}</p>
    </div>

    <template v-if="wiki">
      <div class="memory-provenance-spine" data-testid="memory-wiki-provenance">
        <span class="memory-provenance-dot" aria-hidden="true"></span>
        <div><small>{{ t('memory.phase4.active_wiki') }}</small><code>{{ wiki.commit_sha }}</code></div>
        <span v-if="wiki.stale" class="memory-phase4-badge" data-status="stale"
          data-testid="memory-wiki-stale">{{ t('memory.phase4.stale') }}</span>
        <span class="memory-phase4-badge" :data-status="wiki.coverage">{{ wiki.coverage }}</span>
        <code>r{{ wiki.revision }}</code>
      </div>

      <div class="memory-wiki-layout">
        <nav class="memory-wiki-page-index" :aria-label="t('memory.phase4.wiki_pages')">
          <a v-for="page in wiki.pages" :key="page.page_id" :href="`#memory-wiki-page-${page.page_id}`">
            <span>{{ page.title }}</span><small>{{ page.sections.length }}</small>
          </a>
          <section v-if="builds.length" class="memory-wiki-build-list">
            <strong>{{ t('memory.phase4.build_history') }}</strong>
            <template v-for="build in builds" :key="build.run_id">
              <button v-if="build.state === 'candidate'" type="button"
                :data-testid="`memory-wiki-open-candidate-${build.run_id}`" @click="openCandidate(build.run_id)">
                <span>g{{ build.generation }}</span><code>{{ build.state }}</code>
              </button>
              <div v-else class="memory-wiki-build-status" :data-status="build.state">
                <span>g{{ build.generation }}</span><code>{{ build.state }}</code>
                <small v-if="build.error_code">{{ build.error_code }}</small>
              </div>
            </template>
            <button v-if="nextBuildCursor" type="button" class="memory-wiki-build-more"
              :disabled="loadingBuilds" @click="loadMoreBuilds">{{ t('memory.phase4.load_more_builds') }}</button>
          </section>
        </nav>

        <main class="memory-wiki-document">
          <article v-for="page in wiki.pages" :id="`memory-wiki-page-${page.page_id}`" :key="page.page_id"
            class="memory-wiki-page">
            <header><p class="memory-phase4-kicker">{{ page.page_key }}</p><h2>{{ page.title }}</h2></header>
            <section v-for="section in page.sections" :key="section.section_id"
              class="memory-wiki-section" :class="{ 'is-stale': section.stale }"
              :data-testid="`memory-wiki-section-${section.section_key}`">
              <header>
                <div><h3>{{ section.heading }}</h3><code>{{ section.section_key }}</code></div>
                <div class="memory-phase4-status-line">
                  <span class="memory-phase4-badge" :data-status="section.authority">{{ section.authority }}</span>
                  <span class="memory-phase4-badge" :data-status="section.coverage">{{ section.coverage }}</span>
                </div>
              </header>
              <p v-if="section.stale" class="memory-wiki-stale-note">
                {{ t('memory.phase4.stale_section') }} · {{ section.stale_reason }}
              </p>
              <MemoryWikiEditor v-if="section.authority !== 'generated'"
                :section-key="section.section_key" :markdown="section.markdown"
                :lock-version="section.lock_version ?? 0" :locked="section.locked ?? section.authority === 'locked'"
                :can-edit="canContribute" @save="saveSection(section, $event)"
                @lock="changeLock(section, 'lock')" @unlock="changeLock(section, 'unlock')" />
              <MarkdownRenderer v-else :content="section.markdown" />
              <ul v-if="section.citations.length" class="memory-wiki-citations">
                <li v-for="citation in section.citations" :key="citation.source_token"
                  :data-testid="`memory-wiki-citation-${citation.source_token}`">
                  <span class="memory-provenance-dot" aria-hidden="true"></span>
                  <code>{{ citation.path || citation.stable_key || citation.source_kind }}</code>
                  <span>{{ citation.commit_sha }}</span><small>{{ citation.source_token }}</small>
                </li>
              </ul>
            </section>
          </article>
        </main>
      </div>

      <MemoryWikiCandidateView v-if="candidate" :active-sections="activeSections"
        :candidate="candidate" :can-publish="canPublish" @publish="publishCandidate" />
      <p v-if="mutationError" class="memory-notice is-error" role="alert">{{ mutationError }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  editMemoryWikiSection, getMemoryWiki, getMemoryWikiCandidate, listMemoryWikiBuilds,
  publishMemoryWikiCandidate, scheduleMemoryWikiBuild, setMemoryWikiSectionLock,
} from '../../services/memoryClient'
import type { MemoryActiveWiki, MemoryWikiBuild, MemoryWikiCandidate, MemoryWikiSection } from '../../types/memory'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import MemoryWikiCandidateView from './MemoryWikiCandidate.vue'
import MemoryWikiEditor from './MemoryWikiEditor.vue'

const props = defineProps<{ repositoryId: string; canContribute: boolean; canPublish: boolean }>()
const emit = defineEmits<{ 'update:repositoryId': [value: string] }>()
const { t } = useLocale()
const wiki = ref<MemoryActiveWiki | null>(null)
const repositoryDraft = ref(props.repositoryId)
const builds = ref<MemoryWikiBuild[]>([])
const nextBuildCursor = ref<string | null>(null)
const candidate = ref<MemoryWikiCandidate | null>(null)
const candidateBuildId = ref('')
const loading = ref(false)
const loaded = ref(false)
const mutating = ref(false)
const loadingBuilds = ref(false)
const error = ref('')
const mutationError = ref('')
const activeSections = computed(() => wiki.value?.pages.flatMap(page => page.sections) ?? [])

watch(() => props.repositoryId, repositoryId => {
  repositoryDraft.value = repositoryId
  wiki.value = null
  builds.value = []
  nextBuildCursor.value = null
  candidate.value = null
  loaded.value = false
  error.value = ''
  if (repositoryId) void loadWiki()
}, { immediate: true })

function commitRepository(): void {
  const value = repositoryDraft.value.trim()
  repositoryDraft.value = value
  if (value === props.repositoryId) {
    if (value) void loadWiki()
    return
  }
  emit('update:repositoryId', value)
}

async function loadWiki(): Promise<void> {
  if (!props.repositoryId) return
  loading.value = true
  error.value = ''
  try {
    wiki.value = await getMemoryWiki(props.repositoryId)
    if (wiki.value) {
      const page = await listMemoryWikiBuilds(wiki.value.wiki_id)
      builds.value = page.builds
      nextBuildCursor.value = page.next_cursor
    } else {
      builds.value = []
      nextBuildCursor.value = null
    }
    loaded.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('memory.phase4.request_failed')
    loaded.value = true
  } finally {
    loading.value = false
  }
}

async function loadMoreBuilds(): Promise<void> {
  if (!wiki.value || !nextBuildCursor.value) return
  loadingBuilds.value = true
  mutationError.value = ''
  try {
    const page = await listMemoryWikiBuilds(wiki.value.wiki_id, nextBuildCursor.value)
    builds.value.push(...page.builds)
    nextBuildCursor.value = page.next_cursor
  } catch (cause) {
    mutationError.value = message(cause)
  } finally {
    loadingBuilds.value = false
  }
}

async function openCandidate(buildId: string): Promise<void> {
  if (!wiki.value) return
  mutationError.value = ''
  try {
    candidate.value = await getMemoryWikiCandidate(wiki.value.wiki_id, buildId)
    candidateBuildId.value = buildId
  } catch (cause) {
    mutationError.value = message(cause)
  }
}

async function scheduleBuild(): Promise<void> {
  if (!wiki.value || !props.canContribute) return
  await mutate(async () => {
    await scheduleMemoryWikiBuild(wiki.value!.wiki_id, wiki.value!.generation)
    await loadWiki()
  })
}

async function publishCandidate(): Promise<void> {
  if (!wiki.value || !candidate.value || !candidateBuildId.value || !props.canPublish) return
  await mutate(async () => {
    await publishMemoryWikiCandidate(
      wiki.value!.wiki_id, candidateBuildId.value, Number(candidate.value!.generation), wiki.value!.revision,
    )
    candidate.value = null
    candidateBuildId.value = ''
    await loadWiki()
  })
}

async function saveSection(section: MemoryWikiSection, markdown: string): Promise<void> {
  if (!wiki.value) return
  await mutate(async () => {
    await editMemoryWikiSection(wiki.value!.wiki_id, section.section_key, markdown, section.lock_version ?? 0)
    await loadWiki()
  })
}

async function changeLock(section: MemoryWikiSection, action: 'lock' | 'unlock'): Promise<void> {
  if (!wiki.value) return
  await mutate(async () => {
    await setMemoryWikiSectionLock(wiki.value!.wiki_id, section.section_key, action, section.lock_version ?? 0)
    await loadWiki()
  })
}

async function mutate(operation: () => Promise<void>): Promise<void> {
  mutating.value = true
  mutationError.value = ''
  try { await operation() } catch (cause) { mutationError.value = message(cause) } finally { mutating.value = false }
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : t('memory.phase4.request_failed')
}
</script>
