<template>
  <section class="memory-settings-workspace" data-testid="memory-settings-card">
    <div class="memory-settings-content">
      <section class="memory-settings-section">
        <header><h3>{{ t('memory.settings_title') }}</h3><p>{{ t('memory.settings_modes_copy') }}</p></header>

        <article class="memory-setting-card">
          <span class="memory-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg></span>
          <div class="memory-setting-copy"><strong>{{ t('memory.extraction_mode') }}</strong><span>{{ t('memory.extraction_mode_copy') }}</span></div>
          <div class="memory-mode-segments" data-testid="memory-extraction-segments" role="radiogroup" :aria-label="t('memory.extraction_mode')">
            <button v-for="mode in modes" :key="mode" type="button" role="radio" :aria-checked="extractionMode === mode"
              :class="{ active: extractionMode === mode }" :disabled="busy || (mode !== 'off' && !extractionReady)" @click="extractionMode = mode">{{ mode }}</button>
          </div>
          <select v-model="extractionMode" class="memory-native-select" aria-hidden="true" tabindex="-1" :disabled="busy" data-testid="memory-extraction-mode">
            <option value="off">off</option><option value="shadow" :disabled="!extractionReady">shadow</option><option value="enabled" :disabled="!extractionReady">enabled</option>
          </select>
        </article>

        <article class="memory-setting-card">
          <span class="memory-setting-icon is-violet" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.2 3.8 4.8 3.8 8S14.5 17.8 12 20c-2.5-2.2-3.8-4.8-3.8-8S9.5 6.2 12 4z"/></svg></span>
          <div class="memory-setting-copy"><strong>{{ t('memory.embedding_mode') }}</strong><span>{{ t('memory.embedding_mode_copy') }}</span></div>
          <div class="memory-mode-segments" data-testid="memory-embedding-segments" role="radiogroup" :aria-label="t('memory.embedding_mode')">
            <button v-for="mode in modes" :key="mode" type="button" role="radio" :aria-checked="embeddingMode === mode"
              :class="{ active: embeddingMode === mode }" :disabled="busy || (mode !== 'off' && !embeddingReady)" @click="embeddingMode = mode">{{ mode }}</button>
          </div>
          <select v-model="embeddingMode" class="memory-native-select" aria-hidden="true" tabindex="-1" :disabled="busy" data-testid="memory-embedding-mode">
            <option value="off">off</option><option value="shadow" :disabled="!embeddingReady">shadow</option><option value="enabled" :disabled="!embeddingReady">enabled</option>
          </select>
        </article>

        <div v-if="!extractionReady || !embeddingReady" class="memory-notice is-warning" data-testid="memory-adapter-hint">{{ t('memory.adapter_not_configured') }}</div>
      </section>

      <section v-if="settings?.extraction_adapter || settings?.embedding_adapter" class="memory-settings-section">
        <header><h3>{{ t('memory.provider_disclosure') }}</h3><p>{{ t('memory.provider_disclosure_copy') }}</p></header>
        <div class="memory-provider-grid">
          <article v-if="extractionMode !== 'off' && settings?.extraction_adapter" class="memory-provider-card" data-testid="memory-extraction-disclosure">
            <span class="memory-provider-mark">EX</span><div><strong>Extraction</strong><span>{{ settings.extraction_adapter.provider }} · {{ settings.extraction_adapter.model }}</span><code>{{ settings.extraction_adapter.origin }}</code><small>{{ t(settings.extraction_adapter.pricing_configured ? 'memory.cost_estimate_configured' : 'memory.cost_estimate_unconfigured') }}</small></div>
          </article>
          <article v-if="embeddingMode !== 'off' && settings?.embedding_adapter" class="memory-provider-card" data-testid="memory-embedding-disclosure">
            <span class="memory-provider-mark is-violet">EM</span><div><strong>Embedding</strong><span>{{ settings.embedding_adapter.provider }} · {{ settings.embedding_adapter.model }}</span><code>{{ settings.embedding_adapter.origin }}</code><small>{{ t(settings.embedding_adapter.pricing_configured ? 'memory.cost_estimate_configured' : 'memory.cost_estimate_unconfigured') }}</small></div>
          </article>
        </div>
      </section>

      <section class="memory-settings-section">
        <header><h3>{{ t('memory.service_access') }}</h3><p>{{ t('memory.service_access_copy') }}</p></header>
        <div class="memory-service-list">
          <div v-for="service in requiredServices" :key="service"><span><code>{{ service }}</code><small>{{ t(`memory.service_${service.split('.')[1]}_copy`) }}</small></span><strong :class="{ enabled: services.includes(service) }">{{ services.includes(service) ? t('memory.enabled') : t('memory.disabled') }}</strong></div>
          <div><span><code>memory.mcp</code><small>{{ t('memory.service_mcp_copy') }}</small></span><strong :class="{ enabled: services.includes('memory.mcp') }">{{ services.includes('memory.mcp') ? t('memory.enabled') : t('memory.optional') }}</strong></div>
        </div>
      </section>

      <div v-if="hasChanges && !needsConfirmation" class="memory-settings-savebar" data-testid="memory-mode-actions">
        <span>{{ t('memory.unsaved_changes') }}</span><button type="button" class="memory-button" @click="revert">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-primary" data-testid="memory-mode-save" @click="save">{{ t('common.save') }}</button>
      </div>
      <p v-if="error" class="memory-notice is-error" data-testid="memory-settings-error">{{ error }}</p>
    </div>

    <div v-if="needsConfirmation" class="memory-modal-backdrop" data-testid="memory-mode-confirm" @click.self="revert">
      <section class="memory-modal" role="dialog" aria-modal="true" aria-labelledby="memory-consent-title">
        <header><span class="memory-modal-icon"><svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 16h.01"/></svg></span><div><h3 id="memory-consent-title">{{ t('memory.confirm_provider_processing') }}</h3><p>{{ t('memory.provider_boundary_copy') }}</p></div></header>
        <div class="memory-modal-body">
          <p v-if="needsExtractionConfirmation" data-testid="memory-extraction-confirm-copy">{{ t('memory.extraction_confirm_copy') }}</p>
          <p v-if="needsEmbeddingConfirmation" data-testid="memory-embedding-confirm-copy">{{ t('memory.embedding_confirm_copy') }}</p>
          <p>{{ t('memory.provider_retention_copy') }}</p>
          <dl class="memory-disclosure-list"><div><dt>{{ t('memory.installation_status') }}</dt><dd>{{ installationStatus }}</dd></div><div><dt>{{ t('memory.cost') }}</dt><dd data-testid="memory-confirm-cost">{{ t(confirmationPricingConfigured ? 'memory.cost_estimate_configured' : 'memory.cost_estimate_unconfigured') }}</dd></div></dl>
        </div>
        <footer><button type="button" class="memory-button" @click="revert">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-primary" data-testid="memory-mode-confirm-yes" @click="save">{{ t('common.confirm') }}</button></footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { getMemorySettings, patchMemorySettings } from '../../services/memoryClient'
import type { MemoryFeatureSettings } from '../../types/memory'

const props = withDefaults(defineProps<{ services?: string[]; installationStatus?: string }>(), { services: () => [], installationStatus: 'active' })
const { t } = useLocale()
const emit = defineEmits<{ (e: 'changed'): void }>()
const modes = ['off', 'shadow', 'enabled'] as const
const requiredServices = ['memory.search', 'memory.recall', 'memory.manage', 'memory.context']

const settings = ref<MemoryFeatureSettings | null>(null)
const extractionMode = ref<'off' | 'shadow' | 'enabled'>('off')
const embeddingMode = ref<'off' | 'shadow' | 'enabled'>('off')
const busy = ref(false)
const error = ref('')

const extractionReady = computed(() => settings.value?.extraction_ready ?? false)
const embeddingReady = computed(() => settings.value?.embedding_ready ?? false)
const needsExtractionConfirmation = computed(() => extractionMode.value !== 'off' && ((settings.value?.extraction_mode ?? 'off') === 'off' || (settings.value?.extraction_consent_required ?? false)))
const needsEmbeddingConfirmation = computed(() => embeddingMode.value !== 'off' && ((settings.value?.embedding_mode ?? 'off') === 'off' || (settings.value?.embedding_consent_required ?? false)))
const needsConfirmation = computed(() => needsExtractionConfirmation.value || needsEmbeddingConfirmation.value)
const confirmationPricingConfigured = computed(() => {
  const adapters = [
    ...(needsExtractionConfirmation.value && settings.value?.extraction_adapter ? [settings.value.extraction_adapter] : []),
    ...(needsEmbeddingConfirmation.value && settings.value?.embedding_adapter ? [settings.value.embedding_adapter] : []),
  ]
  return adapters.length > 0 && adapters.every(adapter => adapter.pricing_configured)
})
const hasChanges = computed(() => Boolean(settings.value) && (extractionMode.value !== settings.value!.extraction_mode || embeddingMode.value !== settings.value!.embedding_mode))

onMounted(load)

async function load(): Promise<void> {
  try {
    settings.value = await getMemorySettings()
    extractionMode.value = settings.value.extraction_mode
    embeddingMode.value = settings.value.embedding_mode
  } catch (err) { error.value = err instanceof Error ? err.message : 'load failed' }
}

function revert(): void {
  extractionMode.value = settings.value?.extraction_mode ?? 'off'
  embeddingMode.value = settings.value?.embedding_mode ?? 'off'
}

async function save(): Promise<void> {
  if (!settings.value) return
  busy.value = true
  error.value = ''
  try {
    settings.value = await patchMemorySettings(
      settings.value.revision,
      {
        ...(extractionMode.value !== settings.value.extraction_mode ? { extraction_mode: extractionMode.value } : {}),
        ...(embeddingMode.value !== settings.value.embedding_mode ? { embedding_mode: embeddingMode.value } : {}),
        ...(needsExtractionConfirmation.value && settings.value.extraction_adapter ? { confirm_extraction_fingerprint: settings.value.extraction_adapter.fingerprint } : {}),
        ...(needsEmbeddingConfirmation.value && settings.value.embedding_adapter ? { confirm_embedding_fingerprint: settings.value.embedding_adapter.fingerprint } : {}),
      },
      `web-settings-${Date.now()}`,
    )
    extractionMode.value = settings.value.extraction_mode
    embeddingMode.value = settings.value.embedding_mode
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'save failed'
    await load()
  } finally { busy.value = false }
}
</script>
