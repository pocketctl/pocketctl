<template>
  <div class="memory-view" :class="{ 'is-mobile': isMobile }">
    <header class="memory-head">
      <div>
        <p class="overline">{{ t('memory.overline') }}</p>
        <h1>{{ t('memory.title') }}</h1>
      </div>
    </header>

    <div v-if="loading" class="empty" data-testid="memory-loading">{{ t('memory.loading') }}</div>

    <div v-else-if="!installation" class="gate" data-testid="memory-first-run">
      <div class="empty-mark">M</div>
      <h2>{{ t('memory.first_run_title') }}</h2>
      <p>{{ t('memory.first_run_copy') }}</p>
    </div>

    <template v-else-if="installation.status !== 'active' || !servicesEnabled">
      <div class="gate" data-testid="memory-service-gate">
        <div class="empty-mark">M</div>
        <h2>{{ t('memory.enable_title') }}</h2>
        <p>{{ t('memory.enable_copy') }}</p>
        <p v-if="installation.status !== 'active'" class="hint">{{ t('memory.installation_inactive') }}（{{ installation.status }}）</p>
        <button v-else type="button" data-testid="memory-enable-services" :disabled="busy"
          @click="enableServices">{{ t('memory.enable_action') }}</button>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
    </template>

    <template v-else>
      <nav class="memory-tabs" role="tablist">
        <button v-for="tab in tabs" :key="tab" type="button" :class="{ active: active === tab }"
          :data-testid="`memory-tab-${tab}`" @click="active = tab">
          {{ t(`memory.tab_${tab}`) }}
        </button>
      </nav>
      <div class="memory-stage">
        <MemorySearchPanel v-if="active === 'search'" @select-claim="selectClaim" />
        <CandidateReviewList v-if="active === 'review'" ref="reviewList"
          @changed="refreshSettings" />
        <ClaimDetailPanel v-if="active === 'claims'" :claim-id="claimId" @changed="refreshSettings" />
        <MemorySettingsCard v-if="active === 'settings'" ref="settingsCard" @changed="reload" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import {
  currentMemoryInstallation,
  discoverMemoryInstallation,
  enableMemoryServices,
} from '../services/memoryClient'
import type { MemoryInstallation } from '../types/memory'
import MemorySearchPanel from '../components/memory/MemorySearchPanel.vue'
import CandidateReviewList from '../components/memory/CandidateReviewList.vue'
import ClaimDetailPanel from '../components/memory/ClaimDetailPanel.vue'
import MemorySettingsCard from '../components/memory/MemorySettingsCard.vue'

const { t } = useLocale()
const { isMobile } = useResponsiveLayout()

const installation = ref<MemoryInstallation | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const active = ref<'search' | 'review' | 'claims' | 'settings'>('search')
const claimId = ref<string | null>(null)
const reviewList = ref<InstanceType<typeof CandidateReviewList> | null>(null)
const settingsCard = ref<InstanceType<typeof MemorySettingsCard> | null>(null)

const tabs = ['search', 'review', 'claims', 'settings'] as const

// The user must explicitly enable every memory service; the Web never
// widens grants silently, and memory.mcp stays opt-in.
const REQUIRED_SERVICES = ['memory.search', 'memory.recall', 'memory.manage']
const servicesEnabled = computed(() =>
  REQUIRED_SERVICES.every(service => installation.value?.enabled_services.includes(service)))

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    installation.value = await discoverMemoryInstallation()
  } catch (err) {
    installation.value = currentMemoryInstallation()
    error.value = err instanceof Error ? err.message : ''
  } finally {
    loading.value = false
  }
}

function reload(): void {
  void load()
}

function refreshSettings(): void {
  reviewList.value?.refresh?.()
}

function selectClaim(id: string): void {
  claimId.value = id
  active.value = 'claims'
}

async function enableServices(): Promise<void> {
  if (!installation.value) return
  busy.value = true
  error.value = ''
  try {
    installation.value = await enableMemoryServices(
      installation.value.installation_id,
      Number(installation.value.config_version),
      [...new Set([...installation.value.enabled_services, ...REQUIRED_SERVICES])],
    )
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'enable failed'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.memory-view { padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
.memory-head .overline { text-transform: uppercase; letter-spacing: 0.08em; color: #8b93a7; margin: 0; }
.gate { text-align: center; padding: 2rem 1rem; border: 1px dashed #2a2f3a; border-radius: 12px; }
.empty-mark { font-size: 2rem; font-weight: 700; color: #4a7dff; }
.memory-tabs { display: flex; gap: 0.5rem; }
.memory-tabs button { border: 1px solid #2a2f3a; background: transparent; color: inherit; padding: 0.35rem 0.9rem; border-radius: 999px; cursor: pointer; }
.memory-tabs button.active { background: #4a7dff; border-color: #4a7dff; color: #fff; }
.hint { color: #8b93a7; }
.error { color: #ff6b6b; }
button.danger { border-color: #ff6b6b; color: #ff6b6b; }
</style>
